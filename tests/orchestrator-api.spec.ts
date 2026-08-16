import { describe, it, expect, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryHttpApi } from '../src/api/memory-http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * P2 integration surface for dsh-ultra: the orchestrator-facing HTTP face
 * (shared working set + subagent fiber staging/merge) plus the P1 cost and
 * markdown endpoints, exercised through the real MemoryService.
 */

function fakeReq(method: string, body?: unknown): IncomingMessage {
  const req = new Readable({ read() {} }) as IncomingMessage;
  req.method = method;
  req.url = '/';
  if (body !== undefined) req.push(typeof body === 'string' ? body : JSON.stringify(body));
  req.push(null);
  return req;
}

function fakeRes(): ServerResponse & { captured: { status: number; body: string } } {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(chunk?: unknown) {
      captured.body = String(chunk ?? '');
    }
  } as unknown as ServerResponse & { captured: { status: number; body: string } };
  res.captured = captured;
  return res;
}

async function boot() {
  const ctx = new Context();
  const fiber = apply(ctx, {
    ...DEFAULT_CONFIG,
    storage: { workspaceDbPath: ':memory:' }
  } as never);
  await fiber;
  const service = ctx.get('memory') as any;
  const api = new MemoryHttpApi(service.store, service.retriever, service);
  return { ctx, service, api, fiber };
}

describe('dsh-ultra orchestrator + cost + markdown HTTP surface', () => {
  let h: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    h = await boot();
  });

  it('GET /working-set returns a shared, cacheable prefix payload', async () => {
    await h.service.remember({
      tier: 'semantic', category: 'rule', entity_key: 'repo.test_cmd',
      content: 'Run pnpm test, not npm test', summary: 'pnpm test', importance: 5, status: 'verified'
    });

    const res = fakeRes();
    await h.api.handle(fakeReq('GET'), res, '/working-set?filePath=src/a.ts&branch=main');
    const body = JSON.parse(res.captured.body);
    expect(body.text).toContain('pnpm test');
    expect(body.approxTokens).toBeGreaterThan(0);

    // Same inputs → byte-identical payload (shared prefix across subagents).
    const res2 = fakeRes();
    await h.api.handle(fakeReq('GET'), res2, '/working-set?filePath=src/a.ts&branch=main');
    expect(JSON.parse(res2.captured.body).text).toBe(body.text);
  });

  it('subagent fiber: context → stage → merge commits staged memory', async () => {
    const resCtx = fakeRes();
    await h.api.handle(fakeReq('POST', { parentSessionId: 'sess_p', subagentId: 'sub_1' }), resCtx, '/subagent/context');
    expect(JSON.parse(resCtx.captured.body).subagentId).toBe('sub_1');

    const resStage = fakeRes();
    await h.api.handle(fakeReq('POST', {
      subagentId: 'sub_1',
      memory: { tier: 'semantic', category: 'architecture', content: 'Auth lives in apps/auth', summary: 'auth location' }
    }), resStage, '/subagent/stage');
    expect(JSON.parse(resStage.captured.body).staged).toBe(true);

    const resMerge = fakeRes();
    await h.api.handle(fakeReq('POST', { subagentId: 'sub_1' }), resMerge, '/subagent/merge');
    const merged = JSON.parse(resMerge.captured.body);
    expect(merged.committedMemories.length).toBe(1);
    expect(merged.committedMemories[0].content).toContain('apps/auth');

    // After merge the fiber is gone; staging again 400s.
    const resStage2 = fakeRes();
    await h.api.handle(fakeReq('POST', { subagentId: 'sub_1', memory: { tier: 'semantic', category: 'rule', content: 'x' } }), resStage2, '/subagent/stage');
    expect(resStage2.captured.status).toBe(400);
  });

  it('subagent discard drops staged memories without committing', async () => {
    await h.api.handle(fakeReq('POST', { parentSessionId: 'p', subagentId: 'sub_2' }), fakeRes(), '/subagent/context');
    await h.api.handle(fakeReq('POST', { subagentId: 'sub_2', memory: { tier: 'semantic', category: 'rule', content: 'temp' } }), fakeRes(), '/subagent/stage');
    const res = fakeRes();
    await h.api.handle(fakeReq('POST', { subagentId: 'sub_2' }), res, '/subagent/discard');
    expect(JSON.parse(res.captured.body).discarded).toBe(true);
    expect(h.service.getStats().total).toBe(0);
  });

  it('GET /cost reports the session-injection estimate row', async () => {
    await h.service.remember({
      tier: 'semantic', category: 'rule', entity_key: 'repo.cmd',
      content: 'Use pnpm test', summary: 'pnpm test', importance: 5, status: 'verified'
    });
    h.ctx.emit('session/created', { id: 'sess_cost' });
    const res = fakeRes();
    await h.api.handle(fakeReq('GET'), res, '/cost?days=7');
    const report = JSON.parse(res.captured.body);
    const injection = report.byPurpose.find((p: any) => p.purpose === 'injection');
    expect(injection).toBeDefined();
    expect(injection.calls).toBe(1);
    expect(report.totalUsd).toBeGreaterThanOrEqual(0);
  });

  it('GET /export?format=markdown + POST /import round-trip over HTTP', async () => {
    await h.service.remember({
      tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'user.tz',
      content: 'User works in UTC+8', summary: 'tz utc+8', importance: 3, status: 'verified'
    });

    const resExport = fakeRes();
    await h.api.handle(fakeReq('GET'), resExport, '/export?format=markdown');
    const exported = JSON.parse(resExport.captured.body);
    expect(exported.count).toBe(1);
    expect(exported.files['MEMORY.md']).toContain('user.tz');

    const resImport = fakeRes();
    await h.api.handle(fakeReq('POST', { files: exported.files }), resImport, '/import');
    expect(JSON.parse(resImport.captured.body)).toMatchObject({ processed: 1, unchanged: 1 });
  });
});

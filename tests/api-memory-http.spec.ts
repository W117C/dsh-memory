import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { MemoryConsolidator } from '../src/core/consolidator.js';
import { MemoryPortability } from '../src/core/portability.js';
import { MemoryHttpApi } from '../src/api/memory-http.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

function fakeReq(method: string, body?: unknown): IncomingMessage {
  const req = new Readable({ read() {} }) as IncomingMessage;
  req.method = method;
  req.url = '/';
  if (body !== undefined) {
    req.push(typeof body === 'string' ? body : JSON.stringify(body));
  }
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

describe('Memory HTTP API boundary (native webserver prefix route)', () => {
  let store: MemoryStore;
  let api: MemoryHttpApi;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    const ctx = new Context();
    const resolver = new ConflictResolver(store);
    const consolidator = new MemoryConsolidator(
      ctx, store,
      new HybridRetriever(store, DEFAULT_CONFIG.retrieval),
      resolver,
      {
        llmAssisted: false,
        similarityTopK: 5,
        extractEntities: true,
        llmProvider: 'deepseek-official',
        model: 'deepseek-v4-flash'
      }
    );
    const portability = new MemoryPortability(store, resolver);
    api = new MemoryHttpApi(
      store,
      new HybridRetriever(store, DEFAULT_CONFIG.retrieval),
      {
        store,
        rememberDetailed: (input) => consolidator.consolidate(input),
        rememberBatch: (inputs) => portability.importBatch(inputs),
        getHistory: (memoryId, limit) => store.getMemoryHistory(memoryId, limit),
        getAllHistory: (limit) => store.getAllHistory(limit),
        exportJsonl: (options) => portability.exportJsonl(options),
        importJsonl: (jsonl) => portability.importJsonl(jsonl)
      }
    );
  });

  afterEach(() => {
    store.close();
  });

  it('rejects malformed memory ids in review routes instead of trusting the path', async () => {
    const res = fakeRes();
    await api.handle(fakeReq('POST'), res, '/memories/../../etc/passwd/promote');
    const body = JSON.parse(res.captured.body) as { error: string };
    expect(body.error).toMatch(/no route/);
    // And the traversal payload never reached the store: nothing was created.
    expect(store.getStats().total).toBe(0);
  });

  it('accepts only well-formed ids for promote', async () => {
    const mem = await store.createMemory({ tier: 'semantic', category: 'rule', content: 'x', status: 'tentative' });
    const res = fakeRes();
    await api.handle(fakeReq('POST'), res, `/memories/${mem.id}/promote`);
    const body = JSON.parse(res.captured.body) as { promoted: string; status: string };
    expect(body.promoted).toBe(mem.id);
    expect(body.status).toBe('verified');
  });

  it('rejects invalid JSON bodies with a 400-envelope', async () => {
    const res = fakeRes();
    await api.handle(fakeReq('POST', '{not json'), res, '/remember');
    const body = JSON.parse(res.captured.body) as { error: string };
    expect(body.error).toContain('invalid JSON');
  });

  it('enforces the body size cap', async () => {
    const req = new Readable({ read() {} }) as IncomingMessage;
    req.method = 'POST';
    req.url = '/';
    req.push(JSON.stringify({ content: 'x'.repeat(1_100_000) }));
    req.push(null);
    const res = fakeRes();
    await api.handle(req, res, '/remember');
    const body = JSON.parse(res.captured.body) as { error: string };
    expect(body.error).toBe('body too large');
  });

  it('requires a query for recall', async () => {
    const res = fakeRes();
    await api.handle(fakeReq('POST', {}), res, '/recall');
    const body = JSON.parse(res.captured.body) as { error: string };
    expect(body.error).toBe('query required');
  });
});

describe('Memory HTTP API: top-tier capability endpoints', () => {
  let store: MemoryStore;
  let api: MemoryHttpApi;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    const ctx = new Context();
    const resolver = new ConflictResolver(store);
    const consolidator = new MemoryConsolidator(
      ctx, store,
      new HybridRetriever(store, DEFAULT_CONFIG.retrieval),
      resolver,
      { llmAssisted: false, similarityTopK: 5, extractEntities: true, llmProvider: 'deepseek-official', model: 'deepseek-v4-flash' }
    );
    const portability = new MemoryPortability(store, resolver);
    api = new MemoryHttpApi(
      store,
      new HybridRetriever(store, DEFAULT_CONFIG.retrieval),
      {
        store,
        rememberDetailed: (input) => consolidator.consolidate(input),
        rememberBatch: (inputs) => portability.importBatch(inputs),
        getHistory: (memoryId, limit) => store.getMemoryHistory(memoryId, limit),
        getAllHistory: (limit) => store.getAllHistory(limit),
        exportJsonl: (options) => portability.exportJsonl(options),
        importJsonl: (jsonl) => portability.importJsonl(jsonl)
      }
    );
  });

  afterEach(() => {
    store.close();
  });

  it('POST /remember returns the consolidation outcome', async () => {
    const res = fakeRes();
    await api.handle(fakeReq('POST', { content: 'always run pnpm test' }), res, '/remember');
    const body = JSON.parse(res.captured.body) as { action: string; memoryId: string; engine: string; events: string[] };
    expect(body.action).toBe('ADD');
    expect(body.engine).toBe('deterministic');
    expect(body.events).toEqual(['ADD']);
  });

  it('POST /remember/batch processes arrays', async () => {
    const res = fakeRes();
    await api.handle(fakeReq('POST', { inputs: [
      { content: 'rule a', tier: 'semantic', category: 'rule' },
      { content: 'rule b', tier: 'semantic', category: 'rule' }
    ] }), res, '/remember/batch');
    const body = JSON.parse(res.captured.body) as Array<{ action: string }>;
    expect(body.length).toBe(2);
    expect(body.every((r) => r.action === 'ADD')).toBe(true);
  });

  it('GET /history filters by memory_id and rejects malformed ids', async () => {
    const mem = await store.createMemory({ tier: 'semantic', category: 'rule', content: 'x' });
    store.updateMemory(mem.id, { content: 'y' });

    const res = fakeRes();
    await api.handle(fakeReq('GET'), res, `/history?memory_id=${mem.id}`);
    const body = JSON.parse(res.captured.body) as Array<{ event: string }>;
    expect(body.length).toBe(2);
    expect(body[0].event).toBe('updated');

    const resBad = fakeRes();
    await api.handle(fakeReq('GET'), resBad, '/history?memory_id=..%2F..%2Fetc%2Fpasswd');
    const all = JSON.parse(resBad.captured.body) as Array<{ event: string }>;
    expect(Array.isArray(all)).toBe(true);
  });

  it('GET /export and POST /import round-trip through the API', async () => {
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'persisted rule', status: 'verified' });

    const resExport = fakeRes();
    await api.handle(fakeReq('GET'), resExport, '/export');
    const exported = JSON.parse(resExport.captured.body) as { jsonl: string; lines: number };
    expect(exported.lines).toBe(1);

    const resImport = fakeRes();
    await api.handle(fakeReq('POST', { jsonl: exported.jsonl }), resImport, '/import');
    const summary = JSON.parse(resImport.captured.body) as { processed: number; invalidLines: number };
    expect(summary.processed).toBe(1);
    expect(summary.invalidLines).toBe(0);
  });

  it('POST /import rejects oversized payloads and missing fields', async () => {
    const resMissing = fakeRes();
    await api.handle(fakeReq('POST', {}), resMissing, '/import');
    expect(JSON.parse(resMissing.captured.body).error).toBe('jsonl or markdown required');

    const resBig = fakeRes();
    await api.handle(fakeReq('POST', { jsonl: 'x'.repeat(10_000_001) }), resBig, '/import');
    // Defense in depth: the 1MB body cap fires before the jsonl-specific cap.
    expect(JSON.parse(resBig.captured.body).error).toBe('body too large');
  });
});

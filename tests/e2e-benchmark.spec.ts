import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryWebExtension } from '../src/ui/web-extension.js';
import type { DistillSessionInput, TrajectoryStep } from '../src/pipeline/distiller.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * Full end-to-end scenario over the NATIVE dsh surfaces: real Cordis v4
 * context, real session events, the real system-prompt registry contract,
 * and the real /api/memory HTTP face on a fake webserver route table.
 */

class FakeSystemPrompt {
  public sections = new Map<string, { name: string; order: number; text: string | ((context: unknown) => string) }>();
  public contexts = new Map<string, { name: string; order: number; text: string | ((context: unknown) => string) }>();
  section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void {
    this.sections.set(section.name, section);
    return () => this.sections.delete(section.name);
  }
  context(context: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void {
    this.contexts.set(context.name, context);
    return () => this.contexts.delete(context.name);
  }
  resolve(kind: 'sections' | 'contexts', name: string): string {
    const entry = this[kind].get(name);
    if (!entry) throw new Error(`not registered: ${name}`);
    return typeof entry.text === 'function' ? (entry.text as (c: unknown) => string)({}) : entry.text;
  }
}

class FakeHttpServer {
  public routes: Array<{ kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }> = [];
  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void {
    this.routes.push(route);
    return () => {
      this.routes = this.routes.filter((r) => r !== route);
    };
  }
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new Readable({ read() {} }) as IncomingMessage & { push(chunk: unknown): boolean };
  req.method = method;
  req.url = url;
  if (body !== undefined) {
    req.push(JSON.stringify(body));
    req.push(null);
  } else {
    req.push(null);
  }
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

async function callApi(http: FakeHttpServer, method: string, path: string, body?: unknown): Promise<unknown> {
  const route = http.routes.find((r) => path.startsWith(r.path));
  if (!route) throw new Error(`no route mounted for ${path}`);
  const req = fakeReq(method, path, body);
  const res = fakeRes();
  await route.handler(req, res);
  return JSON.parse(res.captured.body);
}

describe('Phase 5: Full End-to-End Real-World Scenario Benchmark (native surfaces)', () => {
  it('demonstrates cross-session learning, section stability, 1-turn recall, and the native web API', async () => {
    const ctx = new Context();
    const fakeSystemPrompt = new FakeSystemPrompt();
    const fakeHttp = new FakeHttpServer();
    ctx.reflect.provide('systemPrompt', fakeSystemPrompt);
    ctx.reflect.provide('httpServer', fakeHttp);

    const fiber = apply(ctx, {
      ...DEFAULT_CONFIG,
      storage: { workspaceDbPath: ':memory:' }
    } as never);
    await fiber;

    const memoryService = ctx.get('memory') as any;

    // ==========================================
    // STEP 1: Session 1 — Project Setup & Learning
    // ==========================================
    const trajectory1: TrajectoryStep[] = [
      { step_index: 1, type: 'USER_INPUT', content: '本项目一律使用具名导出，严禁 default export，统一使用 pnpm' },
      { step_index: 2, type: 'TOOL_CALL', content: 'run_command pnpm build' },
      {
        step_index: 3,
        type: 'TOOL_RESULT',
        status: 'ERROR',
        content: 'TypeError: cookies() must be awaited in Next.js 15 Server Components',
        metadata: { exitCode: 1, toolName: 'run_command' }
      },
      { step_index: 4, type: 'MODEL', content: '修改代码: const cookieStore = await cookies();' },
      { step_index: 5, type: 'TOOL_CALL', content: 'run_command pnpm build' },
      {
        step_index: 6,
        type: 'TOOL_RESULT',
        status: 'DONE',
        content: 'Compiled successfully in 840ms',
        metadata: { exitCode: 0, toolName: 'run_command' }
      }
    ];

    const session1: DistillSessionInput = { id: 'session_e2e_001', trajectory: trajectory1 };
    const distillSummary = await memoryService.distiller.distillSession(session1);
    expect(distillSummary.semanticFactsExtracted).toBe(1);
    expect(distillSummary.postMortemsExtracted).toBe(1);

    const stats1 = memoryService.getStats();
    expect(stats1.total).toBe(2);

    // ==========================================
    // STEP 2: Session 2 — Cross-session steady section
    // ==========================================
    ctx.emit('session/created', { id: 'session_e2e_002' });

    const sectionText = fakeSystemPrompt.resolve('sections', 'memory:working-set');
    expect(sectionText).toContain('<dsh_memory');
    expect(sectionText).toContain('严禁 default export');

    // ==========================================
    // STEP 3: 1-turn bug resolution via tool recall + verification gate
    // ==========================================
    const recalls = await memoryService.recall('cookies must be awaited Next.js 15');
    expect(recalls.length).toBeGreaterThan(0);
    const topSolution = recalls[0];
    expect(topSolution.memory.solution_code).toContain('await cookies()');

    const webExt = new MemoryWebExtension(memoryService.store);
    const promoted = webExt.promoteMemory(topSolution.memory.id);
    expect(promoted?.status).toBe('verified');

    // ==========================================
    // STEP 4: Native web panel API (same face the browser half fetches)
    // ==========================================
    const stats = (await callApi(fakeHttp, 'GET', '/api/memory/stats')) as { total: number };
    expect(stats.total).toBe(2);

    const graphData = (await callApi(fakeHttp, 'GET', '/api/memory/graph')) as { nodes: unknown[] };
    expect(graphData.nodes.length).toBeGreaterThan(0);

    const tentativeList = (await callApi(fakeHttp, 'GET', '/api/memory/memories?status=tentative')) as Array<{ id: string; status: string }>;
    expect(Array.isArray(tentativeList)).toBe(true);

    const recallApi = (await callApi(fakeHttp, 'POST', '/api/memory/recall', { query: 'cookies() must be awaited' })) as {
      results: Array<{ summary: string }>;
    };
    expect(recallApi.results.length).toBeGreaterThan(0);

    await fiber.dispose();
  });
});

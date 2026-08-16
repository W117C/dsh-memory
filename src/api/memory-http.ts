/**
 * Host-side HTTP face for the native web panel: one PREFIX route on the dsh
 * webserver (`ctx.httpServer.register`, `@deepseek-ai/dsh-host-webserver`),
 * serving JSON to the browser half under the same origin. The webserver is
 * an optional capability — absent under headless, the panel simply does not
 * mount.
 *
 * Route parameters never touch string-assembled SQL: every lookup goes
 * through MemoryStore's prepared statements.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryStore } from '../storage/db.js';
import type { MemoryCreateInput } from '../types/memory.js';
import { MemoryWebExtension } from '../ui/web-extension.js';
import { HybridRetriever } from '../core/hybrid-retriever.js';

export interface HttpServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

export function getHttpServer(ctx: Context): HttpServerLike | undefined {
  const candidate = (ctx as { get?: (name: string) => unknown }).get?.('httpServer');
  if (candidate && typeof (candidate as HttpServerLike).register === 'function') {
    return candidate as HttpServerLike;
  }
  return undefined;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/** Split "/memories/<id>/promote" into its id segment, or null. */
function memoryIdOf(subpath: string, action: 'promote' | 'deprecate'): string | null {
  const parts = subpath.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'memories' || parts[2] !== action) return null;
  const id = parts[1];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return id;
}

/** The host-side faces the API needs (satisfied by MemoryService). */
export interface MemoryApiSurface {
  store: MemoryStore;
  rememberDetailed(input: MemoryCreateInput): Promise<{ action: string; memoryId: string; reason: string; events: string[]; engine: string }>;
  rememberBatch(inputs: MemoryCreateInput[]): Promise<Array<{ index: number; action: string; memoryId: string }>>;
  getHistory(memoryId: string, limit?: number): unknown[];
  getAllHistory(limit?: number): unknown[];
  exportJsonl(options?: { includeDeprecated?: boolean; scope?: 'workspace' | 'global' }): string;
  importJsonl(jsonl: string): Promise<{ processed: number; added: number; ignored: number; overwritten: number; invalidLines: number }>;
  exportMarkdown(options?: { includeDeprecated?: boolean; scope?: 'workspace' | 'global' }): { files: Record<string, string>; count: number };
  importMarkdown(input: Record<string, string> | string): Promise<{ processed: number; added: number; updated: number; unchanged: number; invalid: number }>;
  getCostReport(sinceDays?: number): unknown;
  getOrchestratorWorkingSet(currentFilePath?: string, currentGitBranch?: string): { text: string; approxTokens: number };
  createSubagentContext(parentSessionId: string, subagentId: string): unknown;
  stageSubagentMemory(subagentId: string, memoryInput: MemoryCreateInput): boolean;
  mergeSubagentOnSuccess(subagentId: string): Promise<unknown>;
  discardSubagentOnFailure(subagentId: string): void;
}

export class MemoryHttpApi {
  constructor(
    private store: MemoryStore,
    private retriever: HybridRetriever,
    private surface: MemoryApiSurface
  ) {}

  /** Handle one request under the prefix; `subpath` excludes the prefix. */
  public async handle(req: IncomingMessage, res: ServerResponse, subpath: string): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const result = await this.dispatch(method, subpath, req);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async dispatch(method: string, subpath: string, req: IncomingMessage): Promise<unknown> {
    const panel = new MemoryWebExtension(this.store);
    const pathOnly = subpath.split('?')[0];
    const query = new URLSearchParams(subpath.split('?')[1] ?? '');

    if (method === 'GET' && pathOnly === '/stats') {
      return this.store.getStats();
    }

    if (method === 'GET' && pathOnly === '/graph') {
      return panel.getGraphData();
    }

    if (method === 'GET' && pathOnly === '/memories') {
      return panel.listMemories({
        status: sanitizeEnum(query.get('status'), ['tentative', 'verified', 'deprecated', 'all']),
        tier: sanitizeEnum(query.get('tier'), ['semantic', 'episodic', 'procedural', 'all']),
        limit: sanitizeLimit(query.get('limit'))
      });
    }

    const promoteId = memoryIdOf(pathOnly, 'promote');
    if (method === 'POST' && promoteId) {
      const mem = panel.promoteMemory(promoteId);
      if (!mem) throw new Error('memory not found');
      return { promoted: mem.id, status: mem.status };
    }

    const deprecateId = memoryIdOf(pathOnly, 'deprecate');
    if (method === 'POST' && deprecateId) {
      const mem = panel.deprecateMemory(deprecateId);
      if (!mem) throw new Error('memory not found');
      return { deprecated: mem.id, status: mem.status };
    }

    if (method === 'POST' && pathOnly === '/recall') {
      const body = await readJsonBody(req);
      const q = typeof body.query === 'string' ? body.query.slice(0, 500) : '';
      if (!q) throw new Error('query required');
      const results = await this.retriever.retrieve(q, { topK: 8, includeTentative: true });
      return {
        results: results.map(r => ({
          id: r.memory.id,
          tier: r.memory.tier,
          status: r.memory.status,
          summary: r.memory.summary,
          solution_code: r.memory.solution_code ?? null,
          score: Math.round(r.score * 100) / 100
        }))
      };
    }

    if (method === 'GET' && pathOnly === '/history') {
      const memoryId = query.get('memory_id');
      const limit = sanitizeLimit(query.get('limit'));
      if (memoryId && /^[A-Za-z0-9_-]{1,128}$/.test(memoryId)) {
        return this.surface.getHistory(memoryId, limit);
      }
      return this.surface.getAllHistory(limit);
    }

    if (method === 'GET' && pathOnly === '/export') {
      if (query.get('format') === 'markdown') {
        const exportResult = this.surface.exportMarkdown({
          includeDeprecated: query.get('all') === '1',
          scope: sanitizeEnum(query.get('scope'), ['workspace', 'global']) as 'workspace' | 'global' | undefined
        });
        return exportResult;
      }
      const body = this.surface.exportJsonl({
        includeDeprecated: query.get('all') === '1',
        scope: sanitizeEnum(query.get('scope'), ['workspace', 'global']) as 'workspace' | 'global' | undefined
      });
      return { jsonl: body, lines: body.split('\n').filter((l) => l.trim()).length };
    }

    if (method === 'POST' && pathOnly === '/import') {
      const body = await readJsonBody(req);
      if (typeof body.jsonl === 'string') {
        if (body.jsonl.length > 10_000_000) throw new Error('jsonl too large');
        return this.surface.importJsonl(body.jsonl);
      }
      if (typeof body.markdown === 'string' || (body.files && typeof body.files === 'object')) {
        const markdownInput = typeof body.markdown === 'string' ? body.markdown : body.files as Record<string, string>;
        const totalLength = typeof markdownInput === 'string'
          ? markdownInput.length
          : Object.values(markdownInput).reduce((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);
        if (totalLength > 10_000_000) throw new Error('markdown too large');
        return this.surface.importMarkdown(markdownInput);
      }
      throw new Error('jsonl or markdown required');
    }

    if (method === 'POST' && pathOnly === '/remember/batch') {
      const body = await readJsonBody(req);
      const inputs = Array.isArray(body.inputs) ? body.inputs : null;
      if (!inputs || inputs.length > 1000) throw new Error('inputs array required (max 1000)');
      return this.surface.rememberBatch(inputs as MemoryCreateInput[]);
    }

    if (method === 'POST' && pathOnly === '/remember') {
      const body = await readJsonBody(req);
      if (typeof body.content !== 'string' || !body.content) throw new Error('content required');
      return this.surface.rememberDetailed({
        tier: body.tier === 'episodic' || body.tier === 'procedural' ? body.tier : 'semantic',
        category: typeof body.category === 'string' ? (body.category as never) : 'rule',
        content: body.content,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        entity_key: typeof body.entity_key === 'string' ? body.entity_key : undefined,
        path_pattern: typeof body.path_pattern === 'string' ? body.path_pattern : '*',
        importance: typeof body.importance === 'number' ? body.importance : 4.0,
        status: 'verified'
      });
    }

    // ---- Cost observability (P1) ----
    if (method === 'GET' && pathOnly === '/cost') {
      const days = sanitizeLimit(query.get('days'));
      return this.surface.getCostReport(days && days > 0 && days <= 365 ? days : 7);
    }

    // ---- dsh-ultra orchestrator integration surface (P2) ----
    if (method === 'GET' && pathOnly === '/working-set') {
      const filePath = (query.get('filePath') ?? query.get('file') ?? '').slice(0, 500);
      const branch = (query.get('branch') ?? '').slice(0, 200);
      return this.surface.getOrchestratorWorkingSet(filePath, branch);
    }

    if (method === 'POST' && pathOnly === '/subagent/context') {
      const body = await readJsonBody(req);
      if (typeof body.parentSessionId !== 'string' || typeof body.subagentId !== 'string') {
        throw new Error('parentSessionId and subagentId required');
      }
      return this.surface.createSubagentContext(body.parentSessionId.slice(0, 200), body.subagentId.slice(0, 200));
    }

    if (method === 'POST' && pathOnly === '/subagent/stage') {
      const body = await readJsonBody(req);
      if (typeof body.subagentId !== 'string' || !body.memory || typeof body.memory !== 'object') {
        throw new Error('subagentId and memory required');
      }
      const ok = this.surface.stageSubagentMemory(body.subagentId.slice(0, 200), body.memory as MemoryCreateInput);
      if (!ok) throw new Error('unknown subagentId (create /subagent/context first)');
      return { staged: true };
    }

    if (method === 'POST' && pathOnly === '/subagent/merge') {
      const body = await readJsonBody(req);
      if (typeof body.subagentId !== 'string') throw new Error('subagentId required');
      return this.surface.mergeSubagentOnSuccess(body.subagentId.slice(0, 200));
    }

    if (method === 'POST' && pathOnly === '/subagent/discard') {
      const body = await readJsonBody(req);
      if (typeof body.subagentId !== 'string') throw new Error('subagentId required');
      this.surface.discardSubagentOnFailure(body.subagentId.slice(0, 200));
      return { discarded: true };
    }

    throw new Error(`no route: ${method} ${pathOnly}`);
  }
}

function sanitizeEnum(value: string | null, allowed: string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined;
}

function sanitizeLimit(value: string | null): number | undefined {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function registerMemoryHttpApi(
  ctx: Context,
  store: MemoryStore,
  retriever: HybridRetriever,
  surface: MemoryApiSurface,
  workingSetBuilder?: unknown,
  routePrefix: string = '/api/memory'
): (() => void) | undefined {
  void workingSetBuilder; // reserved: builder access is reached through the service surface
  const httpServer = getHttpServer(ctx);
  if (!httpServer) return undefined;

  const api = new MemoryHttpApi(store, retriever, surface);
  const prefix = routePrefix.replace(/\/+$/, '');

  return httpServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      const url = req.url ?? '/';
      const subpath = url.startsWith(prefix) ? url.slice(prefix.length) : url;
      await api.handle(req, res, subpath);
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
      throw new Error('body too large');
    }
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * MemoryService: the host plugin body over `@deepseek-ai/cordis` v4.
 *
 * Everything dsh-specific is an OPTIONAL capability reached through
 * `ctx.get(...)` and withdrawn through Cordis effect disposers:
 *
 * - `tools`           — the four model-visible memory tools
 * - `systemPrompt`    — Tier 1 steady section + Tier 2 recall context
 * - `sessions` events — working-context tracking + disposal distillation
 * - `httpServer`      — the JSON face behind the native web panel
 * - `llm`             — DeepSeek-V4 distillation route
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { MemoryConfig } from '../config.js';
import { MemoryStore } from '../storage/db.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { ConflictResolver } from './conflict-resolver.js';
import { WorkingSetBuilder } from './working-set.js';
import { NativeMemoryInjector } from './injection.js';
import { MemoryConsolidator, ConsolidationOutcome } from './consolidator.js';
import { MemoryPortability, ExportOptions, ImportSummary } from './portability.js';
import { MarkdownProjection, MarkdownExportOptions, MarkdownExport, MarkdownImportSummary } from './markdown-projection.js';
import { CostTracker, CostReport } from './cost-tracker.js';
import { estimateTokensFromText, isPeakHour, msUntilNextValley } from './peak-pricing.js';
import { SubagentFiberManager, SubagentSessionContext, FiberMergeResult } from './subagent-fiber.js';
import { DshEventAdapter } from '../adapter/dsh-adapter.js';
import { registerMemoryTools } from '../tools/index.js';
import { registerMemoryHttpApi } from '../api/memory-http.js';
import { TrajectoryDistiller, DistillSummary, getLlmService } from '../pipeline/distiller.js';
import type { TrajectoryStep } from '../pipeline/trajectory-filter.js';
import { EpisodicMemoryManager } from '../subsystems/episodic.js';
import { ProceduralMemoryManager } from '../subsystems/procedural.js';
import { MemoryCreateInput, MemoryRecord, RecallOptions, ScoredMemory, MemoryStats, MemoryHistoryRecord } from '../types/memory.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService;
  }
}

export class MemoryService extends Service {
  public store!: MemoryStore;
  public retriever!: HybridRetriever;
  public resolver!: ConflictResolver;
  public consolidator!: MemoryConsolidator;
  public portability!: MemoryPortability;
  public projection!: MarkdownProjection;
  public costTracker!: CostTracker;
  public fiberManager!: SubagentFiberManager;
  public workingSetBuilder!: WorkingSetBuilder;
  public injector!: NativeMemoryInjector;
  public distiller!: TrajectoryDistiller;
  public eventAdapter!: DshEventAdapter;

  /** Timers for off-peak-deferred distillation, cleared on dispose. */
  private pendingDistillTimers = new Map<string, NodeJS.Timeout>();

  constructor(ctx: Context, public config: MemoryConfig) {
    super(ctx, 'memory');

    this.ctx.effect(() => {
      // 1. Persistent storage & retrieval engines
      this.store = new MemoryStore(this.config);
      // Warm the local embedding model in the background so the first
      // retrieval does not pay the one-time load.
      this.store.getEmbeddingAdapter().warmUp();
      const rewriter = this.config.retrieval.queryRewrite
        ? (q: string) => this.rewriteQuery(q)
        : undefined;
      this.retriever = new HybridRetriever(this.store, this.config.retrieval, rewriter);
      this.resolver = new ConflictResolver(this.store);
      this.workingSetBuilder = new WorkingSetBuilder(this.store, this.config.retrieval);
      const episodicMgr = new EpisodicMemoryManager(this.store);
      const proceduralMgr = new ProceduralMemoryManager(this.store);
      this.costTracker = new CostTracker(this.store.getDb());
      this.distiller = new TrajectoryDistiller(this.ctx, this.store, this.config.distillation, {
        resolver: this.resolver,
        episodicMgr,
        proceduralMgr,
        costTracker: this.costTracker
      });
      this.eventAdapter = new DshEventAdapter(this.ctx);
      this.consolidator = new MemoryConsolidator(this.ctx, this.store, this.retriever, this.resolver, {
        llmAssisted: this.config.consolidation.llmAssisted,
        similarityTopK: this.config.consolidation.similarityTopK,
        extractEntities: this.config.consolidation.extractEntities,
        llmProvider: this.config.distillation.llmProvider,
        model: this.config.distillation.distillModel,
        costTracker: this.costTracker
      });
      this.portability = new MemoryPortability(this.store, this.resolver);
      this.projection = new MarkdownProjection(this.store);
      this.fiberManager = new SubagentFiberManager(this.store, this.resolver);

      // 2. KV-cache friendly dual-tier prompt injection (native registry)
      this.injector = new NativeMemoryInjector(this.ctx, this.workingSetBuilder, this.config.prompt.enabled);
      const disposeInjection = this.injector.register();

      // 3. Model-visible tools (recall results also feed the Tier 2 snapshot;
      //    writes go through the consolidation engine)
      const disposeTools = registerMemoryTools(
        this.ctx,
        this.store,
        (input) => this.consolidator.consolidate(input),
        this.retriever,
        episodicMgr,
        proceduralMgr,
        {
          onRecallExecuted: (sessionId, query, results) => {
            this.injector.recordRecall(sessionId, query, results);
          }
        }
      );

      // 4. Native web panel backend on the dsh webserver
      const disposeHttp = this.config.web.enabled
        ? registerMemoryHttpApi(
            this.ctx,
            this.store,
            this.retriever,
            this,
            this.workingSetBuilder,
            this.config.web.routePrefix
          )
        : undefined;

      // 5. Session lifecycle: bind, track, distill-on-dispose
      const unhookCreated = this.eventAdapter.onSessionCreated((session) => {
        this.injector.bindSession(session.id);
        this.recordInjectionEstimate(session.id);
      });

      const unhookEvent = this.eventAdapter.onSessionEvent((session, event) => {
        this.eventAdapter.trackEvent(session.id, event);
      });

      const unhookDisposed = this.eventAdapter.onSessionDisposed((session) => {
        const context = this.eventAdapter.takeContext(session.id);
        this.workingSetBuilder.invalidateSession(session.id);
        this.injector.dropSession(session.id);

        if (this.config.distillation.autoDistillOnFinish && context) {
          this.scheduleDistillation(session.id, context.trajectory);
        }
      });

      return () => {
        for (const timer of this.pendingDistillTimers.values()) clearTimeout(timer);
        this.pendingDistillTimers.clear();
        unhookCreated();
        unhookEvent();
        unhookDisposed();
        disposeHttp?.();
        disposeTools?.();
        disposeInjection?.();
        this.eventAdapter.clear();
        this.store.close();
      };
    });
  }

  /**
   * Distill now, or — when `distillation.offPeakOnly` is on and we are inside
   * a peak window — defer into the next valley (off-peak is half price).
   */
  private scheduleDistillation(sessionId: string, trajectory: TrajectoryStep[]): void {
    const run = () => {
      this.pendingDistillTimers.delete(sessionId);
      this.distiller
        .distillSession({ id: sessionId, trajectory })
        .catch((err) => {
          this.ctx.logger('memory').warn('distillation failed:', err);
        });
    };

    if (this.config.distillation.offPeakOnly && isPeakHour()) {
      const delay = msUntilNextValley();
      const maxMs = this.config.distillation.maxDeferHours * 60 * 60 * 1000;
      if (delay > 0 && delay <= maxMs) {
        const timer = setTimeout(run, delay);
        this.pendingDistillTimers.set(sessionId, timer);
        return;
      }
    }
    run();
  }

  /** One estimated injection-cost row per session bind (working-set size × hit price). */
  private recordInjectionEstimate(sessionId: string): void {
    try {
      const workingSet = this.workingSetBuilder.getOrCreateWorkingSet(sessionId);
      if (!workingSet) return;
      this.costTracker.record({
        model: 'deepseek-v4-pro',
        purpose: 'injection',
        hitTokens: estimateTokensFromText(workingSet),
        estimated: true,
        sessionId,
        meta: { kind: 'tier1-working-set' }
      });
    } catch {
      // cost observability must never break session binding
    }
  }

  /**
   * Query rewrite for retrieval (config `retrieval.queryRewrite`): one cheap
   * distill-model call turning an abstract/colloquial query into a
   * keyword-rich line. Errors propagate to the retriever, which falls back
   * to the raw query.
   */
  private async rewriteQuery(query: string): Promise<string> {
    const llm = getLlmService(this.ctx);
    if (!llm) return query;

    const system =
      'You rewrite memory-search queries into retrieval keywords.\n' +
      'Rules: output ONE line of 5-12 keywords separated by spaces; include concrete technical ' +
      'terms, config keys, tool/command names, file names, and synonyms in the query\'s own ' +
      'languages (Chinese and/or English); expand abbreviations to the likely concrete terms ' +
      'even when they do not appear verbatim in the query; NEVER repeat the query verbatim; ' +
      'no explanation.\n' +
      'Example — Query: 数据库连不上怎么办\n' +
      'Keywords: ECONNREFUSED postgres 连接被拒 数据库连接失败 docker compose db 端口 5432 pgbouncer 连接超时';
    const prompt = `Query: ${query.slice(0, 400)}\nKeywords:`;

    let text = '';
    for await (const chunk of llm.stream({
      provider: this.config.distillation.llmProvider,
      model: this.config.distillation.distillModel,
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 64,
      // Trivial keyword task: thinking mode would burn the token budget on
      // reasoning_content and truncate the answer.
      thinking: { type: 'disabled' }
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
      }
    }

    this.costTracker.recordEstimatedText(
      this.config.distillation.distillModel,
      'query-rewrite',
      system + prompt,
      text
    );

    const clean = text.trim().split('\n')[0].slice(0, 300);
    return clean || query;
  }

  /**
   * Write path (mem0-class): LLM-assisted consolidation when the dsh `llm`
   * service is available, deterministic conflict resolution otherwise.
   */
  public async remember(input: MemoryCreateInput): Promise<MemoryRecord> {
    const outcome = await this.consolidator.consolidate(input);
    return this.store.getMemoryById(outcome.memoryId)!;
  }

  public async rememberDetailed(input: MemoryCreateInput): Promise<ConsolidationOutcome> {
    return this.consolidator.consolidate(input);
  }

  public async rememberBatch(inputs: MemoryCreateInput[]): Promise<Array<{ index: number; action: string; memoryId: string }>> {
    return this.portability.importBatch(inputs);
  }

  public async recall(query: string, options?: RecallOptions): Promise<ScoredMemory[]> {
    return this.retriever.retrieve(query, options);
  }

  public getStats(): MemoryStats {
    return this.store.getStats();
  }

  public getHistory(memoryId: string, limit?: number): MemoryHistoryRecord[] {
    return this.store.getMemoryHistory(memoryId, limit);
  }

  public getAllHistory(limit?: number): MemoryHistoryRecord[] {
    return this.store.getAllHistory(limit);
  }

  public exportJsonl(options?: ExportOptions): string {
    return this.portability.exportJsonl(options);
  }

  public async importJsonl(jsonl: string): Promise<ImportSummary> {
    return this.portability.importJsonl(jsonl);
  }

  // ---- P1: human-readable markdown projection (SQLite stays the truth) ----

  public exportMarkdown(options?: MarkdownExportOptions): MarkdownExport {
    return this.projection.exportMarkdown(options);
  }

  public async importMarkdown(input: Record<string, string> | string): Promise<MarkdownImportSummary> {
    return this.projection.importMarkdown(input);
  }

  // ---- P1: cost observability ----

  public getCostReport(sinceDays = 7): CostReport {
    return this.costTracker.getReport(sinceDays);
  }

  // ---- P2: dsh-ultra orchestrator integration surface ----

  /**
   * Fresh working set for orchestration fan-out: every subagent prompt gets
   * the SAME prefix, so the V4 server-side prefix cache is shared across the
   * whole workflow instead of per-agent.
   */
  public getOrchestratorWorkingSet(currentFilePath = '', currentGitBranch = ''): { text: string; approxTokens: number } {
    const text = this.workingSetBuilder.buildWorkingSet(currentFilePath, currentGitBranch);
    return { text, approxTokens: estimateTokensFromText(text) };
  }

  public createSubagentContext(parentSessionId: string, subagentId: string): SubagentSessionContext {
    return this.fiberManager.createSubagentContext(parentSessionId, subagentId);
  }

  public stageSubagentMemory(subagentId: string, memoryInput: MemoryCreateInput): boolean {
    const before = this.fiberManager.getActiveContext(subagentId);
    if (!before) return false;
    this.fiberManager.stageMemory(subagentId, memoryInput);
    return true;
  }

  public mergeSubagentOnSuccess(subagentId: string): Promise<FiberMergeResult> {
    return this.fiberManager.mergeOnSuccess(subagentId);
  }

  public discardSubagentOnFailure(subagentId: string): void {
    this.fiberManager.discardOnFailure(subagentId);
  }

  /** Distill on demand (used by the deferred scheduler and external callers). */
  public async distillNow(sessionId: string, trajectory: TrajectoryStep[]): Promise<DistillSummary> {
    return this.distiller.distillSession({ id: sessionId, trajectory });
  }
}

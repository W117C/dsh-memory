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
import { DshEventAdapter } from '../adapter/dsh-adapter.js';
import { registerMemoryTools } from '../tools/index.js';
import { registerMemoryHttpApi } from '../api/memory-http.js';
import { TrajectoryDistiller } from '../pipeline/distiller.js';
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
  public workingSetBuilder!: WorkingSetBuilder;
  public injector!: NativeMemoryInjector;
  public distiller!: TrajectoryDistiller;
  public eventAdapter!: DshEventAdapter;

  constructor(ctx: Context, public config: MemoryConfig) {
    super(ctx, 'memory');

    this.ctx.effect(() => {
      // 1. Persistent storage & retrieval engines
      this.store = new MemoryStore(this.config);
      this.retriever = new HybridRetriever(this.store, this.config.retrieval);
      this.resolver = new ConflictResolver(this.store);
      this.workingSetBuilder = new WorkingSetBuilder(this.store, this.config.retrieval);
      const episodicMgr = new EpisodicMemoryManager(this.store);
      const proceduralMgr = new ProceduralMemoryManager(this.store);
      this.distiller = new TrajectoryDistiller(this.ctx, this.store, this.config.distillation, {
        resolver: this.resolver,
        episodicMgr,
        proceduralMgr
      });
      this.eventAdapter = new DshEventAdapter(this.ctx);
      this.consolidator = new MemoryConsolidator(this.ctx, this.store, this.retriever, this.resolver, {
        llmAssisted: this.config.consolidation.llmAssisted,
        similarityTopK: this.config.consolidation.similarityTopK,
        extractEntities: this.config.consolidation.extractEntities,
        llmProvider: this.config.distillation.llmProvider,
        model: this.config.distillation.distillModel
      });
      this.portability = new MemoryPortability(this.store, this.resolver);

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
            this.config.web.routePrefix
          )
        : undefined;

      // 5. Session lifecycle: bind, track, distill-on-dispose
      const unhookCreated = this.eventAdapter.onSessionCreated((session) => {
        this.injector.bindSession(session.id);
      });

      const unhookEvent = this.eventAdapter.onSessionEvent((session, event) => {
        this.eventAdapter.trackEvent(session.id, event);
      });

      const unhookDisposed = this.eventAdapter.onSessionDisposed((session) => {
        const context = this.eventAdapter.takeContext(session.id);
        this.workingSetBuilder.invalidateSession(session.id);
        this.injector.dropSession(session.id);

        if (this.config.distillation.autoDistillOnFinish && context) {
          this.distiller
            .distillSession({ id: session.id, trajectory: context.trajectory })
            .catch((err) => {
              this.ctx.logger('memory').warn('distillation failed:', err);
            });
        }
      });

      return () => {
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
}

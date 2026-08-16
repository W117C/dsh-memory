/**
 * Tool registration over the real dsh `tools` registry
 * (`@deepseek-ai/dsh-tools`).
 *
 * The registry is an OPTIONAL capability: under a surface that mounts no
 * agent plane the plugin still runs (storage, distillation, web panel) and
 * simply registers no model-visible tools. Registrations return disposers
 * that the Cordis effect owns, so stopping the plugin withdraws all four
 * tools from the next assembly.
 */
import type { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../storage/db.js';
import type { ConsolidationOutcome } from '../core/consolidator.js';
import type { MemoryCreateInput } from '../types/memory.js';
import { HybridRetriever } from '../core/hybrid-retriever.js';
import { EpisodicMemoryManager } from '../subsystems/episodic.js';
import { ProceduralMemoryManager } from '../subsystems/procedural.js';
import { createRememberTool } from './remember.js';
import { createRecallTool, RecallToolHooks } from './recall.js';
import { createReflectTool } from './reflect.js';
import { createForgetTool } from './forget.js';
import { getToolRegistry } from '../contracts/dsh.js';

export type RememberEngine = (input: MemoryCreateInput) => Promise<ConsolidationOutcome>;

export function registerMemoryTools(
  ctx: Context,
  store: MemoryStore,
  rememberEngine: RememberEngine,
  retriever: HybridRetriever,
  episodicMgr: EpisodicMemoryManager,
  proceduralMgr: ProceduralMemoryManager,
  recallHooks: RecallToolHooks = {}
): (() => void) | undefined {
  const registry = getToolRegistry(ctx);
  if (!registry) return undefined;

  const disposers = [
    registry.register(createRememberTool(rememberEngine)),
    registry.register(createRecallTool(retriever, recallHooks)),
    registry.register(createReflectTool(episodicMgr, proceduralMgr)),
    registry.register(createForgetTool(store))
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}

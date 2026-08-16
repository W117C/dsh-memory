/**
 * @dsh-plugins/memory — DeepSeek Harness (dsh) native cognitive memory plugin.
 *
 * Host entry. Load as a Cordis plugin / dsh bundle row:
 *
 * ```yaml
 * - id: memory
 *   name: '@dsh-plugins/memory'
 * ```
 *
 * The plugin consumes only optional dsh capabilities (`tools`,
 * `systemPrompt`, session events, `httpServer`, `llm`), so it boots on any
 * profile — web, headless, or bare — and degrades per missing surface.
 */
import { Context } from '@deepseek-ai/cordis';
import { MemoryConfig, DEFAULT_CONFIG } from './config.js';
import { MemoryService } from './core/service.js';

export * from './types/memory.js';
export * from './config.js';
export * from './core/service.js';
export * from './core/hybrid-retriever.js';
export * from './core/conflict-resolver.js';
export * from './core/working-set.js';
export * from './core/injection.js';
export * from './core/consolidator.js';
export * from './core/portability.js';
export * from './core/entity-extractor.js';
export * from './adapter/dsh-adapter.js';
export * from './api/memory-http.js';
export * from './ui/web-extension.js';
export * from './storage/db.js';

export const name = 'dsh-plugin-memory';
export const Config = MemoryConfig;

export function apply(ctx: Context, config: MemoryConfig = DEFAULT_CONFIG) {
  return ctx.plugin(MemoryService, config);
}

export default apply;

/**
 * Classical entity extraction for the memory knowledge graph
 * (Zep/Graphiti-style entity edges, deterministic and offline).
 *
 * Recognized surface forms, all language-neutral and cheap:
 * - backtick-quoted spans          `pnpm workspace`
 * - double-quoted terms            "strict mode"
 * - dotted keys                    config.package_manager
 * - file-ish paths                 apps/web/src/**, ./lib/engine.ts
 * - UPPER_SNAKE constants          SQLITE_VEC_LIMIT
 * - PascalCase type-ish tokens     VectorStore
 * - error signatures               ETIMEDOUT 5432 / TypeError
 *
 * Extraction is deliberately conservative: precision over recall. Every hit
 * becomes a `mentions` edge from the memory's anchor (entity_key when
 * present, else its record id) so the graph UI and relation queries see a
 * real topology instead of only `supersedes` chains.
 */
import { MemoryStore } from '../storage/db.js';
import { MemoryRecord } from '../types/memory.js';

const MAX_ENTITIES_PER_MEMORY = 12;

const PATTERNS: RegExp[] = [
  /`([^`\n]{2,64})`/g,
  /"([^"\n.]{2,64})"/g,
  /\b([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*){1,5})\b/g,
  /(?:^|[\s(])((?:\.?\/)?[\w-]+(?:\/[\w.*-]+){1,6})/g,
  /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g,
  /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g,
  /\b([A-Z][a-zA-Z]*Error|E[A-Z]{4,}(?:\s\d+)?)\b/g
];

export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim().replace(/[.,;:!?]+$/, '').trim();
      if (isPlausibleEntity(candidate)) {
        found.add(candidate);
        if (found.size >= MAX_ENTITIES_PER_MEMORY) break;
      }
    }
    if (found.size >= MAX_ENTITIES_PER_MEMORY) break;
  }
  return [...found];
}

function isPlausibleEntity(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  // Reject sentence fragments: quoted spans may carry short commands (up to
  // 6 words, each >= 2 chars); everything else must stay compact.
  const words = candidate.split(/\s+/);
  if (words.length > 6) return false;
  if (words.length > 1 && words.some((w) => w.length < 2)) return false;
  if (!/[a-zA-Z]/.test(candidate)) return false;
  if (candidate.length < 2 || candidate.length > 64) return false;
  return true;
}

/** Attach `mentions` edges for one memory's extracted entities. */
export function linkEntitiesForMemory(store: MemoryStore, memory: MemoryRecord): number {
  const anchor = memory.entity_key || memory.id;
  const text = [
    memory.content,
    memory.summary,
    memory.error_signature ?? '',
    memory.solution_code ?? ''
  ].join('\n');

  let linked = 0;
  for (const entity of extractEntities(text)) {
    if (entity === anchor) continue;
    store.addRelation({
      source_entity: anchor,
      relation: 'mentions',
      target_entity: entity,
      memory_id: memory.id,
      created_at: Date.now()
    });
    linked++;
  }
  return linked;
}

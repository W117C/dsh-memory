/**
 * Cognitive Memory System - Types & Interface Contracts
 */

export type MemoryScope = 'workspace' | 'global';

export type MemoryTier = 'semantic' | 'episodic' | 'procedural' | 'working';

export type MemoryCategory =
  | 'preference'     // User preferences & habits (e.g. language, tools)
  | 'architecture'   // Project architecture, tech stack, directory conventions
  | 'rule'           // Strict negative constraints & coding style rules
  | 'correction'     // User pushback → corrected behavior pairs (highest trust, user-authored)
  | 'post_mortem'    // Error debug retrospective & verified solutions
  | 'workflow'       // Reusable shell script workflows & command recipes
  | 'scratchpad';    // Working memory scratchpad / active turn state

export type MemoryStatus = 'tentative' | 'verified' | 'deprecated';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  tier: MemoryTier;
  category: MemoryCategory;
  status: MemoryStatus;
  content: string;               // Full markdown content
  summary: string;               // Compact summary for prompt injection
  entity_key?: string;           // Dot-separated unique key (e.g. "config.package_manager")
  topic_keywords?: string[];     // Write-side topic words (L2 LLM output or deterministic extraction); bridged into FTS + embedding so cold-vocabulary queries can match
  path_pattern: string;          // Monorepo file path glob (default: "*")
  error_signature?: string;      // Error pattern / keyword regex for post-mortems
  solution_code?: string;        // Working code / commands that resolved the issue
  git_branch?: string;           // Git branch context (e.g. "main", "feat/v2")
  git_commit?: string;           // Associated commit hash
  origin_cwd?: string;           // Project root recorded at write time ('*' = legacy/visible everywhere)
  verification_count: number;    // Number of successful reuses
  importance: number;            // 1.0 - 5.0
  access_count: number;          // Total hit count
  created_at: number;            // Timestamp in ms
  updated_at: number;            // Timestamp in ms
  last_accessed_at: number;      // Last retrieval timestamp in ms
  valid_from: number;            // Bi-temporal validity start
  invalid_at?: number | null;    // Bi-temporal validity end (null = active)
}

export interface MemoryCreateInput {
  /** Preserve a stable id on import/migration; must match the mem_* pattern. */
  id?: string;
  scope?: MemoryScope;
  tier: MemoryTier;
  category: MemoryCategory;
  content: string;
  summary?: string;
  entity_key?: string;
  topic_keywords?: string[];
  path_pattern?: string;
  error_signature?: string;
  solution_code?: string;
  git_branch?: string;
  git_commit?: string;
  importance?: number;
  status?: MemoryStatus;
  reason?: string;
}

export interface MemoryUpdateInput {
  content?: string;
  summary?: string;
  topic_keywords?: string[];
  path_pattern?: string;
  solution_code?: string;
  git_branch?: string;
  importance?: number;
  status?: MemoryStatus;
  invalid_at?: number | null;
}

export interface MemoryRelation {
  source_entity: string;
  relation: string;              // 'depends_on' | 'prohibits' | 'configures' | 'fixes' | 'supersedes'
  target_entity: string;
  memory_id?: string;
  created_at: number;
}

export interface RecallOptions {
  scope?: 'all' | MemoryScope;
  tier?: 'all' | MemoryTier;
  category?: MemoryCategory;
  currentFilePath?: string;
  currentGitBranch?: string;
  topK?: number;
  minScore?: number;
  includeTentative?: boolean;
}

export interface ScoredMemory {
  memory: MemoryRecord;
  score: number;
  breakdown: {
    vectorScore: number;
    bm25Score: number;
    recencyScore: number;
    importanceScore: number;
  };
}

export interface MemoryStats {
  total: number;
  byTier: Record<MemoryTier, number>;
  byStatus: Record<MemoryStatus, number>;
  byScope: Record<MemoryScope, number>;
  vectorEngineMode: 'sqlite-vec' | 'js-float32' | 'bm25-only';
  databasePath: string;
}

export type MemoryHistoryEvent = 'created' | 'updated' | 'deleted' | 'promoted' | 'deprecated';

/** One durable change-log entry (mem0-style memory history, bi-temporal audit trail). */
export interface MemoryHistoryRecord {
  id: number;
  memory_id: string;
  event: MemoryHistoryEvent;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  created_at: number;
}

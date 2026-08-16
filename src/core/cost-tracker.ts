/**
 * Cost observability: a durable ledger of every memory-attributed LLM token
 * (distillation, consolidation, remote embedding, prompt injection), priced
 * against the DeepSeek-V4 peak/off-peak tariff active at record time.
 *
 * Records whose token counts come from char-based estimation rather than an
 * API usage payload are flagged `estimated` so the panel can label them.
 */
import type Database from 'better-sqlite3';
import { estimateCostUsd, estimateTokensFromText } from './peak-pricing.js';

export type CostPurpose = 'distill' | 'consolidate' | 'embed-remote' | 'injection' | 'query-rewrite';

export interface UsageRecordInput {
  model: string;
  purpose: CostPurpose;
  hitTokens?: number;
  missTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
  sessionId?: string;
  meta?: Record<string, unknown>;
}

export interface CostReport {
  sinceDays: number;
  totalUsd: number;
  totalTokens: { hit: number; miss: number; output: number };
  estimatedTokenShare: number;
  byPurpose: Array<{
    purpose: CostPurpose;
    calls: number;
    usd: number;
    tokens: { hit: number; miss: number; output: number };
  }>;
  byModel: Array<{ model: string; calls: number; usd: number }>;
}

export class CostTracker {
  constructor(private db: Database.Database) {
    this.db.exec('CREATE TABLE IF NOT EXISTS llm_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN (\'distill\', \'consolidate\', \'embed-remote\', \'injection\', \'query-rewrite\')), hit_tokens INTEGER DEFAULT 0, miss_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, estimated INTEGER DEFAULT 0, session_id TEXT, meta_json TEXT, cost_usd REAL NOT NULL, created_at INTEGER NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_time ON llm_usage(created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_purpose ON llm_usage(purpose, created_at)');
  }

  public record(input: UsageRecordInput): void {
    const costUsd = estimateCostUsd(input.model, {
      hitTokens: input.hitTokens,
      missTokens: input.missTokens,
      outputTokens: input.outputTokens
    });
    this.db.prepare(`
      INSERT INTO llm_usage
        (model, purpose, hit_tokens, miss_tokens, output_tokens, estimated, session_id, meta_json, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.model,
      input.purpose,
      input.hitTokens ?? 0,
      input.missTokens ?? 0,
      input.outputTokens ?? 0,
      input.estimated ? 1 : 0,
      input.sessionId ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      costUsd,
      Date.now()
    );
  }

  /** Convenience for call sites without a metered usage payload. */
  public recordEstimatedText(
    model: string,
    purpose: CostPurpose,
    inputText: string,
    outputText: string,
    sessionId?: string
  ): void {
    this.record({
      model,
      purpose,
      missTokens: estimateTokensFromText(inputText),
      outputTokens: estimateTokensFromText(outputText),
      estimated: true,
      sessionId
    });
  }

  public getReport(sinceDays = 7): CostReport {
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT * FROM llm_usage WHERE created_at >= ? ORDER BY id
    `).all(cutoff) as Array<{
      model: string;
      purpose: CostPurpose;
      hit_tokens: number;
      miss_tokens: number;
      output_tokens: number;
      estimated: number;
      cost_usd: number;
    }>;

    const totalTokens = { hit: 0, miss: 0, output: 0 };
    let estimatedTokens = 0;
    const purposeMap = new Map<
      CostPurpose,
      { purpose: CostPurpose; calls: number; usd: number; tokens: { hit: number; miss: number; output: number } }
    >();
    const modelMap = new Map<string, { model: string; calls: number; usd: number }>();
    let totalUsd = 0;

    for (const row of rows) {
      totalUsd += row.cost_usd;
      totalTokens.hit += row.hit_tokens;
      totalTokens.miss += row.miss_tokens;
      totalTokens.output += row.output_tokens;
      if (row.estimated) {
        estimatedTokens += row.hit_tokens + row.miss_tokens + row.output_tokens;
      }

      const p = purposeMap.get(row.purpose) ?? {
        purpose: row.purpose,
        calls: 0,
        usd: 0,
        tokens: { hit: 0, miss: 0, output: 0 }
      };
      p.calls++;
      p.usd += row.cost_usd;
      p.tokens.hit += row.hit_tokens;
      p.tokens.miss += row.miss_tokens;
      p.tokens.output += row.output_tokens;
      purposeMap.set(row.purpose, p);

      const m = modelMap.get(row.model) ?? { model: row.model, calls: 0, usd: 0 };
      m.calls++;
      m.usd += row.cost_usd;
      modelMap.set(row.model, m);
    }

    const allTokens = totalTokens.hit + totalTokens.miss + totalTokens.output;

    return {
      sinceDays,
      totalUsd: round4(totalUsd),
      totalTokens,
      estimatedTokenShare: allTokens === 0 ? 0 : round4(estimatedTokens / allTokens),
      byPurpose: [...purposeMap.values()].map((p) => ({ ...p, usd: round4(p.usd) })),
      byModel: [...modelMap.values()].map((m) => ({ ...m, usd: round4(m.usd) }))
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

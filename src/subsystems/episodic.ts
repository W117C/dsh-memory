import { MemoryStore } from '../storage/db.js';
import { MemoryRecord } from '../types/memory.js';
import { extractErrorFingerprint } from '../core/error-fingerprint.js';

export interface PostMortemInput {
  errorSignature: string;
  rootCause: string;
  solutionCode: string;
  affectedFiles?: string;
  importance?: number;
}

export class EpisodicMemoryManager {
  constructor(private store: MemoryStore) {}

  public async recordPostMortem(input: PostMortemInput): Promise<MemoryRecord> {
    const fp = extractErrorFingerprint(input.errorSignature);
    const summary = `Fix: ${fp.normalizedSignature} -> ${input.rootCause}`.slice(0, 120);
    const content = `### Error Pattern\n\`\`\`\n${input.errorSignature}\n\`\`\`\n\n### Error Fingerprint\n${fp.normalizedSignature}\n\n### Root Cause\n${input.rootCause}\n\n### Working Solution\n\`\`\`\n${input.solutionCode}\n\`\`\``;

    return this.store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content,
      summary,
      error_signature: fp.normalizedSignature,
      solution_code: input.solutionCode,
      importance: input.importance ?? 4.0,
      status: 'tentative'
    });
  }

  public getRecentPostMortems(limit = 10): MemoryRecord[] {
    const now = Date.now();
    const stmt = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'episodic' AND category = 'post_mortem' AND (invalid_at IS NULL OR invalid_at > ?)
      ORDER BY last_accessed_at DESC, created_at DESC
      LIMIT ?
    `);
    return stmt.all(now, limit) as MemoryRecord[];
  }
}

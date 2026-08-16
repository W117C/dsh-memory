/**
 * MemoryConsolidator — the mem0-class write path.
 *
 * When a new fact arrives, retrieve the most similar ACTIVE memories and let
 * the DeepSeek-V4 route (through the same `ctx.llm` adapter registry the
 * harness uses) decide, per candidate, the canonical action set:
 *
 *   ADD     — the fact is new, create a record
 *   UPDATE  — an existing record's content is refined (history logs the diff)
 *   DELETE  — an existing record is now obsolete (bi-temporal deprecate)
 *   NONE    — no change for that candidate
 *
 * The deterministic ConflictResolver remains the fallback: no `llm` service,
 * disabled via config, or any LLM error routes through it, so writes NEVER
 * fail because consolidation was unavailable.
 */
import type { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../storage/db.js';
import { ConflictResolver, ConflictResolutionResult } from './conflict-resolver.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { linkEntitiesForMemory } from './entity-extractor.js';
import { MemoryCreateInput, MemoryRecord } from '../types/memory.js';
import { getLlmService, LlmStreamService } from '../pipeline/distiller.js';

export interface ConsolidationConfig {
  llmAssisted: boolean;
  similarityTopK: number;
  extractEntities: boolean;
  llmProvider: string;
  model: string;
}

export interface ConsolidationDecision {
  memory_id: string;
  action: 'UPDATE' | 'DELETE' | 'NONE';
  new_value?: string;
  reason?: string;
}

export interface ConsolidationOutcome extends ConflictResolutionResult {
  /** mem0-style event list: every action the consolidation actually took. */
  events: string[];
  engine: 'deterministic' | 'llm-assisted';
}

const CONSOLIDATE_SYSTEM = `You are a memory consolidation engine for a coding agent.
Given a NEW FACT and CANDIDATE existing memories, decide how the store must change.
Respond with strictly valid JSON only:
{"add": boolean, "decisions": [{"memory_id": string, "action": "UPDATE"|"DELETE"|"NONE", "new_value"?: string, "reason"?: string}]}
Rules:
- UPDATE when the candidate is the same subject and the new fact refines it; set new_value to the merged text.
- DELETE when the candidate is contradicted or made obsolete by the new fact.
- NONE when unrelated. Prefer few edits. add=true only when no candidate covers the fact.`;

export class MemoryConsolidator {
  constructor(
    private ctx: Context,
    private store: MemoryStore,
    private retriever: HybridRetriever,
    private resolver: ConflictResolver,
    private config: ConsolidationConfig
  ) {}

  public async consolidate(input: MemoryCreateInput): Promise<ConsolidationOutcome> {
    const llm = this.config.llmAssisted ? getLlmService(this.ctx) : undefined;
    if (llm) {
      try {
        const outcome = await this.consolidateWithLlm(input, llm);
        if (outcome) return outcome;
      } catch (err) {
        this.ctx.logger('memory').warn('LLM consolidation failed, falling back to deterministic:', err);
      }
    }
    return this.deterministic(input);
  }

  private async deterministic(input: MemoryCreateInput): Promise<ConsolidationOutcome> {
    const result = await this.resolver.resolveAndApply(input);
    const events: string[] = [result.action];
    if (result.action === 'ADD' || result.action === 'OVERWRITE') {
      const created = this.store.getMemoryById(result.memoryId);
      if (created && this.config.extractEntities) {
        linkEntitiesForMemory(this.store, created);
      }
    }
    return { ...result, events, engine: 'deterministic' };
  }

  private async consolidateWithLlm(
    input: MemoryCreateInput,
    llm: LlmStreamService
  ): Promise<ConsolidationOutcome | null> {
    const candidates = await this.retriever.retrieve(input.content, {
      topK: this.config.similarityTopK,
      includeTentative: true
    });

    if (candidates.length === 0) {
      // Nothing to reconcile — plain deterministic add.
      return this.deterministic(input);
    }

    const candidateBlock = candidates
      .map(
        (c) =>
          `- id=${c.memory.id} status=${c.memory.status} entity=${c.memory.entity_key ?? '-'} score=${c.score.toFixed(2)}
  content: ${c.memory.content.slice(0, 400)}`
      )
      .join('\n');

    const prompt = `NEW FACT:\n${input.content}\n\nCANDIDATE MEMORIES:\n${candidateBlock}`;

    let text = '';
    for await (const chunk of llm.stream({
      provider: this.config.llmProvider,
      model: this.config.model,
      system: CONSOLIDATE_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024
    })) {
      if (chunk.type === 'text-delta') {
        text += (chunk as { text?: string }).text ?? '';
      }
    }

    const parsed = this.parseJsonLoose(text);
    if (!parsed || !Array.isArray(parsed.decisions)) return null;

    const events: string[] = [];
    let updated: MemoryRecord | null = null;
    const now = Date.now();

    for (const raw of parsed.decisions) {
      const decision = raw as ConsolidationDecision;
      if (!decision || typeof decision.memory_id !== 'string') continue;
      const target = this.store.getMemoryById(decision.memory_id);
      if (!target || (target.invalid_at && target.invalid_at <= now)) continue;

      if (decision.action === 'UPDATE' && typeof decision.new_value === 'string' && decision.new_value.trim()) {
        updated = this.store.updateMemory(target.id, {
          content: decision.new_value,
          status: target.status === 'verified' ? 'verified' : target.status
        });
        events.push(`UPDATE:${target.id}`);
      } else if (decision.action === 'DELETE') {
        this.store.updateMemory(target.id, {
          status: 'deprecated',
          invalid_at: now
        });
        events.push(`DELETE:${target.id}`);
      }
    }

    let memoryId = updated?.id ?? candidates[0].memory.id;
    if (parsed.add === true) {
      const created = await this.store.createMemory(input);
      memoryId = created.id;
      events.push('ADD');
      if (this.config.extractEntities) {
        linkEntitiesForMemory(this.store, created);
      }
    }

    return {
      action: events.some((e) => e.startsWith('UPDATE') || e.startsWith('DELETE'))
        ? events.includes('ADD') ? 'OVERWRITE' : 'UPDATE'
        : events.includes('ADD') ? 'ADD' : 'IGNORE',
      memoryId,
      reason: `LLM consolidation: ${events.join(', ') || 'no change'}`,
      events,
      engine: 'llm-assisted'
    };
  }

  private parseJsonLoose(text: string): { add?: boolean; decisions?: unknown } | null {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

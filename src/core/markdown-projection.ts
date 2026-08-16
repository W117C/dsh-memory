/**
 * Markdown projection — the human-readable view over the SQLite source of
 * truth (the Claude-Code MEMORY.md experience, on top of a queryable store).
 *
 * exportMarkdown() renders `MEMORY.md` (one index line per memory) plus one
 * frontmatter document per memory under `memories/<slug>.md`.
 * importMarkdown() parses those documents back and applies idempotent
 * upserts: existing ids are updated only when content actually changed,
 * unknown ids are created with their id preserved.
 */
import { MemoryStore, mapRowToRecord } from '../storage/db.js';
import { MemoryRecord } from '../types/memory.js';

export interface MarkdownExportOptions {
  includeDeprecated?: boolean;
  scope?: 'workspace' | 'global';
}

export interface MarkdownExport {
  /** file path → file content (includes `MEMORY.md` itself). */
  files: Record<string, string>;
  count: number;
}

export interface MarkdownImportSummary {
  processed: number;
  added: number;
  updated: number;
  unchanged: number;
  invalid: number;
}

const ID_PATTERN = /^mem_[A-Za-z0-9_-]{1,120}$/;

export class MarkdownProjection {
  constructor(private store: MemoryStore) {}

  public exportMarkdown(options: MarkdownExportOptions = {}): MarkdownExport {
    const now = Date.now();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!options.includeDeprecated) {
      conditions.push('(invalid_at IS NULL OR invalid_at > ?)');
      params.push(now);
      conditions.push(`status != 'deprecated'`);
    }
    if (options.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = (this.store.getDb()
      .prepare(`SELECT * FROM memories ${where} ORDER BY scope, tier, importance DESC, created_at ASC`)
      .all(...params) as MemoryRecord[]).map((r) => mapRowToRecord(r));

    const files: Record<string, string> = {};
    const indexLines: string[] = [
      '# Memory Projection (@dsh-plugins/memory)',
      '',
      `> Exported ${new Date().toISOString()} • ${rows.length} memories • SQLite is the source of truth; edit here and import back.`,
      ''
    ];

    const slugCounts = new Map<string, number>();
    for (const mem of rows) {
      const slug = uniqueSlug(slugCounts, mem);
      const path = `memories/${slug}.md`;
      files[path] = this.renderMemoryDoc(mem);
      indexLines.push(
        `- [${escapeMd(titleOf(mem))}](memories/${slug}.md) — ${mem.category} • ${mem.status} • ${mem.scope} • ★${mem.importance.toFixed(1)}`
      );
    }

    if (rows.length === 0) {
      indexLines.push('_(no active memories)_');
    }

    files['MEMORY.md'] = indexLines.join('\n') + '\n';
    return { files, count: rows.length };
  }

  private renderMemoryDoc(mem: MemoryRecord): string {
    const fm: string[] = ['---'];
    fm.push(`id: ${mem.id}`);
    fm.push(`tier: ${mem.tier}`);
    fm.push(`category: ${mem.category}`);
    fm.push(`status: ${mem.status}`);
    fm.push(`scope: ${mem.scope}`);
    fm.push(`importance: ${mem.importance}`);
    if (mem.entity_key) fm.push(`entity_key: ${mem.entity_key}`);
    if (mem.topic_keywords?.length) fm.push(`topics: "${escapeFm(mem.topic_keywords.join(', '))}"`);
    fm.push(`path_pattern: "${mem.path_pattern}"`);
    fm.push(`git_branch: "${mem.git_branch ?? '*'}"`);
    if (mem.error_signature) fm.push(`error_signature: "${escapeFm(mem.error_signature)}"`);
    fm.push(`created_at: ${new Date(mem.created_at).toISOString()}`);
    fm.push(`updated_at: ${new Date(mem.updated_at).toISOString()}`);
    fm.push('---', '');

    const body: string[] = [];
    body.push(mem.content, '');
    if (mem.summary && mem.summary !== mem.content.slice(0, 120)) {
      body.push('## Summary', '', mem.summary, '');
    }
    if (mem.solution_code) {
      body.push('## Solution', '', '```', mem.solution_code, '```', '');
    }
    return fm.join('\n') + body.join('\n');
  }

  /**
   * Import a projection back. Accepts either a file map (as produced by
   * exportMarkdown) or a single concatenated document.
   */
  public async importMarkdown(input: Record<string, string> | string): Promise<MarkdownImportSummary> {
    const docs: string[] = [];
    if (typeof input === 'string') {
      docs.push(...input.split(/\n(?=---\n)/));
    } else {
      for (const [path, content] of Object.entries(input)) {
        if (path === 'MEMORY.md') continue;
        docs.push(content);
      }
    }

    const summary: MarkdownImportSummary = { processed: 0, added: 0, updated: 0, unchanged: 0, invalid: 0 };

    for (const doc of docs) {
      const parsed = parseMemoryDoc(doc);
      if (!parsed) {
        if (doc.trim()) summary.invalid++;
        continue;
      }
      summary.processed++;

      const existing = this.store.getMemoryById(parsed.id);
      if (!existing) {
        await this.store.createMemory({
          id: parsed.id,
          scope: parsed.scope,
          tier: parsed.tier,
          category: parsed.category,
          status: parsed.status,
          content: parsed.content,
          summary: parsed.summary,
          entity_key: parsed.entity_key,
          topic_keywords: parsed.topic_keywords,
          path_pattern: parsed.path_pattern,
          error_signature: parsed.error_signature,
          solution_code: parsed.solution_code,
          git_branch: parsed.git_branch,
          importance: parsed.importance,
          reason: 'markdown-import'
        });
        summary.added++;
        continue;
      }

      const changed =
        existing.content !== parsed.content ||
        existing.summary !== parsed.summary ||
        (existing.solution_code ?? undefined) !== parsed.solution_code ||
        existing.importance !== parsed.importance ||
        existing.status !== parsed.status ||
        (existing.topic_keywords?.join(',') ?? '') !== (parsed.topic_keywords?.join(',') ?? '');

      if (!changed) {
        summary.unchanged++;
        continue;
      }

      this.store.updateMemory(parsed.id, {
        content: parsed.content,
        summary: parsed.summary,
        solution_code: parsed.solution_code,
        topic_keywords: parsed.topic_keywords,
        importance: parsed.importance,
        status: parsed.status,
        error_signature: parsed.error_signature,
        reason: 'markdown-import'
      });
      summary.updated++;
    }

    return summary;
  }
}

interface ParsedMemoryDoc {
  id: string;
  scope: 'workspace' | 'global';
  tier: MemoryRecord['tier'];
  category: MemoryRecord['category'];
  status: MemoryRecord['status'];
  importance: number;
  entity_key?: string;
  topic_keywords?: string[];
  path_pattern: string;
  git_branch?: string;
  error_signature?: string;
  content: string;
  summary?: string;
  solution_code?: string;
}

export function parseMemoryDoc(doc: string): ParsedMemoryDoc | null {
  const match = doc.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fm = parseFrontmatter(match[1]);
  const id = String(fm.id ?? '');
  if (!ID_PATTERN.test(id)) return null;

  const body = match[2] ?? '';
  const solutionBlock = body.match(/## Solution\n\n```\n([\s\S]*?)\n```/);
  const summaryBlock = body.match(/## Summary\n\n([\s\S]*?)(?=\n## Solution\n|\n*$)/);
  let content = body;
  if (summaryBlock) content = content.replace(summaryBlock[0], '');
  if (solutionBlock) content = content.replace(solutionBlock[0], '');
  content = content.trim();
  if (!content) return null;

  const tier = String(fm.tier ?? 'semantic') as ParsedMemoryDoc['tier'];
  if (!['semantic', 'episodic', 'procedural', 'working'].includes(tier)) return null;
  const status = String(fm.status ?? 'tentative') as ParsedMemoryDoc['status'];
  if (!['tentative', 'verified', 'deprecated'].includes(status)) return null;

  return {
    id,
    scope: fm.scope === 'global' ? 'global' : 'workspace',
    tier,
    category: String(fm.category ?? 'rule') as ParsedMemoryDoc['category'],
    status,
    importance: Number(fm.importance ?? 1) || 1,
    entity_key: fm.entity_key ? String(fm.entity_key) : undefined,
    topic_keywords: fm.topics ? String(fm.topics).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    path_pattern: fm.path_pattern ? String(fm.path_pattern) : '*',
    git_branch: fm.git_branch ? String(fm.git_branch) : '*',
    error_signature: fm.error_signature ? String(fm.error_signature) : undefined,
    content,
    summary: summaryBlock ? summaryBlock[1].trim() : undefined,
    solution_code: solutionBlock ? solutionBlock[1] : undefined
  };
}

function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

function titleOf(mem: MemoryRecord): string {
  if (mem.entity_key) return mem.entity_key;
  return mem.summary.slice(0, 60) || mem.content.slice(0, 60);
}

function uniqueSlug(counts: Map<string, number>, mem: MemoryRecord): string {
  const base = (mem.entity_key || mem.summary || mem.id)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || mem.id;
  const n = counts.get(base) ?? 0;
  counts.set(base, n + 1);
  return n === 0 ? base : `${base}-${n + 1}`;
}

function escapeMd(s: string): string {
  return s.replace(/[\[\]]/g, '');
}

function escapeFm(s: string): string {
  return s.replace(/"/g, "'");
}

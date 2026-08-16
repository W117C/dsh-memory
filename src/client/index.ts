/**
 * Browser half of @dsh-plugins/memory — the native dsh web panel.
 *
 * Shipped as the package's `./client` export: a CJS factory bundle the dsh
 * client module system registers through `window.__ModuleLoader__.load`
 * (declared via the `dsh.client` manifest field, `platform: 'web'`). This is
 * the SAME surface the shipped browser roster (sidebar, settings, …) is
 * built on — no iframe, no external server, no second web app.
 *
 * The panel registers into the `settings.section` slot (the entry point the
 * dsh slot standard designates for full settings UIs) and talks to the host
 * half through the same-origin `/api/memory` route this plugin registered on
 * the dsh webserver.
 */
import React from 'react';

/** Structural face of the client slots service (`@deepseek-ai/dsh-client-ui-slots`). */
interface SlotsService {
  inject(slot: string, callback: () => unknown): unknown;
  register(target: { name: string; key?: string }, component: React.ComponentType<any>): unknown;
}

interface ClientContext {
  get(name: string): unknown;
  effect?(setup: () => (() => void) | void): (() => void) | void;
}

export const name = 'dsh-plugin-memory-client';

const STYLE_ELEMENT_ID = 'dsh-plugin-memory-client-styles';
const PANEL_CSS = `
.dsh-memory-panel { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.dsh-memory-title { margin: 0; font-size: 16px; font-weight: 600; }
.dsh-memory-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.dsh-memory-card { border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: 10px 12px; }
.dsh-memory-card-value { font-size: 18px; font-weight: 700; }
.dsh-memory-card-label { opacity: .65; margin-top: 2px; }
.dsh-memory-search { display: flex; gap: 8px; }
.dsh-memory-input { flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; }
.dsh-memory-button { padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
.dsh-memory-button:hover { background: rgba(127,127,127,.15); }
.dsh-memory-button-danger:hover { background: rgba(220,60,60,.2); }
.dsh-memory-toolbar { display: flex; gap: 6px; }
.dsh-memory-tab { border-radius: 999px; padding: 3px 12px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
.dsh-memory-tab.is-active { background: rgba(90,130,255,.25); }
.dsh-memory-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 380px; overflow-y: auto; }
.dsh-memory-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; border: 1px solid rgba(127,127,127,.25); border-radius: 8px; padding: 8px 10px; }
.dsh-memory-item-main { min-width: 0; overflow-wrap: anywhere; }
.dsh-memory-item-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dsh-memory-badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.dsh-memory-verified { background: rgba(60,170,90,.2); color: #3faa5a; }
.dsh-memory-tentative { background: rgba(210,153,34,.2); color: #c99a2e; }
.dsh-memory-deprecated { background: rgba(150,150,150,.2); color: #999; }
.dsh-memory-empty, .dsh-memory-error { opacity: .7; }
.dsh-memory-error { color: #d66; }
`;

/**
 * Style injection lives in the factory closure per the dsh client module
 * contract ("every module body side effect — CSS injection included — runs at
 * materialization"), id-guarded so re-materialization cannot duplicate tags.
 * Colors stay neutral/alpha-based so the shell theme shows through.
 */
function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

export function apply(ctx: ClientContext): void {
  ensureStyles();
  const slots = ctx.get('slots') as SlotsService | undefined;
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    return;
  }

  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', key: 'memory' },
      MemorySettingsSection
    )
  );
}

// ── data layer ───────────────────────────────────────────────────────────────

interface MemoryStatsView {
  total: number;
  byStatus: Record<string, number>;
  byTier: Record<string, number>;
  vectorEngineMode: string;
  databasePath?: string;
}

interface MemoryItemView {
  id: string;
  tier: string;
  category: string;
  status: string;
  entity_key?: string;
  summary: string;
  importance: number;
  verification_count: number;
  updated_at: number;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`memory api ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// ── panel component ─────────────────────────────────────────────────────────

function MemorySettingsSection(): React.ReactElement {
  const [stats, setStats] = React.useState<MemoryStatsView | null>(null);
  const [memories, setMemories] = React.useState<MemoryItemView[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<'tentative' | 'verified' | 'all'>('tentative');
  const [query, setQuery] = React.useState('');
  const [recallResults, setRecallResults] = React.useState<Array<{ id: string; summary: string; score: number; status: string }> | null>(null);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    try {
      const [nextStats, nextMemories] = await Promise.all([
        fetchJson<MemoryStatsView>('/api/memory/stats'),
        fetchJson<MemoryItemView[]>(`/api/memory/memories?status=${statusFilter}&limit=200`)
      ]);
      setStats(nextStats);
      setMemories(nextMemories);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [statusFilter]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const review = React.useCallback(
    async (id: string, action: 'promote' | 'deprecate') => {
      await fetchJson(`/api/memory/memories/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      await refresh();
    },
    [refresh]
  );

  const runRecall = React.useCallback(async () => {
    if (!query.trim()) return;
    const body = await fetchJson<{ results: Array<{ id: string; summary: string; score: number; status: string }> }>(
      '/api/memory/recall',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() })
      }
    );
    setRecallResults(body.results);
  }, [query]);

  return React.createElement(
    'div',
    { className: 'dsh-memory-panel' },

    React.createElement('h2', { className: 'dsh-memory-title' }, '记忆系统 / Memory'),

    error
      ? React.createElement('div', { className: 'dsh-memory-error' }, `面板后端不可用: ${error}`)
      : null,

    stats
      ? React.createElement(
          'div',
          { className: 'dsh-memory-cards' },
          statCard(String(stats.total), '总记忆'),
          statCard(String(stats.byStatus.verified ?? 0), '已验证'),
          statCard(String(stats.byStatus.tentative ?? 0), '观察期'),
          statCard(stats.vectorEngineMode, '向量引擎')
        )
      : null,

    React.createElement(
      'div',
      { className: 'dsh-memory-search' },
      React.createElement('input', {
        className: 'dsh-memory-input',
        value: query,
        placeholder: '语义检索记忆（错误签名 / 规则 / 配方）…',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter') void runRecall();
        }
      }),
      React.createElement(
        'button',
        { className: 'dsh-memory-button', onClick: () => void runRecall() },
        '检索'
      )
    ),

    recallResults
      ? React.createElement(
          'ul',
          { className: 'dsh-memory-list' },
          recallResults.length === 0
            ? React.createElement('li', { className: 'dsh-memory-empty' }, '无匹配记忆')
            : recallResults.map((r) =>
                React.createElement(
                  'li',
                  { key: r.id, className: 'dsh-memory-item' },
                  React.createElement('span', { className: `dsh-memory-badge dsh-memory-${r.status}` }, r.status),
                  ` ${r.summary} (${r.score})`
                )
              )
        )
      : null,

    React.createElement(
      'div',
      { className: 'dsh-memory-toolbar' },
      (['tentative', 'verified', 'all'] as const).map((value) =>
        React.createElement(
          'button',
          {
            key: value,
            className: `dsh-memory-tab ${statusFilter === value ? 'is-active' : ''}`,
            onClick: () => setStatusFilter(value)
          },
          value === 'tentative' ? '待审核' : value === 'verified' ? '黄金法则' : '全部'
        )
      )
    ),

    React.createElement(
      'ul',
      { className: 'dsh-memory-list' },
      memories.length === 0
        ? React.createElement('li', { className: 'dsh-memory-empty' }, '（空）')
        : memories.map((mem) =>
            React.createElement(
              'li',
              { key: mem.id, className: 'dsh-memory-item' },
              React.createElement(
                'div',
                { className: 'dsh-memory-item-main' },
                React.createElement('span', { className: `dsh-memory-badge dsh-memory-${mem.status}` }, mem.status),
                ` ${mem.entity_key ? `${mem.entity_key}: ` : ''}${mem.summary}`
              ),
              React.createElement(
                'div',
                { className: 'dsh-memory-item-actions' },
                mem.status !== 'verified'
                  ? React.createElement(
                      'button',
                      { className: 'dsh-memory-button', onClick: () => void review(mem.id, 'promote') },
                      '✓ 验证'
                    )
                  : null,
                mem.status !== 'deprecated'
                  ? React.createElement(
                      'button',
                      {
                        className: 'dsh-memory-button dsh-memory-button-danger',
                        onClick: () => void review(mem.id, 'deprecate')
                      },
                      '✕ 废弃'
                    )
                  : null
              )
            )
          )
    )
  );
}

function statCard(value: string, label: string): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'dsh-memory-card' },
    React.createElement('div', { className: 'dsh-memory-card-value' }, value),
    React.createElement('div', { className: 'dsh-memory-card-label' }, label)
  );
}

export default apply;

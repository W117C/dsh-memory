#!/usr/bin/env node
/**
 * P3 long-memory mini benchmark (LongMemEval-flavored, self-authored subset).
 *
 * Unlike recall-quality (single-hop "resurface the trap"), these questions
 * require TWO memories to answer (multi-hop / cross-entity), measuring
 * both-gold coverage@k of the hybrid retriever over one shared corpus.
 * Deterministic: retrieval-only, no LLM needed for scoring.
 *
 * Usage: node evals/longmem-mini.mjs [--topics] [--rewrite] [--json out.json]
 *
 * --topics: seed each corpus memory with write-side topic_keywords (what the
 * L2 distiller emits at write time). Cold-vocabulary questions paraphrase the
 * memory body ("测试框架崩溃" for `vitest crash`), so the synonym bridge words
 * can only come from the write side — deterministic L1 extraction cannot
 * invent them. This quantifies the write-side topic-completion payoff.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MemoryStore } = await import(path.join(root, 'dist/storage/db.js'));
const { HybridRetriever } = await import(path.join(root, 'dist/core/hybrid-retriever.js'));
const { DEFAULT_CONFIG } = await import(path.join(root, 'dist/config.js'));

const WITH_TOPICS = process.argv.includes('--topics');

const CORPUS = [
  { id: 'mem_a_pg', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'db.port', content: 'A 项目数据库连接走 pgbouncer 6432 端口', summary: 'A 项目 db 6432', importance: 4, status: 'verified', topics: ['数据库', 'db', '端口', 'pgbouncer', 'postgres'] },
  { id: 'mem_b_pg', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'db.port', content: 'B 项目数据库直连 5432 端口', summary: 'B 项目 db 5432', importance: 4, status: 'verified', topics: ['数据库', 'db', '端口', '5432', 'postgres'] },
  { id: 'mem_pkg_pnpm', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'config.package_manager', content: '统一使用 pnpm 安装依赖', summary: 'pnpm only', importance: 5, status: 'verified', topics: ['依赖', '安装', 'pnpm', 'package', '包管理'] },
  { id: 'mem_pkg_node', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'config.node_version', content: 'Node 版本锁定 22 LTS，以 .nvmrc 为准', summary: 'node 22 nvmrc', importance: 3.5, status: 'verified', topics: ['node', '版本', 'lts', 'nvmrc', '运行时'] },
  { id: 'mem_err_jest', tier: 'episodic', category: 'post_mortem', error_signature: 'jest timeout', solution_code: 'pnpm test -- --retryTimes=2', content: 'jest 超时的解法是重试参数', summary: 'jest retry', importance: 4.5, status: 'verified', topics: ['jest', '测试', '超时', 'timeout', 'retry', '单测'] },
  { id: 'mem_err_vitest', tier: 'episodic', category: 'post_mortem', error_signature: 'vitest crash', solution_code: 'downgrade to vitest 1.2', content: 'vitest 1.3 UI 崩溃需降级', summary: 'vitest downgrade', importance: 3, status: 'verified', topics: ['vitest', '测试', '框架', '崩溃', 'crash', 'UI'] },
  { id: 'mem_auth_jwt', tier: 'semantic', category: 'correction', scope: 'global', entity_key: 'correction.auth', content: '用户纠正：wrong, we use JWT\n修正后的行为：auth 一律 JWT', summary: '纠错: auth 用 JWT', importance: 4.5, status: 'verified', topics: ['auth', '认证', 'jwt', 'token', '登录'] },
  { id: 'mem_auth_refresh', tier: 'semantic', category: 'architecture', entity_key: 'auth.refresh', content: 'token 刷新端点是 /auth/refresh，滑动过期 7 天', summary: 'refresh endpoint 7d', importance: 4, status: 'verified', topics: ['auth', '认证', 'token', '刷新', 'refresh', '过期'] },
  { id: 'mem_rel_beta', tier: 'procedural', category: 'workflow', entity_key: 'workflow.release_beta', solution_code: 'pnpm version prerelease && pnpm publish --tag beta', content: 'beta 发布两步走', summary: 'beta release steps', importance: 4, status: 'verified', topics: ['发布', 'beta', '预发布', '版本', 'publish'] },
  { id: 'mem_rel_prod', tier: 'procedural', category: 'workflow', entity_key: 'workflow.release_prod', solution_code: 'pnpm publish --tag latest && git tag v*', content: '正式发布要打 git tag', summary: 'prod release + tag', importance: 4, status: 'verified', topics: ['发布', '正式', 'git', 'tag', '版本', '生产'] },
  { id: 'mem_ci_green', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'ci.merge', content: 'CI 全绿才能合并分支', summary: 'ci green merge', importance: 4, status: 'verified', topics: ['ci', '流水线', '合并', 'merge', '构建'] },
  { id: 'mem_ci_flaky', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'ci.flaky_policy', content: 'CI 上的 flaky 测试先 quarantine 再修', summary: 'flaky quarantine', importance: 3.5, status: 'verified', topics: ['ci', '流水线', 'flaky', '测试', '隔离', 'quarantine'] },
  { id: 'mem_doc_zh', tier: 'semantic', category: 'preference', scope: 'global', entity_key: 'docs.lang', content: '面向用户的文档与回复使用中文', summary: 'docs in chinese', importance: 4, status: 'verified', topics: ['文档', 'docs', '中文', '语言', '文案'] },
  { id: 'mem_doc_adr', tier: 'semantic', category: 'architecture', entity_key: 'docs.adr', content: '架构决策必须补 ADR 到 docs/adr/', summary: 'adr required', importance: 3.5, status: 'verified', topics: ['文档', 'docs', 'adr', '架构决策', '流程'] },
  { id: 'mem_ts_strict', tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'ts.strict', content: 'strictNullChecks 必须开启', summary: 'strict nulls', importance: 4, status: 'verified', topics: ['typescript', 'ts', 'strict', '类型', '配置'] },
  { id: 'mem_ts_path', tier: 'semantic', category: 'architecture', entity_key: 'ts.paths', content: '路径别名统一 @/ 指向 src/', summary: 'alias @/ src', importance: 3, status: 'verified', topics: ['typescript', 'ts', '路径别名', 'alias', '配置', '模块'] }
];

const QUESTIONS = [
  { id: 'q1', query: 'A 项目和 B 项目的数据库端口分别是什么', gold: ['mem_a_pg', 'mem_b_pg'] },
  { id: 'q2', query: '测试超时和测试框架崩溃分别怎么处理', gold: ['mem_err_jest', 'mem_err_vitest'] },
  { id: 'q3', query: '发 beta 和发正式版流程有什么区别', gold: ['mem_rel_beta', 'mem_rel_prod'] },
  { id: 'q4', query: 'auth 用什么方案，token 过期怎么刷新', gold: ['mem_auth_jwt', 'mem_auth_refresh'] },
  { id: 'q5', query: 'CI 挂了能合吗，flaky 的怎么处理', gold: ['mem_ci_green', 'mem_ci_flaky'] },
  { id: 'q6', query: '写文档有什么语言和流程要求', gold: ['mem_doc_zh', 'mem_doc_adr'] },
  { id: 'q7', query: 'TypeScript 有哪些强制配置', gold: ['mem_ts_strict', 'mem_ts_path'] },
  { id: 'q8', query: '装依赖和 node 版本有什么约定', gold: ['mem_pkg_pnpm', 'mem_pkg_node'] },
  { id: 'q9', query: '修完代码提交前要确认什么（测试与流水线）', gold: ['mem_ci_green', 'mem_err_jest'] },
  { id: 'q10', query: '从依赖安装到发布 beta 的完整约定', gold: ['mem_pkg_pnpm', 'mem_rel_beta'] }
];

const ks = [3, 5, 8];
const store = new MemoryStore({ ...DEFAULT_CONFIG, storage: {} }, ':memory:');

// Optional query rewrite via the real API (mirrors MemoryService.rewriteQuery),
// passed INTO the retriever so the production raw+rewrite max-union path runs.
const REWRITE = process.argv.includes('--rewrite');
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const REWRITE_MODEL = 'deepseek-v4-flash';
const lastRewrites = new Map();

async function rewriteQuery(query) {
  // Determinism: cache rewrites on disk so benchmark reruns are reproducible
  // (the LLM's keyword choices vary run to run by ±0.1 both-gold@5).
  const cachePath = path.join(root, 'evals/results/rewrite-cache.json');
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    cache = {};
  }
  if (typeof cache[query] === 'string') return cache[query];

  const system =
    'You rewrite memory-search queries into retrieval keywords.\n' +
    'Rules: output ONE line of 5-12 keywords separated by spaces; include concrete technical ' +
    'terms, config keys, tool/command names, file names, and synonyms in the query\'s own ' +
    'languages (Chinese and/or English); expand abbreviations to the likely concrete terms ' +
    'even when they do not appear verbatim in the query; NEVER repeat the query verbatim; ' +
    'no explanation.\n' +
    'Example — Query: 数据库连不上怎么办\n' +
    'Keywords: ECONNREFUSED postgres 连接被拒 数据库连接失败 docker compose db 端口 5432 pgbouncer 连接超时';
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: REWRITE_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Query: ${query}\nKeywords:` }
      ],
      max_tokens: 64,
      thinking: { type: 'disabled' },
      stream: false
    })
  });
  if (!response.ok) throw new Error(`rewrite API ${response.status}`);
  const data = await response.json();
  const text = (data.choices?.[0]?.message?.content ?? '').trim().split('\n')[0].slice(0, 300);
  const result = text || query;
  cache[query] = result;
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  lastRewrites.set(query, result);
  return result;
}

const retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval, REWRITE && API_KEY ? rewriteQuery : undefined);

for (const item of CORPUS) {
  const { topics, ...seed } = item;
  // Simulate the L2 write-side topic completion: without --topics, memories
  // carry only the L1 deterministic derivation (same technical terms as the
  // body); with --topics they additionally carry the LLM's synonym bridge
  // words (测试/文档/配置/发布 …) that close the cold-vocabulary gap.
  await store.createMemory(WITH_TOPICS ? { ...seed, topic_keywords: topics } : seed);
}

const embedMode = store.getEmbeddingAdapter().mode;

const coverage = Object.fromEntries(ks.map((k) => [`both-gold@${k}`, 0]));
const anyCoverage = Object.fromEntries(ks.map((k) => [`any-gold@${k}`, 0]));
const details = [];

for (const q of QUESTIONS) {
  const results = await retriever.retrieve(q.query, { topK: 8, includeTentative: true });
  const ranked = results.map((r) => r.memory.id);
  const record = {
    id: q.id,
    query: q.query,
    effectiveQuery: lastRewrites.get(q.query) ?? q.query,
    ranked,
    hits: q.gold.filter((g) => ranked.includes(g))
  };
  for (const k of ks) {
    const inTop = ranked.slice(0, k);
    const hitsInTop = q.gold.filter((g) => inTop.includes(g));
    if (hitsInTop.length === 2) coverage[`both-gold@${k}`]++;
    if (hitsInTop.length >= 1) anyCoverage[`any-gold@${k}`]++;
  }
  details.push(record);
}
store.close();

const report = {
  corpus: CORPUS.length,
  questions: QUESTIONS.length,
  embeddingMode: embedMode,
  writeSideTopics: WITH_TOPICS,
  queryRewrite: REWRITE && !!API_KEY,
  engine: `HybridRetriever multi-hop coverage (${embedMode}${WITH_TOPICS ? ' + write-side topics' : ''}${REWRITE && API_KEY ? ' + flash query-rewrite' : ''})`,
  ...Object.fromEntries(
    [...Object.entries(coverage), ...Object.entries(anyCoverage)].map(([k, v]) => [
      k,
      Math.round((v / QUESTIONS.length) * 1000) / 1000
    ])
  ),
  details
};

console.log(`Long-memory mini benchmark — ${report.questions} multi-hop questions over ${report.corpus} memories`);
console.log(`embedding=${embedMode}  write-side-topics=${report.writeSideTopics}  rewrite=${report.queryRewrite}\n`);
for (const k of ks) {
  console.log(`  both-gold@${k} = ${report[`both-gold@${k}`].toFixed(2)}   any-gold@${k} = ${report[`any-gold@${k}`].toFixed(2)}`);
}
console.log('\nPer-question rankings:');
for (const d of details) {
  console.log(`  ${d.id}: gold-hit ${d.hits.length}/2 → ${d.ranked.slice(0, 8).join(' > ')}`);
}

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}`);
}

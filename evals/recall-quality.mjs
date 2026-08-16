#!/usr/bin/env node
/**
 * P0 recall quality eval: seed the REAL MemoryStore + HybridRetriever with
 * scenario corpora and measure recall@k / MRR over "last week's trap, must
 * resurface today" queries. Includes a cross-project leak check (foreign
 * origin_cwd workspace rows must never surface).
 *
 * Usage: node evals/recall-quality.mjs [--json out.json]
 * Requires `pnpm build` first.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MemoryStore } = await import(path.join(root, 'dist/storage/db.js'));
const { HybridRetriever } = await import(path.join(root, 'dist/core/hybrid-retriever.js'));
const { DEFAULT_CONFIG } = await import(path.join(root, 'dist/config.js'));

/** Scenario = one "today" query against a corpus containing gold + distractors. */
const scenarios = [
  {
    id: 's01_jest_flaky',
    query: 'jest 又超时挂了，上次的解法是什么',
    gold: ['mem_pm_jest_retry'],
    corpus: [
      { id: 'mem_pm_jest_retry', tier: 'episodic', category: 'post_mortem', error_signature: 'jest exit 1 timeout', solution_code: 'pnpm test -- --retryTimes=2', content: 'jest flaky 超时，重试参数解决', summary: 'jest timeout retry', importance: 4.5, status: 'verified' },
      { id: 'mem_pm_vitest', tier: 'episodic', category: 'post_mortem', error_signature: 'vitest ui crash', solution_code: 'downgrade vitest 1.2', content: 'vitest UI 崩溃降级', summary: 'vitest downgrade', importance: 3, status: 'verified' },
      { id: 'mem_rule_ci', tier: 'semantic', category: 'rule', content: 'CI 全绿才能合并', summary: 'ci green merge', importance: 4, status: 'verified' }
    ]
  },
  {
    id: 's02_pnpm_rule',
    query: '这个 monorepo 里装依赖用什么命令',
    gold: ['mem_rule_pnpm'],
    corpus: [
      { id: 'mem_rule_pnpm', tier: 'semantic', category: 'rule', entity_key: 'config.package_manager', content: '统一使用 pnpm，不要用 npm install', summary: 'pnpm only', importance: 5, status: 'verified' },
      { id: 'mem_rule_nvmrc', tier: 'semantic', category: 'rule', entity_key: 'config.node_version', content: 'node 版本以 .nvmrc 为准', summary: 'nvmrc node version', importance: 3.5, status: 'verified' }
    ]
  },
  {
    id: 's03_pg_conn',
    query: 'postgres connection refused 5432 怎么处理',
    gold: ['mem_pm_pg_docker'],
    corpus: [
      { id: 'mem_pm_pg_docker', tier: 'episodic', category: 'post_mortem', error_signature: 'ECONNREFUSED 127.0.0.1:5432', solution_code: 'docker compose up -d db', content: 'pg 未启动，docker 拉起', summary: 'pg docker up', importance: 4.5, status: 'verified' },
      { id: 'mem_pm_redis', tier: 'episodic', category: 'post_mortem', error_signature: 'ECONNREFUSED 6379', solution_code: 'brew services start redis', content: 'redis 未启动', summary: 'redis start', importance: 3, status: 'verified' },
      { id: 'mem_wf_backup', tier: 'procedural', category: 'workflow', content: '数据库备份脚本 pg_dump 每日', summary: 'pg_dump daily', importance: 3, status: 'verified' }
    ]
  },
  {
    id: 's04_corrections_first',
    query: '开始重构 auth 模块',
    gold: ['mem_corr_no_session'],
    corpus: [
      { id: 'mem_corr_no_session', tier: 'semantic', category: 'correction', scope: 'global', entity_key: 'correction.auth-jwt', content: '用户纠正：wrong, we use JWT\n修正后的行为：auth 一律 JWT，不用 session', summary: '纠错: auth 用 JWT 不用 session', importance: 4.5, status: 'verified' },
      { id: 'mem_arch_auth', tier: 'semantic', category: 'architecture', content: 'auth 模块位于 apps/auth，含登录与刷新', summary: 'auth module location', importance: 4, status: 'verified' },
      { id: 'mem_rule_ts', tier: 'semantic', category: 'rule', content: 'strictNullChecks 必须开启', summary: 'strict nulls', importance: 4, status: 'verified' }
    ]
  },
  {
    id: 's05_branch_scoped',
    query: '这个分支上 protobuf 有什么坑',
    gold: ['mem_pm_proto_feat'],
    branch: 'feat/grpc',
    corpus: [
      { id: 'mem_pm_proto_feat', tier: 'episodic', category: 'post_mortem', error_signature: 'protoc version mismatch', solution_code: 'use protoc 25.1 via pnpm protoc', content: 'feat/grpc 分支 protoc 版本坑', summary: 'protoc 25.1', git_branch: 'feat/grpc', importance: 4.5, status: 'verified' },
      { id: 'mem_pm_proto_main', tier: 'episodic', category: 'post_mortem', error_signature: 'protoc gen script missing', solution_code: 'pnpm gen:proto', content: 'main 分支 proto 脚本缺失', summary: 'gen proto script', git_branch: 'main', importance: 3, status: 'verified' }
    ]
  },
  {
    id: 's06_cross_project_leak',
    query: '数据库连接串怎么配',
    gold: ['mem_pm_conn_here'],
    foreignGold: ['mem_pm_conn_other'],
    corpus: [
      { id: 'mem_pm_conn_here', tier: 'episodic', category: 'post_mortem', error_signature: 'invalid connection string', solution_code: 'postgres://user:pass@pgbouncer:6432/db', content: '连接串走 pgbouncer 6432', summary: 'conn via pgbouncer', importance: 4, status: 'verified' },
      { id: 'mem_pm_conn_other', tier: 'episodic', category: 'post_mortem', error_signature: 'invalid connection string', solution_code: 'postgres://other-project-config', content: '另一个项目的连接串', summary: 'other project conn', origin_cwd: '/definitely/another/project', importance: 5, status: 'verified' }
    ]
  },
  {
    id: 's07_recipe_recall',
    query: '发一版内部 beta',
    gold: ['mem_wf_release'],
    corpus: [
      { id: 'mem_wf_release', tier: 'procedural', category: 'workflow', entity_key: 'workflow.release_beta', content: '发布 beta：pnpm version prerelease && pnpm build && pnpm publish --tag beta', summary: 'beta release steps', solution_code: 'pnpm version prerelease && pnpm build && pnpm publish --tag beta', importance: 4, status: 'verified' },
      { id: 'mem_wf_lint', tier: 'procedural', category: 'workflow', content: '提交前 pnpm lint --fix', summary: 'lint fix', importance: 3, status: 'verified' }
    ]
  },
  {
    id: 's08_tentative_suppressed',
    query: 'webpack 构建内存爆了怎么办',
    gold: ['mem_pm_webpack_verified'],
    corpus: [
      { id: 'mem_pm_webpack_verified', tier: 'episodic', category: 'post_mortem', status: 'verified', error_signature: 'JS heap out of memory webpack', solution_code: 'NODE_OPTIONS=--max-old-space-size=8192', content: 'webpack OOM 加内存', summary: 'heap 8192', importance: 4.5 },
      { id: 'mem_pm_webpack_tentative', tier: 'episodic', category: 'post_mortem', status: 'tentative', error_signature: 'JS heap out of memory webpack', solution_code: 'swap to vite (unverified)', content: '未验证：换 vite', summary: 'try vite', importance: 3 }
    ]
  }
];

const ks = [1, 3, 5];
const recallAt = Object.fromEntries(ks.map((k) => [`recall@${k}`, 0]));
let mrrSum = 0;
let foreignLeaks = 0;
const details = [];

for (const scenario of scenarios) {
  const store = new MemoryStore({ ...DEFAULT_CONFIG, storage: { forceJsVector: true } }, ':memory:');
  const retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);

  for (const item of scenario.corpus) {
    const { origin_cwd, ...input } = item;
    await store.createMemory(input);
    if (origin_cwd) {
      store.getDb().prepare('UPDATE memories SET origin_cwd = ? WHERE id = ?').run(origin_cwd, item.id);
    }
  }

  const results = await retriever.retrieve(scenario.query, {
    topK: 5,
    includeTentative: true,
    currentGitBranch: scenario.branch
  });
  const ranked = results.map((r) => r.memory.id);

  for (const k of ks) {
    if (scenario.gold.some((g) => ranked.slice(0, k).includes(g))) recallAt[`recall@${k}`]++;
  }
  const firstGold = ranked.findIndex((id) => scenario.gold.includes(id));
  mrrSum += firstGold >= 0 ? 1 / (firstGold + 1) : 0;

  const leaked = (scenario.foreignGold ?? []).filter((id) => ranked.includes(id));
  foreignLeaks += leaked.length;

  details.push({
    id: scenario.id,
    ranked,
    goldHitRank: firstGold >= 0 ? firstGold + 1 : null,
    foreignLeaks: leaked
  });

  store.close();
}

const report = {
  scenarios: scenarios.length,
  ...Object.fromEntries(Object.entries(recallAt).map(([k, v]) => [k, round3(v / scenarios.length)])),
  mrr: round3(mrrSum / scenarios.length),
  crossProjectLeaks: foreignLeaks,
  engine: 'HybridRetriever (deterministic hash embeddings, forceJsVector)',
  details
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

console.log(`Recall quality — ${report.scenarios} scenarios (topK=5, tentative included)\n`);
for (const k of ks) console.log(`  recall@${String(k).padEnd(2)} = ${report[`recall@${k}`].toFixed(2)}`);
console.log(`  MRR      = ${report.mrr.toFixed(2)}`);
console.log(`  cross-project leaks = ${report.crossProjectLeaks} (must be 0)`);
console.log('\nPer-scenario ranking:');
for (const d of details) {
  console.log(`  ${d.id.padEnd(26)} gold rank=${String(d.goldHitRank).padEnd(4)} ${d.ranked.join(' > ')}`);
}

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}`);
}

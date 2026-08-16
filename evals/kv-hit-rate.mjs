#!/usr/bin/env node
/**
 * P0 KV-cache hit-rate measurement against the REAL DeepSeek API.
 *
 * Three injection strategies, same 8-turn conversation each:
 *
 *  1. baseline  — fixed system prompt, no memory.
 *  2. two-tier  — fixed system prompt (with the FROZEN working-set block,
 *                 mirroring Tier 1) + per-turn recall text appended to the
 *                 LATEST user message (mirroring Tier 2's post-prefix slot).
 *  3. naive     — system prompt rebuilt every turn with a growing memory
 *                 block (the anti-pattern the plugin exists to avoid).
 *
 * DeepSeek context caching is automatic and requires FULL prefix match, so
 * the expectation is: two-tier ≈ baseline hit ratio, naive ≈ 0 after turn 1.
 *
 * Credentials: DEEPSEEK_API_KEY (required), DEEPSEEK_BASE_URL (optional,
 * defaults to https://api.deepseek.com). Never hardcodes secrets.
 *
 * Usage: node evals/kv-hit-rate.mjs [--json out.json] [--turns 8]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { estimateCostUsd, isPeakHour } = await import(path.join(root, 'dist/core/peak-pricing.js'));

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.KV_EVAL_MODEL || 'deepseek-v4-flash';

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set (read from the environment only).');
  process.exit(1);
}

const turnsFlag = process.argv.indexOf('--turns');
const TURNS = turnsFlag >= 0 ? Math.max(2, Math.min(20, Number(process.argv[turnsFlag + 1]) || 8)) : 8;

// ---- Prompt material -------------------------------------------------------

const STABLE_TOOL_GUIDANCE = Array.from(
  { length: 24 },
  (_, i) =>
    `Tool guidance ${i}: when operating on workspace files prefer scoped edits over full rewrites; ` +
    `validate with the project's own test command; never modify generated artifacts under dist/; ` +
    `keep shell sessions short-lived and always check exit codes before continuing.`
).join('\n');

const BASE_SYSTEM = `You are a coding agent working inside a large monorepo.\n\n${STABLE_TOOL_GUIDANCE}`;

const WORKING_SET_RULES = [
  'config.package_manager: 统一使用 pnpm，禁止 npm install',
  'repo.test_cmd: 提交前必须 pnpm test 全绿',
  'auth.header: 一律 JWT，不用 session',
  'db.port: 连接串走 pgbouncer:6432',
  'ci.merge: CI 全绿才能合并',
  'ts.strict: strictNullChecks 必须开启',
  'docs.lang: 面向用户的文案使用中文',
  'release.flow: beta 发行走 pnpm publish --tag beta',
  'error.jest: jest 超时用 --retryTimes=2',
  'error.pg: ECONNREFUSED 5432 先 docker compose up -d db'
];
const FROZEN_WORKING_SET = `<dsh_memory version="1.1">\n[Active Rules & Norms]\n${WORKING_SET_RULES.map((r) => `- ${r}`).join('\n')}\n</dsh_memory>`;

const recallFor = (n) =>
  `[memory:recall 2026-08-17T0${n}:00:00Z] database setup\n- jest timeout → --retryTimes=2\n- pg refused → docker compose up -d db\n- turn-specific probe ${n}`;

// ---- API client ------------------------------------------------------------

async function chat(messages, attempt = 1) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 24, stream: false })
  });

  if (response.status === 429 && attempt <= 4) {
    await sleep(2000 * attempt);
    return chat(messages, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  const usage = data.usage ?? {};
  return {
    hit: usage.prompt_cache_hit_tokens ?? 0,
    miss: usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0,
    total: usage.prompt_tokens ?? 0
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Strategies ------------------------------------------------------------

async function runStrategy(name) {
  const history = [];
  const perTurn = [];

  for (let n = 1; n <= TURNS; n++) {
    const userText = `Turn ${n}: 简述当前可用工具清单的前三条，不要展开。`;

    let system;
    let userContent;
    if (name === 'baseline') {
      system = BASE_SYSTEM;
      userContent = userText;
    } else if (name === 'two-tier') {
      system = `${BASE_SYSTEM}\n\n${FROZEN_WORKING_SET}`;
      userContent = `${userText}\n\n${recallFor(n)}`; // Tier 2: after the prefix, per-turn
    } else {
      // naive anti-pattern: the memory block is REBUILT every turn (re-ranked
      // rules + a fresh timestamp header), so the divergence point sits at the
      // very start of the block and everything after it misses every turn.
      const rotated = [...WORKING_SET_RULES.slice(n % WORKING_SET_RULES.length), ...WORKING_SET_RULES.slice(0, n % WORKING_SET_RULES.length)];
      system = `${BASE_SYSTEM}\n\n<dsh_memory rebuilt at turn ${n} 2026-08-17T0${n}:30:00Z>\n${rotated.map((r) => `- ${r}`).join('\n')}\n[dynamic recall ${n}] ${recallFor(n)}\n</dsh_memory>`;
      userContent = userText;
    }

    const messages = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: userContent }
    ];

    const usage = await chat(messages);
    perTurn.push({ turn: n, ...usage });
    history.push({ role: 'user', content: userContent }, { role: 'assistant', content: `ok ${n}` });

    await sleep(300); // small pacing between turns
  }

  const hit = perTurn.reduce((s, t) => s + t.hit, 0);
  const miss = perTurn.reduce((s, t) => s + t.miss, 0);
  const total = hit + miss;
  return {
    strategy: name,
    perTurn,
    hitTokens: hit,
    missTokens: miss,
    hitRatio: total === 0 ? 0 : Math.round((hit / total) * 1000) / 1000,
    estInputCostUsd: Math.round(
      estimateCostUsd(MODEL, { hitTokens: hit, missTokens: miss }, new Date()) * 10000
    ) / 10000
  };
}

// ---- Run -------------------------------------------------------------------

console.log(`KV hit-rate measurement — ${MODEL} @ ${BASE_URL}`);
console.log(`turns=${TURNS}  tariff=${isPeakHour() ? 'peak' : 'off-peak'}  prompt≈${Math.round(BASE_SYSTEM.length / 3.5)} tokens (stable prefix)\n`);

const results = [];
for (const strategy of ['baseline', 'two-tier', 'naive']) {
  process.stdout.write(`running ${strategy} ... `);
  const r = await runStrategy(strategy);
  results.push(r);
  console.log(`hit=${r.hitTokens} miss=${r.missTokens} ratio=${(r.hitRatio * 100).toFixed(1)}% est=$${r.estInputCostUsd}`);
}

const baseline = results[0];
const twoTier = results[1];
const naive = results[2];
const summary = {
  model: MODEL,
  baseUrl: BASE_URL,
  turns: TURNS,
  tariff: isPeakHour() ? 'peak' : 'off-peak',
  measuredAt: new Date().toISOString(),
  headline: {
    baselineHitRatio: baseline.hitRatio,
    twoTierHitRatio: twoTier.hitRatio,
    naiveHitRatio: naive.hitRatio,
    twoTierVsBaseline: Math.round((twoTier.hitRatio / Math.max(baseline.hitRatio, 1e-9)) * 1000) / 1000,
    naiveExtraMissCostUsdPerConversation: Math.round((naive.estInputCostUsd - twoTier.estInputCostUsd) * 10000) / 10000
  },
  results: results.map(({ perTurn, ...rest }) => ({ ...rest, perTurnTurns: perTurn.length }))
};

console.log('\n=== Summary ===');
console.log(`baseline hit ratio : ${(baseline.hitRatio * 100).toFixed(1)}%`);
console.log(`two-tier hit ratio : ${(twoTier.hitRatio * 100).toFixed(1)}%  (target ≈ baseline)`);
console.log(`naive hit ratio    : ${(naive.hitRatio * 100).toFixed(1)}%  (anti-pattern)`);
console.log(`input cost — two-tier $${twoTier.estInputCostUsd} vs naive $${naive.estInputCostUsd} per ${TURNS}-turn conversation`);

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

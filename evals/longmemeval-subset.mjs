#!/usr/bin/env node
/**
 * LongMemEval-S official subset (weaviate mirror of xiaowu0162/longmemeval):
 * 50 questions, each against its own tenant's full session haystack
 * (~48 sessions per tenant). Sessions are seeded as episodic memories
 * unchanged (no LLM distillation) — this measures the RETRIEVAL layer on
 * real conversational long-memory data.
 *
 * Metrics:
 *  - evidence@k: any answer_session_id appears in the top-k retrieved
 *  - answer-substring@5: the gold answer string occurs in the top-5 content
 *
 * Data (auto-downloaded on first run, ~250MB docs + 190KB queries):
 *   evals/data/longmemeval-s-docs.json, evals/data/longmemeval-s-queries.json
 *
 * Usage: node evals/longmemeval-subset.mjs [--n 50] [--json out.json]
 */
import { writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MemoryStore } = await import(path.join(root, 'dist/storage/db.js'));
const { HybridRetriever } = await import(path.join(root, 'dist/core/hybrid-retriever.js'));
const { DEFAULT_CONFIG } = await import(path.join(root, 'dist/config.js'));

const nFlag = process.argv.indexOf('--n');
const N = nFlag >= 0 ? Number(process.argv[nFlag + 1]) || 50 : 50;

const DATA_DIR = path.join(root, 'evals/data');
const DOCS_PATH = path.join(DATA_DIR, 'longmemeval-s-docs.json');
const QUERIES_PATH = path.join(DATA_DIR, 'longmemeval-s-queries.json');
const DOCS_URL = 'https://huggingface.co/datasets/weaviate/longmemeval-s-cleaned/resolve/main/longmemeval-s-docs.json';
const QUERIES_URL = 'https://huggingface.co/datasets/weaviate/longmemeval-s-cleaned/resolve/main/longmemeval-s-queries.json';

async function ensureFile(filePath, url, label) {
  if (existsSync(filePath)) return;
  console.log(`downloading ${label} (~${filePath.includes('docs') ? '250MB' : '200KB'}) ...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${label}: ${response.status}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  await Readable.fromWeb(response.body).pipe(createWriteStream(filePath));
}

await ensureFile(QUERIES_PATH, QUERIES_URL, 'queries');
await ensureFile(DOCS_PATH, DOCS_URL, 'docs');

const queries = JSON.parse((await import('node:fs')).readFileSync(QUERIES_PATH, 'utf8'));
const docs = JSON.parse((await import('node:fs')).readFileSync(DOCS_PATH, 'utf8'));

const byTenant = new Map();
for (const d of docs) {
  if (!byTenant.has(d.tenant_id)) byTenant.set(d.tenant_id, []);
  byTenant.get(d.tenant_id).push(d);
}

const ks = [1, 3, 5, 10];
const evidenceAt = Object.fromEntries(ks.map((k) => [`evidence@${k}`, 0]));
let answerSub5 = 0;
const details = [];

const subset = queries.slice(0, N);
console.log(`LongMemEval-S subset — ${subset.length} questions (own-tenant haystacks, no distillation)\n`);

for (let qi = 0; qi < subset.length; qi++) {
  const q = subset[qi];
  const sessions = byTenant.get(q.tenant_id) ?? [];
  if (sessions.length === 0 || !q.answer_session_ids?.length) continue;

  const store = new MemoryStore({ ...DEFAULT_CONFIG, storage: {} }, ':memory:');
  const retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);

  for (const s of sessions) {
    await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      scope: 'workspace',
      content: s.session_text.slice(0, 20000),
      summary: s.session_text.replace(/\s+/g, ' ').slice(0, 100),
      entity_key: s.session_id,
      importance: 3,
      status: 'verified'
    });
  }

  const results = await retriever.retrieve(q.question, { topK: 10, includeTentative: true });
  const ranked = results.map((r) => r.memory.entity_key);

  const goldSet = new Set(q.answer_session_ids);
  for (const k of ks) {
    if (ranked.slice(0, k).some((id) => goldSet.has(id))) evidenceAt[`evidence@${k}`]++;
  }
  const top5Text = results.slice(0, 5).map((r) => r.memory.content).join('\n').toLowerCase();
  if (q.answer && top5Text.includes(String(q.answer).toLowerCase())) answerSub5++;

  details.push({
    question_id: q.question_id,
    question: q.question,
    answer: q.answer,
    haystack: sessions.length,
    goldRank: ranked.findIndex((id) => goldSet.has(id)) + 1 || null
  });

  store.close();
  if ((qi + 1) % 10 === 0) console.log(`  ${qi + 1}/${subset.length} done`);
}

const answered = details.length;
const report = {
  source: 'weaviate/longmemeval-s-cleaned (mirror of xiaowu0162/longmemeval)',
  questions: answered,
  ...Object.fromEntries(Object.entries(evidenceAt).map(([k, v]) => [k, round3(v / answered)])),
  answerSubstringAt5: round3(answerSub5 / answered),
  engine: `HybridRetriever (${'onnx-local'} embeddings, no query rewrite, no distillation)`,
  details
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

console.log('\n=== LongMemEval-S subset results ===');
for (const k of ks) console.log(`  evidence@${String(k).padEnd(2)} = ${report[`evidence@${k}`].toFixed(2)}`);
console.log(`  answer-substring@5 = ${report.answerSubstringAt5.toFixed(2)}`);

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}`);
}

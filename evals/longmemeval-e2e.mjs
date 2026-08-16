#!/usr/bin/env node
/**
 * End-to-end QA eval — LongMemEval-S official answering-style (complements
 * evals/longmemeval-subset.mjs which only measures the retrieval layer).
 *
 * Pipeline per question: tenant haystack → hybrid retrieval top-5 evidence →
 * LLM answers given that evidence → LLM judge decides equivalence with the
 * gold answer. Retrieval quality and answer correctness are scored SEPARATELY
 * so failures are attributable (retrieval-miss vs generation-miss vs judge).
 *
 * Metrics:
 *  - evidence@k           (retrieval layer; regression anchor ~0.84@1)
 *  - answer-substring@5   (model answer contains the gold answer, exact-ish)
 *  - answer-llm-judge@5   (paraphrase-tolerant equivalence, primary QA gate)
 *
 * Thresholds (predeclared):
 *  - evidence@5:  pass >= 0.80   warn 0.70-0.80   block < 0.70
 *  - answer-judge@5: pass >= 0.80 warn 0.65-0.80  block < 0.65
 *  - answer-substring@5: pass >= 0.70 warn 0.55-0.70 block < 0.55
 *
 * Determinism: LLM answers are cached on disk (evals/results/longmemeval-e2e-cache.json)
 * keyed by question+topK, so reruns reproduce the same numbers until --fresh.
 *
 * Data (auto-downloaded first run, ~250MB): evals/data/longmemeval-s-*.json
 *
 * Usage: node evals/longmemeval-e2e.mjs [--n 20] [--topk 5] [--evl 3000] [--fresh] [--json out.json]
 * Requires DEEPSEEK_API_KEY.
 *
 * Evidence window: LongMemEval sessions are long multi-turn dialogs whose
 * answer usually sits after the head. The first baseline run used a 1200-char
 * head slice per session and scored ~0.10 (model correctly answered
 * NO_ANSWER because the answer was truncated away) — an evidence-compaction
 * artifact, not a retrieval failure (evidence@5 stayed 0.85). Use --evl to
 * widen the per-session window; the retrieval and answer layers are reported
 * separately so this stays attributable.
 */
import { writeFileSync, mkdirSync, existsSync, createWriteStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MemoryStore } = await import(path.join(root, 'dist/storage/db.js'));
const { HybridRetriever } = await import(path.join(root, 'dist/core/hybrid-retriever.js'));
const { DEFAULT_CONFIG } = await import(path.join(root, 'dist/config.js'));

const nFlag = process.argv.indexOf('--n');
const N = nFlag >= 0 ? Number(process.argv[nFlag + 1]) || 20 : 20;
const kFlag = process.argv.indexOf('--topk');
const TOPK = kFlag >= 0 ? Number(process.argv[kFlag + 1]) || 5 : 5;
const evlFlag = process.argv.indexOf('--evl');
const EVIDENCE_CHARS = evlFlag >= 0 ? Number(process.argv[evlFlag + 1]) || 3000 : 3000;
const FRESH = process.argv.includes('--fresh');

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY is required for the answering + judge calls.');
  process.exit(1);
}
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_QA_MODEL || 'deepseek-v4-flash';

const DATA_DIR = path.join(root, 'evals/data');
const DOCS_PATH = path.join(DATA_DIR, 'longmemeval-s-docs.json');
const QUERIES_PATH = path.join(DATA_DIR, 'longmemeval-s-queries.json');
const DOCS_URL = 'https://huggingface.co/datasets/weaviate/longmemeval-s-cleaned/resolve/main/longmemeval-s-docs.json';
const QUERIES_URL = 'https://huggingface.co/datasets/weaviate/longmemeval-s-cleaned/resolve/main/longmemeval-s-queries.json';
const CACHE_PATH = path.join(root, 'evals/results/longmemeval-e2e-cache.json');

async function ensureFile(filePath, url, label) {
  if (existsSync(filePath)) return;
  console.log(`downloading ${label} ...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${label}: ${response.status}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  await Readable.fromWeb(response.body).pipe(createWriteStream(filePath));
}

await ensureFile(QUERIES_PATH, QUERIES_URL, 'queries');
await ensureFile(DOCS_PATH, DOCS_URL, 'docs');

const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const docs = JSON.parse(readFileSync(DOCS_PATH, 'utf8'));

const byTenant = new Map();
for (const d of docs) {
  if (!byTenant.has(d.tenant_id)) byTenant.set(d.tenant_id, []);
  byTenant.get(d.tenant_id).push(d);
}

// Answer/judge cache for reproducibility (like the rewrite cache).
let cache = {};
if (!FRESH && existsSync(CACHE_PATH)) {
  try {
    cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
}
const saveCache = () => {
  mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
};

/** One small DeepSeek call (auxiliary tasks → thinking disabled). */
async function chat(system, prompt, maxTokens) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      stream: false
    })
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}`);
  const data = await response.json();
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  return { text, usage: data.usage ?? null };
}

function answerCacheKey(qid) {
  return `q:${qid}:k${TOPK}`;
}

const ANSWER_SYSTEM =
  'You answer a question based ONLY on the provided memory excerpts. ' +
  'Be concise (1-3 sentences). Extract the answer directly from the excerpts when any ' +
  'relevant fact is present — do NOT refuse just because the wording differs. ' +
  'Only say "NO_ANSWER" when the excerpts truly contain no relevant information.';

async function answerQuestion(q, evidenceText) {
  const key = answerCacheKey(q.question_id);
  if (cache[key]?.answer !== undefined) return cache[key];
  const { text, usage } = await chat(
    ANSWER_SYSTEM,
    `Question: ${q.question}\n\nMemory excerpts:\n${evidenceText}\n\nAnswer:`,
    160
  );
  const entry = { answer: text, gold: q.answer, evidence: evidenceText.slice(0, 500), usage };
  cache[key] = entry;
  saveCache();
  return entry;
}

const JUDGE_SYSTEM =
  'You judge whether a model answer is CORRECT given the gold answer and the question. ' +
  'It is correct when it contains the same key information (allow paraphrase, language, ' +
  'partial over-specific detail). "NO_ANSWER" is always incorrect. ' +
  'Respond with strictly valid JSON: {"correct": boolean, "reason": "..."}';

async function judgeAnswer(q, modelAnswer) {
  const key = answerCacheKey(q.question_id);
  if (cache[key]?.judge !== undefined) return cache[key].judge;
  const { text } = await chat(
    JUDGE_SYSTEM,
    `Question: ${q.question}\nGold answer: ${q.answer}\nModel answer: ${modelAnswer}\n\nJSON:`,
    96
  );
  const parsed = (() => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  })();
  const result = typeof parsed?.correct === 'boolean' ? parsed.correct : false;
  cache[key] = { ...(cache[key] ?? {}), judge: result };
  saveCache();
  return result;
}

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const subset = queries.slice(0, N);
console.log(`LongMemEval-S end-to-end QA — ${subset.length} questions, top-${TOPK} evidence, model=${MODEL}\n`);

const ks = [1, 3, 5];
const evidenceAt = Object.fromEntries(ks.map((k) => [`evidence@${k}`, 0]));
let answerSub5 = 0;
let answerJudge5 = 0;
const details = [];
let costEstimateTokens = 0;
let skipped = 0;

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

  let record;
  try {
    const results = await retriever.retrieve(q.question, { topK: Math.max(TOPK, 5), includeTentative: true });
    const ranked = results.map((r) => r.memory.entity_key);
    const goldSet = new Set(q.answer_session_ids);
    const goldRank = ranked.findIndex((id) => goldSet.has(id)) + 1;

    // Evidence = top-TOPK retrieved sessions (per-excerpt window --evl chars).
    const evidenceText = results
      .slice(0, TOPK)
      .map((r, i) => `[excerpt ${i + 1} (session ${r.memory.entity_key})]\n${r.memory.content.replace(/\s+/g, ' ').slice(0, EVIDENCE_CHARS)}`)
      .join('\n\n');

    const answerEntry = await answerQuestion(q, evidenceText || '(no evidence retrieved)');
    if (answerEntry.usage) costEstimateTokens += (answerEntry.usage.prompt_tokens ?? 0) + (answerEntry.usage.completion_tokens ?? 0);
    const modelAnswer = answerEntry.answer;
    const subMatch = Boolean(normalize(q.answer)) && normalize(modelAnswer).includes(normalize(q.answer));
    const judged = await judgeAnswer(q, modelAnswer);

    // Count a question ONLY once answer + judge succeeded, so API failures
    // cannot inflate the retrieval numerators (evidence@k stayed >1.0 before).
    for (const k of ks) {
      if (ranked.slice(0, k).some((id) => goldSet.has(id))) evidenceAt[`evidence@${k}`]++;
    }
    if (subMatch) answerSub5++;
    if (judged) answerJudge5++;

    record = {
      question_id: q.question_id,
      question: q.question,
      gold: q.answer,
      haystack: sessions.length,
      goldRank: goldRank || null,
      retrievedEvidence: goldRank ? 'hit' : 'miss',
      answerSubstring: subMatch,
      answerJudge: judged,
      modelAnswer: modelAnswer.slice(0, 300),
      failureClass: goldRank ? (subMatch || judged ? 'ok' : 'answer-miss') : 'retrieval-miss'
    };
  } catch (err) {
    skipped++;
    console.error(`  skipped ${q.question_id} (${err.message})`);
    store.close();
    continue;
  }
  details.push(record);

  store.close();
  if ((qi + 1) % 10 === 0) console.log(`  ${qi + 1}/${subset.length} done`);
}

const answered = details.length;
const report = {
  source: 'weaviate/longmemeval-s-cleaned (mirror of xiaowu0162/longmemeval)',
  questions: answered,
  model: MODEL,
  topK: TOPK,
  evidenceChars: EVIDENCE_CHARS,
  engine: `HybridRetriever (onnx-local, no rewrite) -> ${MODEL} answer -> ${MODEL} judge`,
  ...Object.fromEntries(Object.entries(evidenceAt).map(([k, v]) => [k, round3(v / answered)])),
  answerSubstringAt5: round3(answerSub5 / answered),
  answerJudgeAt5: round3(answerJudge5 / answered),
  // Predeclared gates (from the harness header).
  gates: {
    'evidence@5': { pass: 0.8, warn: 0.7, block: 0.7 },
    'answer-judge@5': { pass: 0.8, warn: 0.65, block: 0.65 },
    'answer-substring@5': { pass: 0.7, warn: 0.55, block: 0.55 }
  },
  failureTriage: triage(details),
  skipped,
  approxTokensBilled: costEstimateTokens,
  details
};

function triage(ds) {
  const out = { 'retrieval-miss': 0, 'answer-miss': 0, ok: 0 };
  for (const d of ds) out[d.failureClass] = (out[d.failureClass] ?? 0) + 1;
  return out;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

console.log('\n=== LongMemEval-S end-to-end QA results ===');
for (const k of ks) console.log(`  evidence@${String(k).padEnd(2)} = ${report[`evidence@${k}`].toFixed(2)}`);
console.log(`  answer-substring@5 = ${report.answerSubstringAt5.toFixed(2)}`);
console.log(`  answer-llm-judge@5 = ${report.answerJudgeAt5.toFixed(2)}`);
console.log('  failure triage:', JSON.stringify(report.failureTriage));
console.log(`  approx billed tokens: ${report.approxTokensBilled}`);

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}`);
}

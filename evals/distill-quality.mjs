#!/usr/bin/env node
/**
 * P0 distillation quality eval: run the REAL deterministic extractor stack
 * (TrajectoryFilter + CorrectionExtractor) over a labeled trajectory set and
 * report precision / recall / F1 per category against the gold labels.
 *
 * Matching rule: a predicted item is a true positive when its text contains
 * any gold substring for that category; each gold substring may be matched at
 * most once (greedy, in order).
 *
 * Usage:  node evals/distill-quality.mjs [--json out.json]
 * Requires `pnpm build` first (imports the compiled dist/).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { TrajectoryFilter } = await import(path.join(root, 'dist/pipeline/trajectory-filter.js'));
const { CorrectionExtractor } = await import(path.join(root, 'dist/pipeline/correction-extractor.js'));
const { DISTILL_JSON_SCHEMA } = await import(path.join(root, 'dist/pipeline/distiller.js'));

const LLM = process.argv.includes('--llm');
const JUDGE = process.argv.includes('--judge');
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const LLM_MODEL = 'deepseek-v4-flash';

async function callApi(system, prompt, maxTokens, options = {}) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens,
      // Auxiliary calls: with thinking on, V4 reasoning burns the token
      // budget and truncates the JSON body.
      thinking: { type: 'disabled' },
      stream: false,
      ...options
    })
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  const data = await response.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

function parseLooseJson(text) {
  const trimmed = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const sliced = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(sliced);
  } catch {
    try {
      return JSON.parse(sliced.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/**
 * LLM-judge equivalence: for each predicted item decide which gold item (if
 * any) it is semantically EQUIVALENT to (paraphrase counts). Returns per
 * category the list of matched gold indices.
 */
async function judgeCase(gold, predicted) {
  const system =
    'You are a strict evaluation judge for memory extraction. Given GOLD items and PREDICTED items, ' +
    'decide for each predicted item whether it conveys the SAME fact/rule/correction as some gold item ' +
    '(paraphrase counts, added detail counts, but a different fact does NOT). ' +
    'Respond with strictly valid JSON only: {"<category>":[{"p":<predIndex>,"g":<goldIndex or -1>}, ...]} for every category listed.';
  const prompt = JSON.stringify({ gold, predicted }, null, 1).slice(0, 8000);
  const text = await callApi(system, prompt, 1024);
  const parsed = parseLooseJson(text);
  return parsed ?? {};
}

async function distillWithLlm(steps) {
  const compact = steps
    .filter((s) => s.type !== 'REASONING')
    .slice(-20)
    .map((s) => `[${s.type}] ${s.content.slice(0, 300)}`)
    .filter(Boolean)
    .join('\n');
  const prompt =
    `Analyze this AI coding agent session trajectory. Extract verified rules, debugging post-mortems, reusable workflows, and user corrections (moments where the user pushed back and the agent changed course).\n\n` +
    `Respond with strictly valid JSON matching this schema:\n${JSON.stringify(DISTILL_JSON_SCHEMA)}\n\nTrajectory:\n${compact}`;
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: 'You are an AI Memory Distiller. Output strictly valid JSON conforming to the requested schema. Output nothing else.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2048,
      stream: false
    })
  });
  if (!response.ok) throw new Error(`distill API ${response.status}`);
  const data = await response.json();
  const text = (data.choices?.[0]?.message?.content ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const sliced = text.slice(start, end + 1);
  try {
    return JSON.parse(sliced);
  } catch {
    // Repair the most common malformation (trailing commas), then give up
    // gracefully — an unparseable case simply counts as missed gold.
    try {
      return JSON.parse(sliced.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return {};
    }
  }
}

const dataPath = path.join(root, 'evals/data/distill-eval.jsonl');
const cases = readFileSync(dataPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const filter = new TrajectoryFilter();
const extractor = new CorrectionExtractor();

const categories = ['directives', 'post_mortems', 'recipes', 'corrections'];
const stats = Object.fromEntries(categories.map((c) => [c, { tp: 0, fp: 0, fn: 0 }]));
const perCase = [];

for (const testCase of cases) {
  const steps = testCase.steps.map((s, i) => ({ step_index: i, status: 'DONE', ...s }));
  const pruned = filter.prune(steps);
  const corrections = extractor.extract(steps);

  let predicted;
  if (LLM) {
    if (!API_KEY) throw new Error('--llm requires DEEPSEEK_API_KEY');
    const parsed = await distillWithLlm(steps);
    predicted = {
      directives: (parsed.semantic_facts ?? []).map((f) => `${f.entity_key ?? ''} ${f.content} ${f.summary ?? ''}`),
      post_mortems: (parsed.post_mortems ?? []).map((p) => `${p.error_signature ?? ''} ${p.root_cause ?? ''} ${p.solution_code ?? ''}`),
      recipes: (parsed.procedural_recipes ?? []).map((r) => `${r.task_name ?? ''} ${r.commands}`),
      corrections: (parsed.user_corrections ?? []).map((c) => `${c.trigger} ${c.corrected_behavior}`)
    };
  } else {
    predicted = {
      directives: pruned.userDirectives,
      post_mortems: pruned.errorRecoveryPairs.map((p) => `${p.errorMessage} ${p.recoveryAction}`),
      recipes: pruned.reusableCommands,
      corrections: corrections.map((c) => `${c.trigger} ${c.correctedBehavior}`)
    };
  }

  const caseResult = { id: testCase.id };

  if (JUDGE) {
    // LLM-judged equivalence: paraphrases count, different facts do not.
    const verdict = await judgeCase(testCase.gold, predicted);
    for (const cat of categories) {
      const gold = testCase.gold[cat] ?? [];
      const preds = predicted[cat] ?? [];
      const pairs = Array.isArray(verdict[cat]) ? verdict[cat] : [];
      const matchedGold = new Set();
      let tp = 0;
      for (const pair of pairs) {
        if (
          pair && typeof pair.p === 'number' && typeof pair.g === 'number' &&
          pair.p >= 0 && pair.p < preds.length && pair.g >= 0 && pair.g < gold.length
        ) {
          tp++;
          matchedGold.add(pair.g);
        }
      }
      stats[cat].tp += tp;
      stats[cat].fp += preds.length - tp;
      stats[cat].fn += gold.length - matchedGold.size;
      caseResult[cat] = { gold: gold.length, predicted: preds.length, tp, fn: gold.length - matchedGold.size, judged: true };
    }
    perCase.push(caseResult);
    continue;
  }

  for (const cat of categories) {
    const gold = testCase.gold[cat] ?? [];
    const preds = predicted[cat] ?? [];
    const usedGold = new Set();
    let tp = 0;
    const fpItems = [];
    for (const pred of preds) {
      const hit = gold.findIndex((g, gi) => !usedGold.has(gi) && pred.includes(g));
      if (hit >= 0) {
        usedGold.add(hit);
        tp++;
      } else {
        fpItems.push(pred.slice(0, 60));
      }
    }
    const fn = gold.length - usedGold.size;
    stats[cat].tp += tp;
    stats[cat].fp += preds.length - tp;
    stats[cat].fn += fn;
    caseResult[cat] = { gold: gold.length, predicted: preds.length, tp, fn, fpItems };
  }
  perCase.push(caseResult);
}

function prf({ tp, fp, fn }) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    tp, fp, fn
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

const report = {
  engine: LLM
    ? 'llm-semantic-augmented (deepseek-v4-flash, same schema/prompt as TrajectoryDistiller L2)'
    : 'deterministic-fast (TrajectoryFilter + CorrectionExtractor, no LLM)',
  cases: cases.length,
  perCategory: Object.fromEntries(categories.map((c) => [c, prf(stats[c])])),
  macroF1: round(
    categories.reduce((sum, c) => sum + prf(stats[c]).f1, 0) / categories.length
  ),
  perCase
};

console.log(`Distillation quality — ${report.cases} labeled trajectories, ${LLM ? 'LLM (L2)' : 'deterministic (L1)'} engine\n`);
for (const cat of categories) {
  const m = report.perCategory[cat];
  console.log(
    `  ${cat.padEnd(13)} P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)}  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`
  );
}
console.log(`\n  macro F1 = ${report.macroF1.toFixed(3)}`);

const misses = perCase.flatMap((c) =>
  categories
    .filter((cat) => c[cat].fn > 0)
    .map((cat) => `${c.id}/${cat}: ${c[cat].fn} gold missed`)
);
const falsePositives = perCase.flatMap((c) =>
  categories
    .filter((cat) => (c[cat].fpItems ?? []).length > 0)
    .map((cat) => `${c.id}/${cat}: ${c[cat].fpItems.length} spurious → ${c[cat].fpItems[0]}`)
);
if (misses.length) console.log('\nMissed gold items:\n  ' + misses.join('\n  '));
if (falsePositives.length) console.log('\nSpurious extractions:\n  ' + falsePositives.join('\n  '));

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}`);
}

#!/usr/bin/env node
/**
 * Stress test: 5,000 memories in one store (the EFFECTS follow-up item).
 * Measures seeding throughput, retrieval latency percentiles, working-set
 * build latency, recall sanity for planted gold answers inside the noise,
 * and on-disk database size.
 *
 * Usage: node evals/stress-5k.mjs [--count 5000] [--json out.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MemoryStore } = await import(path.join(root, 'dist/storage/db.js'));
const { HybridRetriever } = await import(path.join(root, 'dist/core/hybrid-retriever.js'));
const { WorkingSetBuilder } = await import(path.join(root, 'dist/core/working-set.js'));
const { DEFAULT_CONFIG } = await import(path.join(root, 'dist/config.js'));

const countFlag = process.argv.indexOf('--count');
const COUNT = countFlag >= 0 ? Number(process.argv[countFlag + 1]) || 5000 : 5000;

// Deterministic pseudo-random (seeded LCG) so the corpus is reproducible.
let seed = 0x2f6e2b1;
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

const TOPICS = ['数据库', '缓存', '鉴权', 'CI', '部署', '日志', '测试', '网络', '序列化', '配置中心', '消息队列', '定时任务', '文件存储', '搜索引擎', '监控告警', '限流熔断', '灰度发布', '数据迁移', '接口网关', '前端构建'];
const VERBS = ['连接超时', '内存泄漏', '端口冲突', '证书过期', '版本不兼容', '权限不足', '编码错误', '死锁', '重试风暴', '缓存击穿'];
const FIXES = ['升级到最新稳定版', '增加重试与退避', '切换连接池实现', '调整超时参数', '启用双写迁移', '回滚上一个版本'];
const TOOLS = ['pnpm', 'docker compose', 'kubectl', 'curl', 'psql', 'redis-cli', 'jq', 'nginx'];

// 20 planted gold memories with their natural-language queries.
const GOLD = [
  { q: '生产环境数据库连接池耗尽怎么办', content: 'pgbouncer 连接池耗尽的解法是调大 default_pool_size 并对慢查询加 statement_timeout', sig: 'connection pool exhausted' },
  { q: 'redis 缓存雪崩怎么处理', content: '缓存雪崩的解法是给 TTL 加随机抖动并启用逻辑过期兜底', sig: 'cache avalanche' },
  { q: 'JWT 过期后刷新的坑', content: 'JWT 刷新并发竞态要用单飞队列，否则会签发多个不同有效期 token', sig: 'jwt refresh race' },
  { q: 'CI 里 flaky 测试的处理策略', content: 'CI flaky 测试先 quarantine 隔离再修复，不许重跑掩盖', sig: 'flaky ci quarantine' },
  { q: 'k8s 滚动更新卡住的排查', content: '滚动更新卡在 ContainerCreating 多半是镜像拉取限速，检查 pullQPS 与节点磁盘', sig: 'rollout stuck ContainerCreating' },
  { q: '日志盘写满的应急步骤', content: '日志盘写满先 logrotate 强转并用 journalctl --vacuum-size=500M 腾空间', sig: 'disk full logrotate' },
  { q: 'grpc 超时重试的配置原则', content: 'grpc 重试必须设每尝试 deadline 而不是总 deadline，否则重试会放大超时', sig: 'grpc retry deadline' },
  { q: '大 JSON 序列化卡主线程', content: '大对象序列化用 worker 线程流式处理，主线程只做拼装', sig: 'json serialization main thread block' },
  { q: '配置中心热更新的边界', content: '配置热更新只对无状态模块生效，连接类配置必须滚动重建', sig: 'config hot reload boundary' },
  { q: '消息队列消息堆积的处置', content: 'MQ 堆积先扩消费者并发，再查死信队列是否有毒丸消息', sig: 'mq backlog dead letter poison' },
  { q: 'cron 任务重复执行的防法', content: '分布式 cron 用分布式锁 + 幂等键双保险防重复执行', sig: 'cron duplicate distributed lock' },
  { q: '对象存储签名 URL 过期的预防', content: '签名 URL 有效期设为 15 分钟并在客户端做过期前刷新', sig: 'presigned url expiry' },
  { q: 'ES 查询慢的常见原因', content: 'ES 慢查询多半是深分页，改用 search_after + PIT', sig: 'es deep pagination slow' },
  { q: '告警风暴怎么压制', content: '告警风暴用告警聚合窗口 + 依赖拓扑抑制下游告警', sig: 'alert storm suppression' },
  { q: '限流算法选型', content: '分布式限流选令牌桶 + Redis Lua，滑动窗口日志量太大', sig: 'rate limit token bucket lua' },
  { q: '灰度发布卡在流量不切换', content: '灰度流量不切换先查 cookie 种子哈希是否稳定，再看网关规则优先级', sig: 'canary traffic not switching' },
  { q: '双写迁移的一致性校验', content: '双写迁移必须夜里跑对账脚本，白天只抽样', sig: 'dual write reconciliation' },
  { q: '网关 502 但后端健康', content: '网关 502 后端健康多是 keep-alive 超时不匹配，网关要短于后端', sig: 'gateway 502 keepalive mismatch' },
  { q: '前端构建内存溢出', content: '前端构建 OOM 用 NODE_OPTIONS=--max-old-space-size=8192 并开启构建缓存', sig: 'webpack heap oom' },
  { q: 'pnpm 装依赖对不齐', content: 'pnpm 依赖错位用 pnpm why 追链路并锁定 overrides', sig: 'pnpm dependency drift' }
];

const dbFile = path.join(root, 'evals/results/stress-5k.db');
try {
  (await import('node:fs')).rmSync(dbFile);
} catch {}
const store = new MemoryStore({ ...DEFAULT_CONFIG, storage: { workspaceDbPath: dbFile } }, dbFile);
const retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);

console.log(`Stress test — seeding ${COUNT} memories (deterministic corpus + ${GOLD.length} planted gold)...`);
const t0 = Date.now();

// Noise corpus.
for (let i = 0; i < COUNT - GOLD.length; i++) {
  const topic = pick(TOPICS);
  const verb = pick(VERBS);
  const tier = pick(['semantic', 'episodic', 'procedural', 'episodic']);
  const content =
    tier === 'procedural'
      ? `${topic}的运维流程：先用 ${pick(TOOLS)} 检查状态，再 ${pick(FIXES)}，最后验证 ${topic} 指标恢复正常`
      : `${topic}模块${verb}：根因是${pick(FIXES)}相关配置不当，解法是${pick(FIXES)}并复测`;
  await store.createMemory({
    tier,
    category: tier === 'episodic' ? 'post_mortem' : tier === 'procedural' ? 'workflow' : 'rule',
    scope: rnd() < 0.3 ? 'global' : 'workspace',
    content,
    summary: `${topic}${verb}`,
    entity_key: rnd() < 0.5 ? `${topic}.${verb}`.slice(0, 40) : undefined,
    error_signature: tier === 'episodic' ? `${pick(TOOLS)} ${verb}` : undefined,
    importance: 1 + Math.round(rnd() * 40) / 10,
    status: 'verified'
  });
  if ((i + 1) % 1000 === 0) console.log(`  seeded ${i + 1}`);
}

// Planted gold (verified, decent importance).
const goldIds = [];
for (const g of GOLD) {
  const created = await store.createMemory({
    tier: 'episodic',
    category: 'post_mortem',
    scope: 'global',
    content: g.content,
    summary: g.content.slice(0, 40),
    error_signature: g.sig,
    importance: 4.5,
    status: 'verified'
  });
  goldIds.push(created.id);
}

const seedMs = Date.now() - t0;
console.log(`seeded in ${(seedMs / 1000).toFixed(1)}s (${Math.round(COUNT / (seedMs / 1000))} ops/s)`);

// Retrieval latency + recall over the noise.
const latencies = [];
let goldHit5 = 0;
let goldHit10 = 0;
for (let i = 0; i < GOLD.length; i++) {
  const t = Date.now();
  const results = await retriever.retrieve(GOLD[i].q, { topK: 10, includeTentative: true });
  latencies.push(Date.now() - t);
  const ids = results.map((r) => r.memory.id);
  if (ids.slice(0, 5).includes(goldIds[i])) goldHit5++;
  if (ids.includes(goldIds[i])) goldHit10++;
}
// Distractor queries for more latency samples.
for (const topic of TOPICS) {
  const t = Date.now();
  await retriever.retrieve(`${topic}最近有什么坑`, { topK: 6, includeTentative: true });
  latencies.push(Date.now() - t);
}
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];

// Working-set build latency.
const wsTimes = [];
for (let i = 0; i < 10; i++) {
  const t = Date.now();
  new WorkingSetBuilder(store, DEFAULT_CONFIG.retrieval).buildWorkingSet('src/app.ts', 'main');
  wsTimes.push(Date.now() - t);
}
wsTimes.sort((a, b) => a - b);

const { statSync } = await import('node:fs');
const dbSize = statSync(dbFile).size;

const report = {
  memories: COUNT,
  engine: `store+retriever at ${store.getEmbeddingAdapter().mode} embeddings`,
  seeding: { seconds: round(seedMs / 1000), opsPerSecond: Math.round(COUNT / (seedMs / 1000)) },
  retrievalMs: { samples: latencies.length, p50: pct(50), p95: pct(95), p99: pct(99), max: latencies[latencies.length - 1] },
  goldRecall: { at5: round(goldHit5 / GOLD.length), at10: round(goldHit10 / GOLD.length) },
  workingSetBuildMs: { median: wsTimes[Math.floor(wsTimes.length / 2)], max: wsTimes[wsTimes.length - 1] },
  dbSizeBytes: dbSize
};

function round(n) {
  return Math.round(n * 1000) / 1000;
}

console.log('\n=== 5K stress results ===');
console.log(JSON.stringify(report, null, 2));

store.close();

const outFlag = process.argv.indexOf('--json');
if (outFlag >= 0 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}`);
}

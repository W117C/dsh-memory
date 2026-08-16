# Changelog

## 2.4.0 — 官方基准 + 压测 + 评测口径完善（后续清单清零）

### 新增

- **LongMemEval-S 官方子集评测**（`evals/longmemeval-subset.mjs`）：真实数据 50 题×租户级 haystack（原文不蒸馏），**evidence@1 = 0.84**、answer-substring@5 = 0.76；数据首跑自动下载。
- **5K 记忆压力测试**（`evals/stress-5k.mjs`）：确定性合成语料 + 植入金标；检索 p50/p95/p99 = 6/10/14ms，工作集中位 4ms，写入 149 ops/s，库 37.8MB。
- **PRF 伪相关反馈**（`retrieval.prf`，**默认关**）：首轮 top-3 实体扩展查询的二轮检索；自建基准实测负收益（0.80→0.60，rich-get-richer），按证据默认关闭、留开关。
- **L2 蒸馏 LLM-judge 口径**（`evals/distill-quality.mjs --judge`）：等价判定代替子串匹配，L2 macro F1 0.313→**0.507**（召回 0.75–1.00、精确率低=过度抽取，支持 L1 常驻架构）。
- **检索器重构**：信号收集（向量+BM25 max 合并）与候选打分拆分为可复用私有方法，支撑 PRF/多查询扩展。

### 变更

- FTS/向量候选池从 `topK*3` 扩到 `topK*4`（多查询合并需要更大并集）。
- `evals/longmem-mini.mjs` 改写结果磁盘缓存（`evals/results/rewrite-cache.json`），基准重跑确定。

## 2.3.0 — 语义检索升级：多跳 both-gold@5 0.60 → 0.80

### 新增

- **本地 ONNX 嵌入修复与加固**：自动清理损坏/截断的模型缓存并重试（此前半个 model.onnx 会让加载永久失败回退哈希嵌入）；加载超时可配（`embedding.loadTimeoutMs`，默认 20s）；插件启动即后台预热（首次召回不再付加载成本）；`adapter.mode` 暴露实际运行模式（onnx-local / remote / deterministic-hash）。
- **Flash 查询改写（`retrieval.queryRewrite`，默认关）**：口语化/抽象查询先经一次 Flash 调用改写为关键词行；**双查询 max 合并**（原查询+改写查询各检索一遍、按 id 取最大分，坏改写永不丢分）；改写调用显式 `thinking: disabled`（实测 V4 thinking 会吞掉小 max_tokens 调用的正文）；失败自动回退原查询；成本入账（purpose=query-rewrite）。
- **内容侧向量**：文档嵌入从「summary+keys」扩展为「summary+keys+正文前 300 字」，摘要过短导致的语义信号不足被补齐。
- **纠错检索加成**：`category=correction` 记忆主题命中时 +0.05 有界加成（用户亲授事实优先，对齐工作集纠错专区）。
- **L2 解析加固**：蒸馏 JSON 解析器增加尾逗号修复（真机偶发）。
- **L2 LLM 蒸馏质量评测**（`evals/distill-quality.mjs --llm`）：macro F1 0.313（子串口径惩罚转述；见 EFFECTS §2 注——结论支持「L1 常驻 + L2 定向触发」的现有架构）。

### 实测（EFFECTS.md 已更新）

- 多跳 both-gold@5：**0.60 → 0.80**（升级链单变量数据见 EFFECTS §4）；any-gold@5 = 1.00。
- 单跳：recall@1/3/5 = 1.00、MRR 1.00、跨项目泄漏 0（ONNX 模式）。

### 测试

- 91 → 94 项：查询改写 max 合并 3（强改写救援 / 垃圾改写不丢分 / 抛错降级）。

## 2.2.0 — 效果实测 + 自用体验层 + 编排集成面（P0–P3）

### 新增

- **效果实测（EFFECTS.md）**：四套可复现评测 harness——真机 KV 缓存命中率（`evals/kv-hit-rate.mjs`：two-tier 95.5% ≈ baseline 94.7%，朴素重写 71.5%/成本 4.5×）、蒸馏质量（11 条标注轨迹 macro F1 1.000）、单跳召回（recall@5=1.00、跨项目泄漏 0）、多跳基准（both-gold@5=0.60，暴露哈希嵌入语义缺口）。
- **用户级作用域**：默认单一用户库 `~/.dsh/memory.db`；`origin_cwd` 记录写入项目，workspace 记忆仅在本项目可见，`scope='global'` 记忆跨项目跟随用户；旧数据（origin `*`）保持全局可见；工作集/检索/合并/子代理合并全部按来源过滤。
- **纠错专项抽取（correction-extractor）**：识别「用户否定 → 行为修正」对，类别 `correction`、scope `global`、立即 `verified`（用户 authored 高信任）；L1 确定性 + L2 LLM schema（`user_corrections`）双通道；工作集顶部新增 `[User Corrections]` 最高优先级分区；指令轨道让位于纠错轨道避免双写。
- **Markdown 人类可读投影**：`exportMarkdown()/importMarkdown()`（MEMORY.md 索引 + 每条记忆一个 frontmatter 文档，按 id 幂等回导：新增/更新/无变化）；HTTP `GET /export?format=markdown`、`POST /import {files|markdown}`；SQLite 仍是唯一真相源。
- **成本观测**：`CostTracker`（`llm_usage` 台账 + 峰谷感知计价，官方 2026-08-16 价目）；蒸馏/合并调用与每会话注入估算自动入账；HTTP `GET /cost?days=`；估算值带 `estimated` 标记。
- **谷时调度**：`distillation.offPeakOnly`（默认关）把会话蒸馏推迟到下一谷时窗口（半价），`maxDeferHours` 兜底（默认 16h）；峰时=UTC 01–04/06–10。
- **dsh-ultra 编排集成面（P2）**：`GET /working-set?filePath=&branch=`（同输入字节级一致 → 全体子代理共享前缀缓存）+ 子代理 fiber 四端点 `POST /subagent/{context,stage,merge,discard}`（并行子代理记忆 3-way 合并）。

### 变更

- **默认库路径**从每项目 `.dsh/memory.db` 改为用户级 `~/.dsh/memory.db`（workspace 隔离改由 origin_cwd 承担）；旧项目库迁移：`GET /export` 导出 JSONL → 新库 `POST /import`。
- 嵌入模型加载结果模块级缓存：多 store 进程不再重复 3s 加载超时竞速。
- fiber 并发碰撞窗口 `updated_at >` → `>=`（同毫秒写入也计为并发）。
- `/import` 缺字段错误信息改为 `jsonl or markdown required`。

### 测试

- 71 → 91 项：markdown 投影 3、user 级作用域 3、纠错抽取 4、峰谷计价+成本台账 5、编排/成本/投影 HTTP 面 5。

## 2.1.0 — 顶级开源记忆能力包（对标 mem0 / Zep / Cognee）

### 新增

- **LLM 合并引擎**（`src/core/consolidator.ts`）：`remember()` 写入路径升级为 mem0-class 决策流——检索相似候选 → DeepSeek-V4 推断每条 ADD / UPDATE / DELETE / NONE → 原子应用；无 `llm` 服务或调用失败自动回退确定性冲突消解，写入永不失败（`consolidation.llmAssisted` 可关）。
- **变更历史日志**（`memory_history` 表）：`created / updated / promoted / deprecated / deleted` 全事件自动记录，含 before/after 投影；`service.getHistory / getAllHistory` 与 `GET /api/memory/history` 可查。
- **实体图谱增强**（`src/core/entity-extractor.ts`）：写入时抽取反引号命令、点分键、文件路径、UPPER_SNAKE、PascalCase、错误签名等实体并建立 `mentions` 边；与 `supersedes` 共同构成知识拓扑，面板图谱直接可视化（`consolidation.extractEntities` 可关）。
- **可携带性**（`src/core/portability.ts`）：`rememberBatch()` 批量写入；`exportJsonl() / importJsonl()` 无损 JSONL 导出导入。
- **HTTP 端点**：`/api/memory/history`、`/api/memory/export`、`/api/memory/import`、`/api/memory/remember/batch`；`/api/memory/remember` 返回合并决策明细。
- **工具增强**：`memory_remember` 返回 `events` 与 `engine` 字段（合并透明度）。

### 变更

- `MemoryService.remember()` 由确定性消解升级为合并引擎路径（行为向下兼容：确定性路径为回退分支）。
- `registerMemoryTools` 第二参数由 `ConflictResolver` 改为 `RememberEngine`。

### 测试

- 45 → 71 项：新增历史日志 6、LLM 合并 6、实体图谱 4、可携带性 5、HTTP 能力端点 5。

## 2.0.0 — dsh 原生化改造

- 运行时迁移至真实 `@deepseek-ai/cordis@4.0.1`；全部 dsh 能力改为可选服务消费。
- 注入原生化：`systemPrompt.section`（稳态）+ `context`（动态快照），不再改写请求。
- 工具走真实 `tools.register`，含 canonical `output` 与 `deferContext`。
- 事件契约对齐 `session/created|event|disposed`。
- 蒸馏默认 `deepseek-v4-flash`（`deepseek-official` 路由），走 `ctx.llm.stream()`。
- 原生 Web UI：`dsh.client` 浏览器半体 + `settings.section` 面板 + 同源 `/api/memory`。

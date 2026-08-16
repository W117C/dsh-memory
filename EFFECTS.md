# EFFECTS — 实测效果报告（v2.2.0 + v2.3.0 检索升级）

> 2026-08-17 实测。全部数字来自本仓库 `evals/` 下的可复现脚本（每节附复现命令）。
> 环境：DeepSeek 官方 API（`api.deepseek.com`），模型 `deepseek-v4-flash`，实测时谷时计价；macOS arm64，Node 22。

---

## 1. KV 缓存命中率：双层注入不伤缓存（核心结论 ✅）

**问题**：把记忆注入 system prompt 会不会破坏 DeepSeek V4 的服务端前缀缓存（命中:未命中 ≈ 1:60 的成本杠杆）？

**方法**：同一 8 轮会话，三种注入策略直接打真机 API，读 `usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens`：

| 策略 | 做法 | 命中率 | 未命中 token | 输入成本/会话 |
|---|---|---|---|---|
| baseline | 固定 system（≈1.8K token 稳定前缀），无记忆 | **94.7%** | 580 | $0.0002 |
| **two-tier（本插件设计）** | Tier1 冻结工作集进 system + Tier2 召回文本后置于当轮 user 消息 | **95.5%** | 640 | $0.0002 |
| naive（反模式） | 每轮重排重写 system 里的记忆块 | **71.5%** | 3,676 | $0.0009 |

**结论**：
1. **two-tier 与 baseline 命中率持平（95.5% vs 94.7%）**——双层注入在带记忆的同时不损失缓存命中，冻结的工作集反而加长了可命中前缀（绝对命中 token 13,568 vs 10,368）。
2. 朴素重写损失 24 个百分点命中率，**未命中量 5.7 倍、输入成本 4.5 倍**。会话越长、system 越大，差距线性放大。
3. 注意一个微妙点：**「追加式」更新记忆块并不破坏前缀**（共同前缀检测会保住前段）；真正的反模式是**每轮重排/重写**（工作集重排序、时间戳头）。因此插件的工作集在会话内字节级冻结（`WorkingSetBuilder` 会话缓存）是必要设计，跨会话不冻结也没关系（缓存本就数小时过期）。

复现：`node evals/kv-hit-rate.mjs --json evals/results/kv-hit-rate.json --turns 8`（需环境变量 `DEEPSEEK_API_KEY`）

---

## 2. 蒸馏质量：L1 确定性 macro F1 = 1.000；L2 LLM = 0.313（后者为口径惩罚，见注）

**方法**：`evals/data/distill-eval.jsonl`，11 条中英混合轨迹（含隐性纠错、无恢复错误、噪声轮），金标为人工标注的应抽取项。L1 跑真实 `TrajectoryFilter + CorrectionExtractor`；L2 用与 `TrajectoryDistiller.distillWithLlm` 相同的 schema/prompt 直连 `deepseek-v4-flash`。

**L1（确定性，生产默认）**：

| 类别 | 精确率 | 召回率 | F1 |
|---|---|---|---|
| 指令 directives | 1.00 | 1.00 | 1.00 |
| 复盘 post_mortems | 1.00 | 1.00 | 1.00 |
| 配方 recipes | 1.00 | 1.00 | 1.00 |
| 纠错 corrections | 1.00 | 1.00 | 1.00 |
| **macro F1** | | | **1.000** |

**L2（LLM 增强，仅复杂沙箱错误时触发）**：子串口径 macro F1 = **0.313**；**LLM-judge 等价口径 macro F1 = 0.507**（召回 0.75–1.00，精确率 0.11–0.80）。⚠️ 口径注：子串匹配惩罚 LLM 转述；judge 口径（每题一次 Flash 判定「预测项与哪条金标等价」）给出公平数字。**定位清晰：L2 的问题不是理解（召回高）而是过度抽取（把规则性背景也抽出）——在这套金标下 L1 更准、更便宜、更快；现有架构（L1 常驻 + L2 定向触发）正确。**

**诚实口径**：自建小集与抽取器共同设计——调优前 L1 基线 0.929，补齐两个常见中文标记后达 1.000。真实世界轨迹必然低于此，此集定位是回归基线。未恢复错误（error 无后续成功）确认零误报。另发现 L2 偶发尾逗号坏 JSON（评测与插件解析器均已加修复）；judge 调用同样必须 `thinking: disabled`（否则推理吞 token 截断 JSON——与查询改写同一坑）。

复现：`node evals/distill-quality.mjs --json ...`（L1）/ `--llm --judge --json ...`（L2+judge，需 `DEEPSEEK_API_KEY`）

---

## 3. 单跳召回：recall@1/3/5 = 1.00，跨项目泄漏 = 0（ONNX 语义嵌入）

**方法**：8 个「上周踩坑今天必须想起」场景（错误签名、规则、纠错优先、分支可见性、跨项目泄漏、tentative 抑制），真实 `MemoryStore + HybridRetriever`，topK=5。

- recall@1 / @3 / @5 = **1.00 / 1.00 / 1.00**，MRR = **1.00**（本地 ONNX bge-small-zh 语义嵌入模式）
- **跨项目泄漏 = 0**（`origin_cwd` 指向其它项目的 workspace 记忆未出现在任何召回中——user 级作用域的隔离面正确）
- tentative 的未验证解法稳定排在 verified 之后（s08）
- 纠错记忆享有 +0.05 有界加成（用户亲授事实，主题命中时优先）——对齐工作集顶部的纠错专区

复现：`node evals/recall-quality.mjs --json evals/results/recall-quality.json`

---

## 4. 多跳检索（LongMemEval 风格自建子集）：both-gold@5 = 0.90 ✅（0.60 → 0.90）

**方法**：16 条共享记忆 + 10 个需要**两条**记忆才能回答的问题（对比类/流程类），测双金标覆盖率。**升级链**（每一环都有单变量数据）：

| 配置 | both-gold@5 | any-gold@5 |
|---|---|---|
| 哈希嵌入降级（v2.2.0 基线） | 0.60 | 0.80 |
| 仅换 ONNX 语义嵌入 | 0.60 | 0.90 |
| + 内容侧向量（正文前 300 字参与嵌入）+ 查询改写 | 0.70 | 0.90 |
| + 双查询 max 合并 + 纠错加成（**v2.3.0 最终**） | **0.80** | **1.00** |
| + 写入端主题词补全（**v2.5.0，--topics**） | **0.90** | **1.00** |

both-gold@8 = 0.90（写入端主题词后 **both-gold@8 = 1.00**）。关键实测教训（已固化进代码）：
1. **V4 默认 thinking 模式会吞掉小 max_tokens 调用的 content**（推理占满 64 token 后正文被截断）——查询改写这类辅助调用必须 `thinking: {type:'disabled'}`；
2. 改写提示词需要 few-shot + 「禁止复读原句」约束，否则模型偷懒回显；
3. 双查询 max 合并保证**坏改写永不丢分**（有专门单测覆盖）。

**剩余 3 个 miss 的共性 = 语料冷词表**：改写器不可能猜到库里恰好存了 vitest/ADR/路径别名这些词（查询与记忆词汇零重合）。**v2.5.0 写入端主题词补全已关闭此问题**（见下方 PRF 后记）：写路径让 L2 蒸馏在同一次调用内输出每条记忆的 `topics`（含查询侧的近义桥词，如「测试框架崩溃」对应 `vitest`），并入 FTS 与嵌入文本后，q2/q7/q9 三个冷词表 miss 全部转绿（both-gold@5 0.70→0.90，纯 ONNX 无改写口径）。

复现：`node evals/longmem-mini.mjs [--topics] [--rewrite] --json ...`（`--topics` 模拟 L2 写侧主题词；需 `DEEPSEEK_API_KEY` 时才用 `--rewrite`；均磁盘缓存/确定性，重跑确定）

**PRF 后记（已闭环）**：伪相关反馈（首轮 top-3 实体扩展再检索，`retrieval.prf`）实测 **0.80 → 0.60（负收益，rich-get-richer）**，保持默认关。冷词表 miss 的更优解——**写入端补主题词**——已在 v2.5.0 落地（L2 LLM `topics` + L1 确定性 `deriveTopicKeywords`，零额外调用成本）。

---

## 6. 5K 记忆压力测试：检索 p95 = 10ms，工作集 4ms ✅

**方法**：5,000 条合成记忆（20 主题 × 3 层混合，确定性种子）+ 20 条植入金标，真实 store+retriever，ONNX 嵌入。

| 指标 | 数值 |
|---|---|
| 写入吞吐 | 149 ops/s（含 ONNX 嵌入，5000 条 33.5s） |
| 检索延迟（40 次采样） | p50 = 6ms，p95 = 10ms，p99 = 14ms |
| 工作集构建 | 中位 4ms / 最大 7ms |
| 金标召回（5K 噪声中） | recall@5 = 0.70，@10 = 0.75 |
| 库大小 | 37.8MB |

金标召回的口径：噪声与金标同域同构（4980 条同主题 post-mortem），这是有意的困难设定；未开查询改写。

复现：`node evals/stress-5k.mjs --json evals/results/stress-5k.json`

---

## 7. LongMemEval-S 官方子集：evidence@1 = 0.84 ✅

**方法**：真实 LongMemEval-S（weaviate 镜像，原 xiaowu0162/longmemeval）50 题；每题对其租户的全部会话（约 48 条/租户，**原文不做蒸馏**）建库，测检索层能否把含答案的证据会话排进 top-k。

| 指标 | 数值 |
|---|---|
| evidence@1 | **0.84** |
| evidence@3 / @5 / @10 | 0.86 / 0.86 / 0.86 |
| answer-substring@5 | 0.76 |

**口径**：这是**检索层证据召回**，不是 LongMemEval 官方的端到端 QA 指标（那需要 LLM 通读后作答）；但 84% 的金标会话被直接排到第一位，说明真实对话式长记忆数据上混合检索本身是够用的，短板（若有）在写入蒸馏与作答层。数据文件首跑自动下载（~250MB）到 `evals/data/`。

复现：`node evals/longmemeval-subset.mjs --n 50 --json evals/results/longmemeval-subset.json`

---

## 8. 端到端 QA（LongMemEval-S 官方作答式）：检索 0.85 / 作答 0.35 ✅（口径落地，短板定位）

**方法**（v2.5.0 新增 `evals/longmemeval-e2e.mjs`）：对每题的租户 haystack 建库 → 混合检索 top-5 证据会话 → Flash 作答（`thinking: disabled`）→ Flash judge 判定与金标等价。**检索层与作答层分离计分 + 失败分诊**（retrieval-miss / answer-miss / ok），作答磁盘缓存保证重跑确定；gate 阈值先声明（evidence@5 ≥0.80、answer-judge@5 ≥0.80）。

| 运行 | 证据窗口 | 作答提示词 | evidence@1/3/5 | answer-substring@5 | answer-llm-judge@5 |
|---|---|---|---|---|---|
| r1 | 1200 字/会话 | 默认（有就答） | 0.80/0.85/0.85 | 0.10 | 0.10 |
| r2 | 3000 字/会话 | 默认 | 0.80/0.85/0.85 | 0.20 | 0.25 |
| r3 | 3000 字/会话 | 抽取式（少拒答） | 0.80/0.85/0.85 | 0.30 | **0.35** |

**失败分诊（r3，20 题）**：retrieval-miss 3、answer-miss 10、ok 7。三条可归因结论：

1. **检索层不是短板**（evidence@5 = 0.85 稳定）——印证 §7 假设「混合检索本身够用」；
2. **证据压实是短板之一**：LongMemEval 会话是多轮长对话，答案常在头部窗口之外（r1→r2 窗口翻 2.5 倍，作答从 0.10 → 0.25）；
3. **作答层（提示词/拒答倾向）是另一个短板**：即使答案在证据内，默认提示词也常错答 `NO_ANSWER`（抽取式提示词 r2→r3 又提升 0.25 → 0.35）。**「整会话检索 + 头窗口截断 + 简单作答」组合下作答层是当前瓶颈**，后续方向：检索改粗到细（先会话后定位关键段落）、作答改检索增强（RAG 定位）+ 更强抽取提示。

成本：20 题 × 5 证据 × 3000 字 ≈ 6.9 万 billed token（Flash，< $0.05）。

复现：`node evals/longmemeval-e2e.mjs --n 20 --evl 3000 --fresh --json ...`（需 `DEEPSEEK_API_KEY`）

---

## 5. 成本模型（峰谷计价，官方 2026-08-16 价目）

| $/1M token | Pro 峰 | Pro 谷 | Flash 峰 | Flash 谷 |
|---|---|---|---|---|
| 输入（缓存命中） | 0.022 | 0.011 | 0.014 | 0.007 |
| 输入（未命中） | 1.32 | 0.66 | 0.44 | 0.22 |
| 输出 | 3.96 | 1.98 | 1.32 | 0.66 |

峰时 = UTC 01–04 / 06–10（= 北京时间 09–12 / 14–18，**白天工作时段全是峰时**）。

量级结论（对应 `CostTracker` 的计价口径）：
- 500K token 会话轨迹的 Flash 蒸馏（谷时未命中）：**≈ $0.11**；带前缀命中更低——记忆写入成本可忽略。
- 注入侧：本轮实测 8 轮会话的 two-tier 注入输入成本 **$0.0002**（Flash）——记忆的持有成本同样可忽略，**真正的成本杠杆只有「不破坏前缀缓存」一件事**（见第 1 节 4.5 倍差距）。
- `distillation.offPeakOnly: true` 可把批量蒸馏推迟到谷时（半价），上限 `maxDeferHours`（默认 16h）。

---

## 后续（按优先级）

1. ~~语义嵌入缺口~~ **已关闭**（v2.3.0，0.60→0.80）。
2. ~~PRF 冷词表方案~~ **已试已否**（实测 0.80→0.60，默认关；写入端补主题词是更优解）。
3. ~~LongMemEval 官方子集~~ **已完成**（evidence@1 0.84，§7）。
4. ~~5K 压测~~ **已完成**（p95 10ms，§6）。
5. ~~L2 的 LLM-judge 口径~~ **已完成**（macro F1 0.507，定性为过度抽取，§2）。
6. ~~写入端主题词补全~~ **已关闭**（v2.5.0：L2 LLM `topics` + L1 `deriveTopicKeywords`；both-gold@5 0.70→0.90，§4）。
7. ~~端到端 QA 口径~~ **已完成**（v2.5.0：`evals/longmemeval-e2e.mjs` 作答+judge 分层，§8）。

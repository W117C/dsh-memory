# dsh 记忆系统：调研结论与下一阶段方案

> **执行状态（2026-08-17）：P0–P3 及后续清单已全部落地**，实现与实测见 `/Users/ze/Downloads/dsh记忆系统`（GitHub W117C/dsh-memory，tag v2.4.0；EFFECTS.md 有全部数字）。本文档保留为当时的调研与规划记录；最新状态以仓库 CHANGELOG / EFFECTS / AGENTS.md 为准。
>
> 2026-08-17 调研。本方案基于三个输入：① DeepSeek V4 / dsh 官方资料核实；② dsh 记忆类插件生态扫描；③ 业界记忆系统先例（Claude Code auto memory / memorax-code / mem0 / Letta / Zep）。
> **重要前提**：`@dsh-plugins/memory` v2.1.0 已在另一会话（`/Users/ze/Downloads/dsh记忆系统`）完成开发并进入发布收尾，功能面对标 mem0/Zep/Letta。因此本方案**不是从零设计**，而是：核实其架构与 V4/dsh 事实的对齐度 → 找缺口 → 给下一阶段（v2.2/v3）路线图。用户目标定位：**自用提质**（非商业化优先）。

---

## 一、结论先行

1. **v2.1.0 的核心架构判断是对的**，且被本次官方文档核实背书：DeepSeek 服务端 KV 缓存是「自动、完整前缀匹配、best-effort」——「稳态分区字节级冻结 + 动态内容走后置 context/工具」是唯一兼顾记忆性与缓存命中的注入姿势，v2.1.0 的双层注入（Tier 1 section + Tier 2 deferContext 快照）正是这么做的。
2. **主要缺口不在功能面**（功能已超生态竞品），而在三处：
   - **效果未实测**：KV 命中率、蒸馏精确率、召回质量都是设计推断，没有数字；
   - **自用体验层薄弱**：没有人类可读投影（可审计/可手改/可 git）、用户级跨项目记忆作用域不明确、「记住纠错」只有部分覆盖、成本不可见;
   - **联动未开始**：与 dsh-ultra 编排层（同生态的兄弟项目）互不相认。
3. **形态推荐**：维持「SQLite 为唯一真相源」的引擎核，**叠加 Markdown 人类可读投影层**——检索能力（向量+BM25+图谱）与自用可审计性不冲突，投影是导出/回导视图而非第二存储。

---

## 二、调研事实（核实版）

### 2.1 DeepSeek V4 与记忆相关的特性

| 项目 | 事实 | 来源 | 对记忆系统的推论 |
|---|---|---|---|
| 上下文 | 1M 标配（token-wise compression + DSA 稀疏注意力），最大输出 384K | V4 公告 + 价格页 | 召回可以「宽进」：多召回一些再让 DSA 消化，不必激进截断 |
| KV 缓存 | **自动开启**；命中要求**完整前缀匹配**（缓存按独立完整单元存储）；公共前缀检测 + 请求边界 + 固定 token 间隔切单元；best-effort，闲置「数小时到数天」自动清除 | 官方 caching 文档 | ① system prompt 内记忆区必须会话内冻结；② 动态记忆放后置消息/工具结果，不碰前缀；③ 缓存会过期，跨会话命中率本就低，不必为跨会话命中优化 |
| 价格（$/1M，峰/谷） | Pro：命中 0.022/0.011，未命中 1.32/0.66，输出 3.96/1.98；Flash：命中 0.014/0.007，未命中 0.44/0.22，输出 1.32/0.66；**谷时=半价** | 价格页 | 命中:未命中 ≈ 1:60（Pro）/1:31（Flash）→ 前缀稳定性是第一成本杠杆；蒸馏/合并全走 Flash |
| 峰谷时段 | 峰时 UTC 01:00–04:00、06:00–10:00（= 北京时间 09:00–12:00、14:00–18:00） | 价格页 | **你的白天工作时间全是峰时**；夜间（北京 18:00–次日 09:00 + 午间）为谷时 → 批量 consolidation 排到夜里，成本直接减半 |
| 双模/effort | Thinking/Non-Thinking；effort low/high/max；带工具调用时 `reasoning_content` 必须原样回传否则 400；thinking 下不支持采样参数 | thinking 指南（dsh-ultra 调研已核） | 记忆的后台 LLM 调用（蒸馏/合并）用 low effort + Non-Thinking 即可，省钱提速；适配器必须处理 reasoning_content 规则 |
| Agent 能力 | V4-Pro 开源 SOTA（agentic coding）；Flash 简单 agent 任务 ≈ Pro | V4 公告 | 蒸馏/抽取/合并这类「简单 agent 任务」用 Flash 无质量损失 |

**成本量级估算**（供 P0 实测对标）：一条 500K token 的会话轨迹，用 Flash 谷时未命中价蒸馏 = $0.11；若 system 前缀命中则更低。即**记忆的写入成本可以忽略不计，真正的成本在主会话的注入侧**——这正是 Tier 1 必须冻结的原因。

### 2.2 dsh 集成点（已核实契约，v2.1.0 已全部对接）

- 插件 = 导出 `apply(ctx)` 的 Cordis 模块；`export const inject = [...]` 声明服务依赖；`ctx.effect()` 注册清理；服务三种形态（函数/对象/Service 类）。
- 关键服务与事件：`tools.register()`（含 canonical output + `exec.deferContext()`）、`systemPrompt.section()/context()`、`httpServer` 前缀路由、`ctx.llm.stream()`、会话事件 `session/created | session/event | session/disposed`。
- Web UI：`dsh.client: { platform: 'web' }` + `settings.section` 官方插槽。
- **append-only 会话日志**：官方明确「模型看到的一切都会写入」（系统提示词、思维链、工具调用与结果、子代理调度、上下文注入），resume/fork/replay 共享同一事件流——这是记忆蒸馏的**完美原料**，也是 v2.1.0 trajectory-filter 所消费的数据源。
- LOOP 深冻结：改写 LLM 请求即抛错 → 只能通过提示词贡献者参与组装（v2.1.0 的选择正确）。

### 2.3 生态竞品（dsh-plugin topic 约 1000+ 项目中的记忆类）

| 插件 | 形态 | 要点 | 与我们的差异 |
|---|---|---|---|
| graph-memory（★519） | 知识图谱 | 对话→三元组，宣称压缩 75% 上下文；OpenClaw 兼容 | 纯图谱无验证门禁；无 KV-cache 意识 |
| mnemon（★455） | 独立 CLI | LLM 监督的持久记忆、图召回、单二进制、多 harness | 外挂进程，非 Cordis 原生 |
| dsh-memory-evolve（★93） | dsh 插件 | 五轨记忆、git 分支感知、后台自我进化 | 无 LLM 合并引擎证据、无防毒化门禁 |
| dsh-noema（★61） | MCP | 可检查记忆 + recall 工具 + 设置页 | 走 MCP 通道，非原生工具 |
| dsh-statecore | dsh 插件 | auto-ingest/auto-inject + 5 工具、可审计状态 | 无 bi-temporal/图谱/合并决策 |

**定位结论**：v2.1.0 的「KV-cache 原生 + tentative→verified 防毒化 + LLM 合并双引擎」组合在生态内独有，**不需要为差异化改架构**，需要的是把「效果」做成可展示的数字。

### 2.4 业界先例要点（设计与运营借鉴）

- **Claude Code auto memory**（官方文档）：MEMORY.md 自写自读、按项目分目录、分层于手写 CLAUDE.md 之上；最受好评的能力是**记住用户的纠错**（「下次别再犯」）。→ 自用提质的本质就是这个体验。
- **memorax-code**（★307，本项目灵感来源之一）：四类记忆边界（Coding/Repo/Personal/Procedure）、后台自动写回（无二次确认，有披露）、**自动检索默认关闭需显式开启**、隐私边界只上传用户指令+最终回复。→ 「检索默认 opt-in」是对抗记忆污染注入的运营经验；四类边界与我们四子系统几乎同构，验证了分类法。
- **mem0**：写入即合并（ADD/UPDATE/DELETE/NONE）——v2.1.0 已实现且加了确定性回退，更强。
- **Letta/MemGPT**：记忆分层 + 自编辑记忆工具——v2.1.0 的 4 工具已覆盖。
- **Zep/Graphiti**：bi-temporal（valid_from/invalid_at）+ edge invalidation 而非删除——v2.1.0 已实现。
- **共性设计决策清单**（我们都已回答）：写什么（偏好/事实/反馈/任务结论）｜何时写（实时工具 + 会话后批量蒸馏）｜怎么召回（索引进前缀 + 按需检索 + 图谱扩展）｜怎么防毒化（验证门禁，业界独有）｜怎么遗忘（软删 + bi-temporal）。

---

## 三、现状评估：v2.1.0 对调研结论的覆盖度

| 调研要点 | 覆盖 | 说明 |
|---|---|---|
| KV-cache 友好注入 | ✅ | Tier 1 冻结 section + Tier 2 deferContext 快照，与官方「完整前缀匹配」语义精确对齐 |
| 蒸馏走 Flash | ✅ | L2 默认 deepseek-v4-flash，失败回退 L1 规则通道 |
| 会话轨迹为原料 | ✅ | trajectory-filter 消费 session 事件流 |
| 写入即合并 + 审计 + bi-temporal + 图谱 | ✅ | consolidator / memory_history / supersedes+mentions / entity-extractor |
| 防毒化 | ✅ | tentative→verified 状态机 + Web 面板人工门禁（业界独有） |
| 存储降级 | ✅ | sqlite-vec → JS 点积 → FTS5 三级 |
| 隐私红线 | ✅ | secret-redactor（有测试） |
| **效果实测** | ❌ | KV 命中率、蒸馏精确率、召回质量均无数字；71 项测试是功能正确性，不是效果 |
| **人类可读投影** | ❌ | 只有 JSONL 导出导回；无可 git、可手改的 Markdown 视图 |
| **用户级跨项目作用域** | ⚠️ | 作用域是 path_pattern + git 分支；「个人偏好跟人走、跨项目生效」的 user scope 未见显式一等公民 |
| **记住纠错** | ⚠️ | L1 抽「用户指令/错误-恢复对」部分覆盖；缺「用户否定→修正」对的专项抽取与加权（Claude Code 最被称道的点） |
| **成本可见** | ❌ | 无 token/费用统计端点（蒸馏花了多少、注入占多少 prompt） |
| **谷时调度** | ❌ | consolidation 未按峰谷时段排程（夜里跑=半价） |
| **dsh-ultra 联动** | ⚠️ | 有 subagent-fiber（子代理记忆合并），但与 dsh-ultra 编排层的「子代理共享工作集/计划前 recall」未打通 |
| **学术基准** | ❌ | 未跑 LoCoMo/LongMemEval 类基准（自用可以不跑全量，但要有最小评测集） |

---

## 四、下一阶段路线图（v2.2 / v3）

### P0 效果验证 spike（2–3 天，自用提质的根本）

1. **真机 KV 命中率实测**：读 `usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens`，对比三条链路——无记忆 / Tier1+Tier2 双层注入 / 朴素 system prompt 拼记忆（反面对照）。预期：双层注入命中率 ≈ 无记忆基线，朴素拼装显著劣化。这是对外可讲的头号数字。
2. **蒸馏质量评测集**：从自己真实 dsh 会话日志抽 20–30 条轨迹，人工标注「值得记的事实」，测 L1/L2 蒸馏的精确率/召回率与幻觉率。
3. **召回质量场景测试**：构造 20 个「上周踩过的坑，今天必须想起来」的真实场景，测 recall@k（k=3/5/10）与 working-set 选择策略在记忆量到 500/2000/5000 条时的行为（防止记忆越多越笨）。
4. 产出：一份带数字的 EFFECTS.md；不达标项回改参数（阈值/预算/检索权重）。

### P1 自用体验层（约 1 周）

1. **Markdown 人类可读投影**：`exportMarkdown()` 生成 `MEMORY.md`（索引，一行一条：标题+hook）+ `memories/*.md`（全文，frontmatter 带 id/type/scope/status）；支持 `importMarkdown()` 回导（按 id 幂等合并）。SQLite 仍是唯一真相源，投影是视图——兼得「检索强」与「可审计可手改可 git」。
2. **user 级作用域**：scope 三等 `user / project / branch`；用户级记忆（偏好、习惯、通用纠错）跨项目注入 Tier 1 工作集。
3. **纠错专项抽取器**：从轨迹中识别「用户否定/纠正 → agent 行为改变」对，类型化为 `correction` 记忆，working-set 优先级最高（对齐 Claude Code auto memory 的核心体验）。
4. **成本观测**：`/api/memory/stats` 增加 token 与费用（区分蒸馏/合并的 Flash 成本与主会话注入成本，按峰谷计价），Web 面板展示。
5. 验收：连续一周真实使用，周一到周五每天冷启动会话能自动带上上周的关键纠错与偏好，且周成本 < $1（按 P0 实测校准）。

### P2 dsh-ultra 联动（约 1 周，可选）

1. 编排前置 recall：dsh-ultra 的计划阶段（Pro/max）生成 workflow 前，自动 `memory_recall` 注入相关经验（「这个仓库上次怎么测的」）。
2. 子代理共享工作集：fan-out 的 agent() 调用统一携带 Tier 1 工作集（前缀一致还能共享缓存命中）；执行完毕经 subagent-fiber 合并回主记忆。
3. 验收：同一复杂任务，带记忆编排 vs 裸编排，首 agent 不再重复踩已知坑。

### P3 打磨与运营（约 1 周）

1. 谷时调度：consolidation/批量合并排到北京时间 18:00–次日 09:00（谷时半价）。
2. 最小学术基准：LoCoMo 或 LongMemEval 抽 50 题子集，给出与 mem0 公开数字的可比结果（README 可引用）。
3. 发布面：README 补 EFFECTS.md 数字链接；打 `dsh-plugin` topic；向 deepseekdocs 生态目录提交收录。

---

## 五、形态推荐（明确回答）

**SQLite 引擎核 + Markdown 投影层，不二选一。**

- 只要 Markdown（类 Claude Code）：失去向量+BM25+图谱混合检索与合并引擎，记忆过千条后召回质量塌方；
- 只要 SQLite：检索强但人不可审计、不可手改、不能进 git——与「自用提质」目标冲突（你自己就是最后的验证门禁，改一条错记忆要能在 30 秒内完成）。
- 投影层成本极低（导出/回导 + 幂等合并），且顺手解决了备份与跨机迁移。

---

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| P0 实测发现双层注入命中率并不理想（如 deferContext 快照落点破坏公共前缀） | 以 `prompt_cache_hit_tokens` 实测为准调整注入落点/顺序；这是 P0 存在的意义 |
| 蒸馏幻觉写脏记忆 | 已有 tentative 门禁 + secret-redactor；P0 评测集持续回归 |
| 记忆量增长拖慢 working-set 选择与召回 | P0 场景测试覆盖 5k 条；必要时加工作集 LRU + 按使用频次衰减 |
| dsh developer preview breaking changes | 锁版本（cordis@4.0.1）+ 可选服务消费 + 缺失降级（现有架构已如此，保持） |
| 与生态撞车（官方出 memory 插件） | 独有点（KV-cache 原生 + 验证门禁）+ 快速跟进归并 |
| 自用场景记忆碎片化（多个项目各记一套） | P1 user 级作用域 + Markdown 投影统一检视 |

## 七、验收指标

- **效果（P0）**：双层注入的缓存命中率 ≥ 无记忆基线的 95%；蒸馏 F1 ≥ 0.8（自建评测集）；纠错场景 recall@5 ≥ 0.9。
- **体验（P1）**：连续 5 个工作日真实使用零人工修复；MEMORY.md 投影 diff 可读；周成本 < $1。
- **联动（P2）**：带记忆的 dsh-ultra 编排首 agent 不重复已知坑（人工核对 3 例）。

---

## 参考来源

- [DeepSeek V4 Preview 官方公告](https://api-docs.deepseek.com/news/news260424)
- [DeepSeek Context Caching（KV cache）官方文档](https://api-docs.deepseek.com/guides/kv_cache)
- [DeepSeek 价格页（峰谷/缓存命中价）](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek Thinking Mode 指南](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Harness 官方页](https://deepseek.com/harness/)
- [dsh 开发者文档（插件/服务/事件）](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)
- [dsh 插件生态目录](https://deepseekdocs.com/en/ecosystem)（graph-memory、dsh-memory-evolve、dsh-noema、mnemon 等）
- [Claude Code 官方文档：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [memorax-ai/memorax-code](https://github.com/memorax-ai/memorax-code)
- 同目录 `dsh-ultra-PLAN.md`（dsh-ultra 编排层项目，P2 联动对象）

# dsh-ultra：在 DeepSeek Harness 上复刻 Claude Code「Ultracode」— 调研结论与实施计划

> **状态（2026-08-17）：P0 调研/核实已完成（见 §1.5），已开工。** 记忆插件侧的联动接口已就绪（`/api/memory/working-set` 共享前缀下发 + `/api/memory/subagent/*` fiber 合并，见 dsh 记忆插件 v2.2.0+），本项目启动时直接对接。
>
> 2026-08-16 调研。结论先行：可行，且 dsh 的「一切皆插件」架构正好允许我们不 fork 主仓库、以一组原生插件 + preset 的形态实现 Claude Code ultracode 的等价体验，同时把 DeepSeek V4 的双模型 / 1M 上下文 / effort 分级 / KV 缓存等特性变成编排层的直接优势。
>
> **P0 核实新增关键结论（2026-08-17，对照本地 deepseek-harness 源码逐项验证）**：dsh 标准模式**已内置**脚本化 workflow 引擎与 reasoningEffort 分级，P2 定位由「待定」升级为「**确定的语义/策略层，绝不自带引擎、绝不 fork**」——详细证据与 ADR 见 §1.5。

---

## 一、调研结论

### 1.1 「Claude Code ultra 模式」= Ultracode（v2.1.203+）

定义：**xhigh 推理力度 + 自动动态工作流编排**，通过 `/effort ultracode` 或 `claude --effort ultracode` 开启，会话级有效。

机制细节（我们要复刻的对象）：

- 模型为任务写一个 **JavaScript workflow 脚本**，运行时后台隔离执行，主会话保持响应；一次请求可拆成工作流链（理解代码 → 修改 → 验证）。
- 脚本原语：`agent()`（可带 JSON schema 结构化输出、label）、`pipeline()`（列表每项一个 agent）、全局 `args`；脚本可存盘复用（`.claude/workflows/`），并可存为 `/<name>` 命令。
- 规模：一次运行几十~上百 agent；硬上限 **并发 16、单次 1000**。
- 关键设计：**编排逻辑在脚本里**（循环/分支/中间状态存脚本变量），主模型上下文只拿最终答案——这是它区别于 turn-by-turn 子代理编排的核心。
- 质量模式：独立 agent **对抗式互审**、多角度方案竞标后择优。
- 监控 `/workflows`：列表/钻取/暂停/恢复/终止/重跑单个 agent。
- 护栏：>25 agent 或预计 >1.5M token 触发「大工作流」警告；规模分档 unrestricted / small(<5) / medium(<15) / large(<50)；ultracode 档隐式豁免警告。
- 权限：子代理固定跑 acceptEdits 等价档、继承工具白名单；Auto 模式下 ultracode 完全跳过权限提示。
- 提示词中出现 `ultracode` 关键字可单任务触发；`CLAUDE_CODE_SUBAGENT_MODEL` 可指定子代理模型（阶段路由的基础）。

### 1.2 DeepSeek V4 关键特性（2026-04-24 发布，已开源权重）

| 项目 | 内容 | 对本项目的意义 |
|---|---|---|
| 模型 | V4-Pro 1.6T/49B active（旗舰）；V4-Flash 284B/13B active（推理接近 Pro，简单 agent 任务与 Pro 持平） | 天然的「主控/执行」双路由 |
| 上下文 | **1M token 标配**（token-wise compression + DSA 稀疏注意力） | fan-out 结果聚合可少做激进压缩 |
| 思考模式 | Thinking/Non-Thinking 双模；默认开 thinking、effort=high | effort 分级的物理基础 |
| effort 档位 | `low / high / max`（请求 medium/high/**xhigh 都被映射为 high**） | V4 的「顶格」= max；ultracode 语义应绑 max |
| API | OpenAI ChatCompletions / Anthropic / Responses 三套；模型名 `deepseek-v4-pro` / `deepseek-v4-flash`；工具调用、JSON 输出、FIM、prefix completion | 接入成本低；与 Claude Code 生态互通 |
| 价格（现价 /1M） | Flash：$0.0028 命中 / $0.14 未命中 / $0.28 输出；Pro：$0.003625 / $0.435 / $0.87 | Flash 输出约为 Pro 的 1/3、缓存命中近乎免费 → 并行 fan-out 用 Flash 极划算 |
| 峰谷计价 | 2026-08-16 16:00 UTC 起生效：峰时（01:00–04:00、06:00–10:00 UTC）全价、谷时半价；新价目显著高于现价 | 批处理任务可谷时调度；成本报表需按峰谷计价 |
| 并发限额 | Flash 2500 / Pro 500 | 16 并发毫无压力 |
| 退役 | `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役 | 一律用 v4 模型名 |

**V4 的 agent 开发坑（实测级重要）**：

1. 带工具调用的多轮中，`reasoning_content` 必须在后续每次请求原样回传，否则 400；无工具调用时可以省略。
2. thinking 模式下 `temperature / top_p / presence_penalty / frequency_penalty` 不支持（被静默忽略）。

### 1.3 dsh（DeepSeek Harness）现状

- MIT 开源（github.com/deepseek-ai/deepseek-harness，113k star），**开发者预览，官方明确警告会有 breaking changes**。
- **Cordis 内核**：只负责插件加载/卸载/依赖；模型、工具、技能、会话、沙箱、存储、循环、调度、UI 全部是插件，通过 Cordis 服务与事件协作。
- 四种运行模式：**标准**（完整 coding agent：文件编辑、shell、检索、skills、plans、goals、子代理、workflows）、**PTC**（Code Mode SDK，模型写 TS 程序组合工具）、**极简**（双工具基准测试）、**创造**（编写自定义 preset）。
- 可观测：append-only 会话日志 + Trajectory 视图；resume / fork / replay 共用同一事件流。
- ⚠️ **标准模式已内置 sub-agents 与 workflows**——所以不是从零造编排，而是核实其现有 workflow 插件的形态（是否脚本化、有无并发/预算控制、能否恢复），在其上叠加 ultracode 语义。
- 插件体系：Bundle（git 源、构建产物、需重启）与 Repository（`.dsh-plugin` 目录、即时生效）两种；安装 `dsh plugin --profile web add "github:owner/repo#ref&path:/packages/<sub>"`；依赖闭包落在 `$DSH_HOME/profiles/node_modules`；必须从 `@deepseek-ai/cordis` 导入；manifest 在 package.json 的 `dsh` 字段（`dsh.bundle.patch` / `dsh.client` / `dsh.profile.bundles`）。官方提供 `make-dsh-plugin` 脚手架技能 + learn/dev 插件开发课程 + persona preset 机制。
- 生态：GitHub `dsh-plugin` topic 已 1000+ 项目。与本项目相关：**dsh-TUI**（Claude Code 风格终端 ★1.2k）、**oh-dsh**（社区发行版）、**dsh-auto-mode**（安全自动权限）、graph-memory、dsh-turn-rewind、dsh-at-file、modlens（纯文本模型的视觉路由）等——我们做编排层，与它们**互补而非重复**。

### 1.4 差距分析（要造的东西）

dsh 目前缺的 = ultracode 等价层：

1. `/effort` 式分级语义 + V4 thinking/effort 映射（dsh 无此概念）；
2. 「自动触发」的动态工作流编排（复杂任务自动进编排，而非手动）；
3. Pro/Flash 阶段级模型路由；
4. 成本护栏 + `/workflows` 式监控面板；
5. （可选）TUI 下的 ultracode 体验。

---

### 1.5 P0 核实结论（2026-08-17，对照本地 deepseek-harness 源码）与架构决策 ADR

#### 1.5.1 逐项核实清单（✅/❌ + 证据）

| 计划 P0 核实项 | 结果 | 证据（本地源码路径） |
|---|---|---|
| workflow/subagent 是否脚本化 | ✅ 已脚本化 | `ctx.workflowEngine` 接收 `{script, meta, args, subagentProvider?, maxTotalAgents?, parent}`，脚本即 JS body（`agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/`args` 全局），worker-thread 引擎每 run 一个 worker；见 `docs/subsystems/workflow.md`、`packages/workflow/workflow/src/runtime-types.ts`、`packages/workflow/tool-workflow/src/index.ts` |
| 有无并发/预算控制 | ✅ 有 | 脚本约束「concurrency 与 total-agent caps 生效」；`WorkflowStartRequest.maxTotalAgents` 单 run 总子代理上限；`WorkflowError.fatal` 对超限/错参 loud-kill；`parallel()` 为并发 barrier |
| 能否取消/恢复 | ⚠️ 能取消，恢复需语义层 | `WorkflowRun.cancel()/dispose()` 有界结算；`workflow/*` 事件为只读数据快照（start/phase/log/agent-start/agent-end/end），`tool-workflow` 写 `tool-workflow/run-start/run-end` Chat 记录 → **持久化与回放事件流已有，编排状态恢复/重跑可由 dsh-ultra-guard 在语义层补** |
| V4 reasoning_content 回传 | ✅ 适配器已处理 | `packages/llm/llm-deepseek/src/serialize.ts` 仅在带工具调用的 assistant 轮回传 `reasoning_content`（thinking 模式官方规则）；无工具调用轮丢弃省 token；首片空 `reasoning_content` 不产生多余 block |
| thinking/effort 建模 | ✅ 已建模 | DeepSeek 适配器公布 reasoning effort `off/high/max`：`off→thinking:disabled`，`high/max→thinking:enabled+reasoning_effort`（`serialize.ts`）；`GenerateOptions.reasoningEffort`、`LlmModelReasoningInfo.efforts/defaultEffort` 全链路存在 |
| 会话级 effort 注入 | ✅ 已存在 | `ctx.agentDefaultModel.currentSelection()` 返回 `{provider, model, reasoningEffort?}`；effort 走 Settings 分节；loop 从持久化配置读取并注入请求（`packages/core/agent-loop/src/agent.ts`）；`request/header.adapterDefaults` 处理适配器自有默认值 |
| KV 缓存记账 | ✅ 已存在 | `TokenUsage.cacheReadTokens/cacheWriteTokens`；DeepSeek translate 从 `prompt_tokens_details` 拆出 |
| 命令注册 | ✅ 已存在 | `ctx.commands.register()`（`packages/interaction/commands`）支持 `name/description/input/handler`，handler 直接拿 `{commandId, agent, rawInput, signal}`，`command/run`/`command/done` 落日志 |
| 参考编排实现 | ✅ 有样例 | `packages/workflow/tool-ralph`：固定脚本 + 每轮 fresh 结构化子代理 + round/handoff 上限，是外部编排插件的直接模板 |
| 子代理多 provider + 结构化输出 | ✅ 有 | `ctx.subagents` 命名 provider（spawn/fork/acp/codex/claude-code/dsh-sdk），`outputSchema`/`toolFilter`/`persona`/`maxDepth` 能力位；continuable 子代理 + `listChildren/listDescendants` 持久化发现 |

**核实结论**：原计划 §1.4 的差距清单需要重写——「脚本化编排、effort 分级、KV 记账、reasoning_content 修补」**都不是要造的东西**。dsh-ultra 真正要造的只有五件事：① `/effort` 的 Claude Code 语义层（五档映射 + ultracode 开关）；② 自动触发分类器；③ 阶段路由（Pro/Flash）的注入机制；④ 预算护栏 + `/workflows` 观测面板 + 成本报表；⑤ preset 入口。

#### 1.5.2 架构决策记录（ADR-001）

- **状态**：Accepted（2026-08-17）
- **决策问题**：dsh-ultra 的编排能力应如何与 dsh 现有 workflow/subagent/llm seam 组合？
- **Context / Forces**：
  - F1：dsh 处于 developer preview，breaking changes 频繁 → 薄适配层、不 fork、锁 commit 是唯一低维护成本的路线。
  - F2：dsh 已内置脚本化 workflow 引擎（worker-thread、预算上限、取消、事件、Chat 记录），能力与 Ultracode 脚本编排等价 → 再造引擎 = 与上游重复维护 + 必然撞车。
  - F3：V4 的 thinking/effort/reasoning_content/KV 缓存细节已被适配器层正确封装 → 语义层无需触碰协议细节，只做策略。
  - F4：编排的差异价值在「何时自动进编排、用什么模型跑哪一阶段、花多少钱、怎么监控」→ 这些全是策略/护栏/观测，天然属于插件层。
- **决策**：dsh-ultra = 一组 Cordis 插件构成的**语义/策略层**，只消费 `ctx.workflowEngine`、`ctx.subagents`、`ctx.commands`、`ctx.agentDefaultModel`、`ctx.settings`、llm `TokenUsage` 等既有 seam；**不自带引擎、不 fork 主仓库、不 patch 适配器**。保留一个例外：若 `agent()` 缺少逐 agent 的 model/provider 覆盖点（已核：`WorkflowMeta.phases` 的 `provider/model` 是 informational，`WorkflowStartRequest` 只有 engine-wide `subagentProvider`），阶段路由由「脚本生成时注入阶段→模型指令 + 自定义 subagent provider」两条互补路径实现（P3 落地）。
- **Alternatives（rejected）**：
  - A1 自带编排引擎（自建脚本 VM/并发/恢复）：**拒绝**。与 `ctx.workflowEngine` 功能重叠，双份维护，且失去上游事件/Chat 记录/UI 集成；无独立收益。
  - A2 fork 主仓库在 agent-loop 内加编排：**拒绝**。developer preview 期合并成本高、版本漂移快；违反「薄层最稳」。
  - A3 只写 preset/prompt 提示模型手动调 `workflow` 工具（零插件）：**拒绝**。无自动触发、无护栏、无成本观测，达不到 ultracode 等价体验。
- **Consequences**：
  - 正面：快速对齐上游演进；复用全部既有 UI/事件/持久化；核心代码量大幅缩减（比原计划小 1–2 个数量级）；不依赖适配器内部。
  - 负面：受 workflow seam 能力边界约束（`agent()` 无逐 agent model 选项 → 路由需注入式）；自动触发需借助 loop 事件钩子或提示层，触发时机受 seam 暴露面限制。
- **Reversibility**：低撤销成本。语义层插件可整体卸载回到原生 dsh；若上游未来内置类 ultracode 能力，本插件可快速归并（原有决策 F4 目标）。重审触发条件：上游 workflow seam 出现不兼容改动，或 dsh 官方发布等价编排层。
- **Responsibility**：项目负责人（用户）+ 本地验证路径：`pnpm typecheck && pnpm test`（接入 harness workspace 时）+ 真实任务 e2e 抽样。

---

## 二、项目定位

- **名字（暂定）**：`dsh-ultra`。
- **形态**：一组 dsh 原生插件 + 一个 preset，可 `dsh plugin add` 安装；**不 fork 主仓库**（developer preview 期上游变动大，薄层最稳）。
- **「支持 dsh 原生插件」两层含义都满足**：① 本项目自身以 dsh 原生插件形态实现；② 编排出的子代理复用宿主已装插件（TUI、auto-mode、memory……）。
- **非目标**：不做发行版（oh-dsh 已占位）、不重写 agent loop、不追求 Claude Code 全功能对等。

---

## 三、架构设计

每个组件都是一个 Cordis 插件，通过服务声明依赖：

1. **dsh-ultra-effort（分级器）**
   - `/effort` 命令（low / medium / high / xhigh / ultracode）+ 状态展示；
   - 映射表：`low`→thinking off；`medium`→thinking+effort=low；`high`→thinking+effort=high；`xhigh`→thinking+effort=high+上下文策略增强（V4 无 xhigh，官方映射即 high）；`ultracode`→**effort=max + 自动编排开 + 护栏放宽**（对齐 Claude Code ultracode 豁免大工作流警告的行为）；
   - 兜底修补：保证模型适配器按 V4 规则回传 `reasoning_content`（带工具调用时），不发送不支持的采样参数。
2. **dsh-ultra-orchestrator（编排引擎，核心）**
   - 触发判定：轻量分类器（Flash、低 effort、单次调用）给任务打复杂度分，超阈值自动进编排——对齐 ultracode「不用你要求」；
   - 计划生成：Pro/max 产出 workflow 脚本（JS DSL：`agent()` / `pipeline()` / `args` / 循环分支）；
   - 执行沙箱：脚本无文件/shell 权限，只能调 `agent()`；默认并发 16、单运行 1000 agent；事件流对接 dsh session 日志以支持恢复；
   - 聚合：内置「per-file 审计 + 对抗互审」「多源检索交叉验证」两个质量模式；**最终答案回主会话，中间态留在脚本变量**。
3. **dsh-ultra-router（模型路由）**
   - 阶段路由：规划/审查/复杂步骤→V4-Pro；fan-out 执行→V4-Flash（简单 agent 任务 Flash≈Pro，输出价 1/3、缓存命中近免费）；
   - 按 workflow 脚本的 stage 标注或启发式自动分配；配置可覆盖。
4. **dsh-ultra-guard（护栏与观测）**
   - 预算护栏：>25 agent 或预计 >1.5M token 警告；规模分档 unrestricted/small(<5)/medium(<15)/large(<50)；
   - 权限：子代理跑 acceptEdits 等价档、继承宿主工具白名单；可与 dsh-auto-mode 组合；
   - `/workflows` 面板：列表/钻取/暂停/恢复/终止/重跑单 agent/存脚本为命令（Web UI 优先，TUI 后续）；
   - 成本报表：按 stage 统计 token 与费用（含峰谷价与缓存命中）。
5. **dsh-ultra-preset（入口）**
   - 一键启用上述插件 + 推荐默认值；P4 可选对接 dsh-TUI（思考流、进度条、Esc 回滚）。

**上下文与缓存策略（V4 专项）**：

- 前缀固化：system prompt + 工具 schema 顺序稳定，最大化 KV cache 命中（Flash 命中 $0.0028/M，近乎免费）；
- fan-out 聚合利用 1M 窗口：子代理结果先全量注入聚合器（Flash）做去重/冲突检测，再给 Pro 精选，少做激进压缩；
- 主会话仍守「只进最终答案」，防上下文爆炸；
- 批处理任务可选谷时调度（谷时半价）。

## 四、V4 特性 → 组件适配速查

| V4 特性 | 用法 | 落点 |
|---|---|---|
| Thinking/Non-Thinking 双模 | effort low 档直接关思考，省钱提速 | effort 分级器 |
| effort low/high/max（无 xhigh） | ultracode 绑 max；xhigh 显式映射为 high | effort 分级器 |
| reasoning_content 回传规则 | 适配器自动回传，避免 400 | effort 修补逻辑 |
| 1M 上下文 + DSA | fan-out 全量聚合 + 冲突检测，少压缩 | 编排引擎聚合阶段 |
| KV cache | 前缀固化吃命中折扣 | router + prompt 组装 |
| Flash 便宜+高并发（2500） | fan-out 执行主力，输出价 1/3 | router |
| Pro 旗舰（500 并发） | 规划、审查、最终裁决 | router |
| 峰谷计价（8/16 起） | 谷时调度批任务、成本报表按峰谷 | guard |
| Anthropic API 兼容 | 未来可与 Claude Code 生态互通 | 预留 |

## 五、分阶段实施计划

### P0 调研验证 spike（2–3 天）
- clone deepseek-harness，精读 `docs/architecture.md`、`docs/development.md`、learn/dev 插件课程与 plugin-anatomy；用 `make-dsh-plugin` 跑通骨架。
- **核实标准模式现有 workflow/subagent 插件的真实能力**：是否脚本化？有无并发/预算控制？能否恢复？（决定 P2 是「叠加语义层」还是「自带引擎」）
- 实测 V4：effort=max vs high 的思考深度/耗时差异；reasoning_content 回传行为；前缀缓存命中率；复核 8/16 峰谷新价目。
- 产出：技术核实清单（每条 ✅/❌ + 证据）、插件骨架仓库。
- 验收：在 `dsh web` 里装上自制 hello-plugin 并生效。

> **✅ 已完成（2026-08-17）**：核实清单见 §1.5.1；架构决策 ADR-001 见 §1.5.2；插件骨架仓库 `dsh-ultra/` 已建（bundle manifest + cordis.patch.yml + tsconfig/构建/测试）。「在 dsh web 装上生效」留待 harness 全量构建后完成（当前已定向构建依赖闭合并通过 typecheck/test/build 三关）。

### P1 effort 分级器（约 1 周）
- `/effort` 五档 + 映射 + reasoning_content 修补 + 会话级持久化。
- 验收：同一任务五档实测记录 token/延迟/质量差异；工具调用多轮无 400。

> **✅ 主体已完成（2026-08-17）**：`dsh-ultra` 的 `ultra-effort` 插件已落地——`/effort` 五档映射（low/medium/high/xhigh/ultracode → off/high/high/max/max）、`autoOrchestrateLevels` 开关、`ultra-effort` 设置命名空间 + `agentDefaultModel.saveSelection()` 持久化。**调整**：`reasoning_content` 修补无需自造（已核实适配器处理，见 §1.5.1）；「五档实测 token/延迟/质量差异」依赖真实 API 与运行环境，归入 P4 端到端验收。

> **✅ 代码审查与修复（2026-08-17，agent-pr-review）**：对 P1 落地代码做 pre-merge 审查（全部 API 对照 harness 源码逐项验证无幻觉），修复如下——
> - **M1 依赖声明**：7 个 `@deepseek-ai/*` 运行时依赖从 `dependencies` 移到 `peerDependencies`（宿主已提供，避免闭包重复实例），`devDependencies` 保留 workspace 链接供本地开发；对齐官方 headless bundle 惯例。
> - **M2 发布通道（决策）**：确定为 **npm publish**（`files` 白名单含 `lib/`+`cordis.patch.yml`，优先于 `.gitignore`）；git 安装依赖 `prepare` 构建，作为 P0 收尾在真实 dsh 环境实测。
> - **S1 部分覆盖**：`Config.effortMap` 五键加键级 `.default`，部署者可只覆盖单个 tier（与运行时回退语义一致）。
> - **S2 作用域**：命令输出明示「applies to new sessions」，README 补充。
> - **S3 双事实源**：`/effort` 无参查询同时展示 level 意图值与 `currentSelection()` 实际值，漂移时提示 resync。
> - **F1 双写非原子**：先写模型选择（关键副作用）、再记 level；level 写失败返回 error 且 effort 保持生效。
> - **F2 接线测试**：新增 `tests/index.spec.ts`（6 用例）覆盖命令注册与 handler 全部分支；`vitest.config.ts` 改为 alias 映射 harness 源码（vite-tsconfig-paths 目录向上发现无法覆盖 harness 树外的 dsh-ultra，且 vendor 源码不兼容 base 严格选项）。typecheck/test/build 三关全绿。

### P2 编排引擎 MVP（约 2 周）
- 触发分类器（Flash）→ 脚本生成（Pro/max）→ 沙箱执行 → 聚合。
- 内置两个样板工作流：per-file 审计+对抗互审；多源检索交叉验证。
- 验收：16 并发稳定跑 50+ agent；中断可恢复；主会话上下文增量 ≈ 最终报告大小。

### P3 路由 + 护栏 + 观测（1–2 周）
- 阶段路由、预算护栏与规模分档、`/workflows` 面板（web）、成本报表、Trajectory 集成。
- 验收：跑一次真实重构任务输出完整成本报表；护栏触发路径全部有测试。

### P4 打磨与发布（约 1 周）
- 文档对齐 make-dsh-plugin 规范；打 `dsh-plugin` topic；向生态精选列表提 PR 收录；（可选）dsh-TUI / oh-dsh 对接。
- 验收：陌生人按 README 三条命令装上跑通。

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| dsh 处于 developer preview，breaking changes 频繁 | 不 fork、锁 commit、薄适配层、跟进 upstream release |
| V4 无 xhigh，max 档实际增益未知 | P0 实测定标；必要时 ultracode = high + 编排（编排本身才是主增益） |
| 官方后续内置类 ultracode 能力撞车 | 定位为语义层薄插件，上游出官方版则快速归并 |
| 8/16 起价格上调 + 峰谷计费 | 成本报表 + 谷时调度 + Flash 路由兜底 |
| 与 oh-dsh / dsh-TUI / dsh-auto-mode 功能重叠 | 只做编排/路由/护栏层，公开声明依赖并组合它们 |
| 触发分类器误判（简单任务也开编排） | 阈值可配 + 显式 `/effort high` 退出 + ultracode 关键字单任务触发 |

## 七、验收指标（建议）

- **功能**：五档 effort、自动编排、16 并发、中断恢复、面板、护栏全部可用。
- **效果**：选 3 个真实开源任务，单会话 vs dsh-ultra 对比完成质量与 token 成本（目标：复杂任务质量提升可测、成本增幅在预算内可控）。
- **工程**：插件可独立安装卸载；核心逻辑 vitest 覆盖（与 dsh 仓库同栈）。

## 参考来源

- [Claude Code 官方文档：动态工作流 / Ultracode](https://code.claude.com/docs/zh-CN/workflows)
- [DeepSeek V4 Preview 官方公告](https://api-docs.deepseek.com/news/news260424)
- [DeepSeek Thinking Mode 指南](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek 价格页](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek Harness 官方页](https://deepseek.com/harness/)
- [deepseek-ai/deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [dsh 插件生态目录](https://deepseekdocs.com/en/ecosystem)（dsh-TUI、oh-dsh、dsh-auto-mode 等均见于此）
- [dsh 插件安装/管理指南](https://deepseekdocs.com/en/docs/user-guide/plugins)
- [Ultracode 实战与成本控制分析](https://blog.laozhang.ai/zh/posts/claude-code-ultracode)

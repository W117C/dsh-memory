# @dsh-plugins/memory（DeepSeek Harness 原生认知记忆插件）

专为 **DeepSeek Harness (`dsh`)** 打造的原生认知记忆系统插件。深度适配 **DeepSeek-V4 模型**（默认 `deepseek-v4-flash`，KV-Cache 前缀缓存语义对齐）与 **dsh 真实插件体系**（`@deepseek-ai/cordis` v4 微内核 + 原生 Slots Web UI），能力面对标 GitHub 顶级开源记忆项目（mem0 / Zep / Letta / Cognee）。

## 📊 能力矩阵（对标顶级开源记忆项目）

| 能力 | mem0 | Zep/Graphiti | Letta | Cognee | **本插件** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 写入即合并（ADD/UPDATE/DELETE/NOOP） | ✅ LLM | ➖ | ➖ | ➖ | ✅ **LLM(V4) + 确定性双引擎** |
| 记忆变更历史（审计日志） | ✅ | ✅ 时序 | ➖ | ➖ | ✅ `memory_history` 全事件 |
| 双时态事实有效性 | ➖ | ✅ | ➖ | ➖ | ✅ `valid_from/invalid_at` |
| 知识图谱 / 实体边 | ✅ 可选 | ✅ 核心 | ➖ | ✅ 核心 | ✅ `mentions` + `supersedes` 自动构图 |
| 混合检索（向量+BM25+衰减） | ➖ | ➖ | ➖ | ✅ 多模式 | ✅ 四信号加权 |
| 自编辑记忆工具 | ➖ | ➖ | ✅ 核心 | ➖ | ✅ 4 个原生工具 |
| 防毒化验证门禁（tentative→verified） | ➖ | ➖ | ➖ | ➖ | ✅ **独有** |
| 会话轨迹自动蒸馏 | ➖ | ✅ 情节 | ➖ | ➖ | ✅ 双级引擎 |
| 批量写入 / JSONL 导入导出 | ✅ | ➖ | ➖ | ➖ | ✅ |
| KV-Cache 友好注入（服务端前缀缓存） | ➖ | ➖ | ➖ | ➖ | ✅ **独有**（V4 对齐） |
| Agent Harness 原生集成 | 框架无关 | 框架无关 | 自带框架 | 框架无关 | ✅ **dsh 原生**（Cordis v4） |
| 原生 Web 管理面板 | Cloud | Cloud | ✅ | ➖ | ✅ dsh Web UI 一等公民 |
| 全离线 / Zero-Cloud | ➖ | ➖ | ✅ | ✅ | ✅ SQLite 三级降级 |

---

## 🌟 核心特性

### 1. 深度 dsh 适配（真机契约，非模拟）

插件对接的是 dsh 发布在 npm 上的**真实运行时与类型契约**（`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-llm` 等），全部能力按 dsh 官方插件规范以**可选服务**方式消费（`ctx.get()` + 缺失降级 + effect disposer 全量回收），可在 web / headless / 裸 Cordis 任一 profile 下启动：

| dsh 能力 | 插件消费方式 |
| :--- | :--- |
| `tools` 工具注册表 | `ctx.get('tools').register()` 注册 4 个模型可见工具（含 canonical `output` 声明） |
| `systemPrompt` 提示词注册表 | `section()` 稳态分区 + `context()` 动态快照（见下） |
| 会话事件 | 真实契约 `session/created` / `session/event` / `session/disposed`（轨迹投影 + 蒸馏触发） |
| `httpServer` Web 服务 | `register({ kind: 'prefix', path: '/api/memory' })` 原生前缀路由 |
| `llm` 模型服务 | `ctx.llm.stream()` 走 dsh 的 DeepSeek-V4 adapter 注册表做蒸馏 |

**绝不改写 LLM 请求**：dsh 的 LOOP 构建请求是深冻结的（改写即抛错），本插件通过注册提示词贡献者参与组装，而不是劫持请求。

### 2. DeepSeek-V4 KV-Cache 友好型双层注入

- **Tier 1（稳态分区）**：`systemPrompt.section({ name: 'memory:working-set', order: 90 })`，在会话生命周期内**字节级冻结**（绑定 `session/created` 时刻的工作集），系统前缀跨轮保持 V4 服务端前缀缓存命中；
- **Tier 2（动态快照）**：`systemPrompt.context({ name: 'memory:recall', order: 500 })`，`memory_recall` 工具的检索结果以 durable user-role 快照沉淀（当轮经原生 `exec.deferContext()` 即时投递），随轮演化而**绝不污染**系统前缀缓存。

### 3. 原生态 Web UI（dsh client roster 一等公民）

- 包清单声明 `dsh.client: { platform: 'web' }` + `exports['./client']`，与 dsh 自带的 sidebar / settings 等 UI 插件**同一套机制**：client-modules 节点半自动扫描、`/plugins/<id>/client.js` 下发、`window.__ModuleLoader__.load()` 惰性 CJS 工厂注册；
- 面板注册进 **`settings.section`**（官方插槽标准中完整设置页的指定入口，`key: 'memory'`），React + `createElement` 编写，样式随工厂闭包注入、颜色全部走中性 alpha 让 shell 主题透出；
- 数据走**同源** `/api/memory/*`（宿主半体在 dsh webserver 上注册的原生前缀路由）：统计、知识图谱、待审核列表、人工「验证/废弃」复核、语义检索。

### 4. 防记忆毒化验证门禁（tentative → verified 状态机）

自动提炼的 Post-Mortem 先进 `tentative` 观察期；被后续任务成功复用（Exit Code == 0）或经 Web 面板人工审核后才晋升 `verified` 黄金法则，杜绝错误试错写进长期知识库。Web 面板的「✓ 验证 / ✕ 废弃」即人工门禁入口。

### 5. 顶级记忆能力包（对标 mem0 / Zep / Cognee）

- **写入即合并**：`remember()` 走 `MemoryConsolidator`——检索相似候选记忆，经 DeepSeek-V4 推断每条的 **ADD / UPDATE / DELETE / NONE** 决策并原子应用；无 LLM 或调用失败时自动回退确定性冲突消解（复合键消解 + 语义近重复检测），写入永不因合并不可用而失败；
- **变更历史**：`memory_history` 表自动记录 `created / updated / promoted / deprecated / deleted` 全事件，含 before/after 投影 JSON，单记忆与全局时间线均可查；
- **知识图谱增强**：写入时经典模式抽取实体（反引号命令、点分键、文件路径、常量、错误签名等）并建 `mentions` 边，与 `supersedes` 一起构成真实知识拓扑，Web 面板图谱直接可视化；
- **可携带性**：`rememberBatch()` 批量写入；`exportJsonl() / importJsonl()` 无损 JSONL 导出导入（备份 / 迁移 / 数据集检视三合一）；
- **全端点 HTTP 面**：`/api/memory` 下新增 `/history`、`/export`、`/import`、`/remember/batch`，`/remember` 返回合并决策明细（`events` + `engine`）。

### 6. DeepSeek-V4 双级蒸馏引擎

- **Level 1 确定性快速通道**：规则化剪枝（剥离 `<think>` 思维流）→ 用户指令 / 错误-恢复对 / 复用命令三类抽取；
- **Level 2 语义增强**：检测到沙箱复杂失败时，经 `ctx.llm.stream()` 调用 **`deepseek-official` 路由的 `deepseek-v4-flash`**（与 dsh 基座 `agent-default-model` 同款默认），流式 text-delta 组装 + 宽容 JSON 解析，失败自动回退 Level 1。

### 7. 三级高可用嵌入式混合存储底座（Zero-Cloud）

- **主引擎**：SQLite (WAL) + `sqlite-vec` 原生向量 + FTS5 全文；
- **降级 1**：纯 JS `Float32Array` 点积引擎（零 C++ 编译依赖）；
- **降级 2**：SQLite FTS5 纯 BM25 稀疏检索；
- **向量化**：本地 ONNX（`bge-small-zh-v1.5`），可回退远程 Embedding API。

### 8. Monorepo 路由与作用域

`path_pattern` 通配 + git 分支可见性 + 双时态（bi-temporal）失效，按当前活跃文件自动激活规则。

---

## 📦 安装

```sh
# 在目标 profile 中安装本插件（dsh 官方插件管理通道，转发 pnpm）
dsh plugin --profile web add @dsh-plugins/memory
```

安装后 profile 的 `dsh.profile.bundles` 列出本包，composer 通过包内 `dsh.bundle.patch`（`cordis.patch.yml`）挂载宿主行；浏览器半体无需单独配置——client-modules 扫描到 `dsh.client` 声明后自动进入 Web UI。随后 `dsh web` 打开的界面中，Settings 内即出现「记忆系统 / Memory」面板。

也可在自有组合中直接挂载：

```yaml
- insert:
    - id: memory
      name: '@dsh-plugins/memory'
```

配置项（Cordis Schema，全部有默认值）：

```yaml
- id: memory
  name: '@dsh-plugins/memory'
  config:
    distillation:
      llmProvider: deepseek-official   # 与 dsh 基座一致的默认路由
      distillModel: deepseek-v4-flash  # DeepSeek-V4 flash 蒸馏
    prompt:
      enabled: true                    # section + context 双层注入
    web:
      enabled: true
      routePrefix: /api/memory
```

---

## 🛠 Agent 原生工具（4 个）

| 工具 | 功能 | 说明 |
| :--- | :--- | :--- |
| `memory_remember` | 写入规则 / 偏好 / 架构决策 | 带冲突消解（同 `entity_key` 走 supersede 而非重复插入） |
| `memory_recall` | 语义召回历史经验 | 紧凑投影 + Token 预算；当轮 `deferContext` 投递 + 跨轮快照沉淀 |
| `memory_reflect` | 显式记录 Post-Mortem / 配方 | 进入 tentative 观察期 |
| `memory_forget` | 软删除过时记忆 | 双时态 `invalid_at` 失效 |

---

## 🧪 测试与构建

```bash
pnpm test         # 71 项测试：真实 @deepseek-ai/cordis@4 运行时集成 + 合并引擎/历史/图谱/可携带性
pnpm build        # tsc 宿主产物 + esbuild 浏览器 bundle（CJS 工厂包装）
pnpm typecheck    # 宿主与 client 双 tsconfig 类型检查
```

测试直接跑在**真实 cordis v4** 上：服务经 `ctx.reflect.provide()` 注入契约一致的桩（tools / systemPrompt / httpServer / llm），验证注册、KV-cache 字节稳定性、工具执行、会话蒸馏与 fiber 卸载回收；client bundle 经伪造 `__ModuleLoader__` 走真实加载路径并做 SSR 渲染断言。

---

## 📄 开源许可证

MIT License.

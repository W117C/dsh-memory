# Changelog

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

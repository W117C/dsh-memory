# AGENTS.md — @dsh-plugins/memory

一句话定位：DeepSeek Harness (dsh) 的原生认知记忆插件（Cordis v4 可选服务制），SQLite 为唯一真相源，DeepSeek-V4 KV-cache 友好双层注入。

## 怎么跑起来

```sh
pnpm install
pnpm typecheck     # tsc 宿主 + client 双配置
pnpm test          # 95 项 vitest（真实 @deepseek-ai/cordis@4 运行时 + 桩服务）
pnpm build         # tsc 产物 + esbuild 浏览器 bundle
pnpm pack          # 产出 dsh-plugins-memory-<version>.tgz
```

评测 harness 在 `evals/`（`node evals/<name>.mjs`，可复现 EFFECTS.md 全部数字；kv-hit-rate / --llm / --judge / --rewrite 需环境变量 `DEEPSEEK_API_KEY`；LongMemEval 数据 ~250MB 首跑自动下载到 `evals/data/`，已 gitignore）。

## 技术栈与关键约束

- TypeScript ESM（`type: module`，源码 import 用 `.js` 后缀）；宿主 cordis v4 + better-sqlite3 (WAL) + sqlite-vec + FTS5 + 本地 ONNX 嵌入（bge-small-zh-v1.5，损坏缓存自愈，进程内共享一次加载）。
- **绝不改写 LLM 请求**（dsh LOOP 深冻结）：一切注入走 `systemPrompt.section/context` 注册表；工作集会话内字节级冻结（V4 前缀缓存语义，实测见 EFFECTS §1）。
- 对 dsh 的全部能力（tools/systemPrompt/llm/httpServer/session 事件）都是**可选服务**：`ctx.get()` + 缺失降级 + effect disposer 回收。
- 凭据只从环境变量读（`DEEPSEEK_API_KEY` 等）；源码/测试/文档不落任何可用凭据字面量。
- 辅助 LLM 调用（查询改写/judge 类小 max_tokens 任务）必须 `thinking: {type:'disabled'}`，否则 V4 推理吞掉正文。

## 目录与约定

- `src/core/` 服务与引擎（service、retriever、consolidator、working-set、injection、cost-tracker、markdown-projection、peak-pricing、subagent-fiber）
- `src/pipeline/` 蒸馏（distiller、trajectory-filter、correction-extractor、verification-gate）
- `src/storage/` SQLite 三级降级底座；`src/api/` HTTP 面；`src/ui/`+`src/client/` Web 面板；`tests/` vitest
- 作用域语义：`scope='global'` 跨项目跟随用户；`workspace` 记忆按 `origin_cwd`（写入时的 cwd）隔离，旧 `*` 全局可见——新增读路径必须带 origin 过滤
- 版本记录只进 CHANGELOG.md；实测数字只进 EFFECTS.md（README 只放结论摘要）

## 当前状态与下一步

- v2.5.0：写入端主题词补全（治本冷词表，longmem-mini both-gold@5 0.70→0.90）+ 端到端 QA 评测 harness（`evals/longmemeval-e2e.mjs`，作答+judge 分层）；105/105 测试；GitHub `W117C/dsh-memory` main + tag v2.5.0 待推送。
- **pending**：npm 未发布（本机无凭据，待 `npm login` 后 `npm publish`，publishConfig 已配 public）。
- 下一步候选：dsh-ultra 编排层本体（另一仓库/规划）。

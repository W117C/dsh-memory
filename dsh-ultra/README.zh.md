# dsh-ultra

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Ultracode 等价语义层：effort 分级、自动编排、阶段路由与成本护栏——全部以 Cordis 插件形态构建在 harness 现有的 workflow / subagent / reasoning 接缝之上（见 `dsh-ultra-PLAN.md` 中的 `ADR-001`）。

## 状态

| 组件 | 状态 |
|---|---|
| `ultra-effort` — `/effort` 分级 | 已实现（v0.1.0） |
| `ultra-orchestrator` — 自动触发分类器 + 脚本生成 | 规划中（P2） |
| `ultra-router` — Pro/Flash 阶段路由 | 规划中（P3） |
| `ultra-guard` — 预算、`/workflows`、成本报表 | 规划中（P3） |
| `ultra-preset` — 一键启用 | 规划中（P4） |

## `ultra-effort` 做什么

注册 `/effort` 命令，把 Claude Code 的 effort 词汇映射到 DeepSeek Harness：

| `/effort` 档位 | reasoningEffort | autoOrchestrate |
|---|---|---|
| `low` | `off`（关闭思考） | off |
| `medium` | `high` | off |
| `high` | `high` | off |
| `xhigh` | `max` | off |
| `ultracode` | `max` | on |

映射与编排开关均可部署时配置。DeepSeek V4 只暴露 `off` / `high` / `max` 三档 reasoning effort，因此中档收敛到 `high`、顶档收敛到 `max`；DeepSeek 适配器已经把这些序列化为 `thinking: {type: 'enabled'|'disabled'}`，并在工具调用轮处理 `reasoning_content` 回传，无需打适配器补丁。

## 工作原理

`/effort <level>` 做两次写入：

1. 把档位记录到 `ultra-effort` settings 命名空间（编排层读取的语义事实源）。
2. 通过 `ctx.agentDefaultModel.saveSelection()` 把解析出的 `reasoningEffort` 写入默认模型选择，agent 循环对后续请求应用。provider 与 model 保持不变。

`/effort` 无参数时报告当前档位及其解析策略，以及默认模型选择当前解析出的 `reasoningEffort`；两者不一致时（例如绕过 `/effort` 的编辑）会标记并给出 resync 提示。设置档位适用于**新会话与子 agent**——该选择是未显式指定模型的 Agent 的 harness 默认值（见「已知限制」）。

两次写入以承重方（模型选择）为先排序；记录档位失败会以错误形式呈现，同时 effort 保持生效，两个事实不会静默分叉。

## 安装

```sh
dsh plugin --profile <name> add ./dsh-ultra          # 本地检出
dsh plugin --profile <name> add github:you/dsh-ultra # git 安装（经 prepare 构建）
```

运行时 `@deepseek-ai/*` 依赖声明为 `peerDependencies`（宿主 profile 已提供，闭包不会携带重复副本）；`devDependencies` 为本地开发保留 workspace 链接。npm 分发时，`pnpm publish` 只发布 `lib/` + `cordis.patch.yml`（`files` 白名单优先于 `.gitignore`），消费者用 `dsh plugin --profile <name> add dsh-ultra` 安装。

git 安装需要包的构建许可（profile `pnpm-workspace.yaml` 中的 `allowBuilds`）；具体键见 harness 发布指南。

## 配置

插件自带无补丁期配置；schemastery 默认值生效。要覆盖映射或编排档位，在 profile 补丁的 `ultra-effort` 行上添加 `config` 块：

```yaml
- id: ultra-effort
  name: dsh-ultra
  config:
    effortMap:
      medium: max
    autoOrchestrateLevels:
      - xhigh
      - ultracode
```

`Config` 字段：

- `effortMap` — 各档位的适配器 `reasoningEffort`（`off` | `high` | `max`）。
- `autoOrchestrateLevels` — 启用自动编排的档位。

## 开发

本包是独立仓库，其 `pnpm-workspace.yaml` 把 DeepSeek Harness 检出（同级目录）作为 pnpm workspace 链接，因此每个 `@deepseek-ai/*` import 都解析到 harness 源码。已验证流程：

```sh
# 1.（一次性，在 deepseek-harness 中）构建依赖闭包，使各包的
#    `lib/types/*.d.ts` 存在以完成类型解析：
npx tsc -b packages/core/agent-default-model/tsconfig.json \
          packages/interaction/commands/tsconfig.json \
          packages/settings/settings/tsconfig.json
# 2. 安装 + 门禁（在 dsh-ultra 中）：
pnpm install        # 解析 harness workspace 依赖 + dev 依赖
pnpm typecheck      # tsc -p tsconfig.json（noEmit，从 lib/types 解析类型）
pnpm test           # vitest：effort 映射 + /effort 装配
pnpm build          # 输出 ESM + 类型到 lib/（git 安装时也经 prepare 运行）
```

构建/`prepare` 只输出 `src/`（rootDir），`@deepseek-ai/*` 保持为宿主在运行时解析的裸 import。typecheck 刻意清空 harness 基座的源码路径映射（`paths: {}`）并从构建出的 `.d.ts` 解析，因此 vendored 框架源码永远不会进入本程序。Vitest 则通过 `vitest.config.ts` 别名把每个 `@deepseek-ai/*` 包映射到 harness 检出的 `src/`，测试直接覆盖 harness 源码（harness 自己的 `vite-tsconfig-paths` 发现机制到不了本目录——它在 harness 树之外）。

## 已知限制与延后工作

- 把所选 effort 应用到**默认**模型选择（新 agent 与子 agent）。刻意延后对已在驻会话的持久化 header 的干预，避免触碰 agent 循环（ADR-001）。
- 在 `ultra-orchestrator` 落地前，编排开关暂无消费者。

## License

MIT

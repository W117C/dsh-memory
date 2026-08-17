# dsh-ultra

Ultracode-equivalent semantic layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): effort grading, automatic orchestration, stage routing, and cost guardrails — built entirely as Cordis plugins over the harness's existing workflow / subagent / reasoning seams (see `ADR-001` in `dsh-ultra-PLAN.md`).

## Status

| Component | Status |
|---|---|
| `ultra-effort` — `/effort` grading | Implemented (v0.1.0) |
| `ultra-orchestrator` — auto-trigger classifier + script generation | Planned (P2) |
| `ultra-router` — Pro/Flash stage routing | Planned (P3) |
| `ultra-guard` — budgets, `/workflows`, cost reports | Planned (P3) |
| `ultra-preset` — one-click enablement | Planned (P4) |

## What `ultra-effort` does

Registers the `/effort` command and maps the Claude Code effort vocabulary onto
DeepSeek Harness:

| `/effort` level | reasoningEffort | autoOrchestrate |
|---|---|---|
| `low` | `off` (thinking disabled) | off |
| `medium` | `high` | off |
| `high` | `high` | off |
| `xhigh` | `max` | off |
| `ultracode` | `max` | on |

The mapping and the orchestration toggle are deployment-configurable. DeepSeek
V4 exposes only `off` / `high` / `max` reasoning effort, so the mid tiers
converge on `high` and the top tiers on `max`; the DeepSeek adapter already
serializes these as `thinking: {type: 'enabled'|'disabled'}` and handles
`reasoning_content` passback on tool-call turns, so no adapter patch is
required.

## How it works

`/effort <level>` does two writes:

1. Records the level under the `ultra-effort` settings namespace (the semantic
   source of truth the orchestration layer reads).
2. Writes the resolved `reasoningEffort` into the default model selection via
   `ctx.agentDefaultModel.saveSelection()`, which the agent loop applies to
   subsequent requests. Provider and model are preserved.

`/effort` with no argument reports the current level and its resolved policy,
plus the `reasoningEffort` the default model selection currently resolves to;
a mismatch between the two (e.g. an edit bypassing `/effort`) is flagged with a
resync hint. Setting a level applies to **new sessions and child agents** — the
selection is the harness default for Agents created without an explicit model
(see "Known Limitations").

The two writes are ordered so the load-bearing one (the model selection) happens
first; a failure to record the level is surfaced as an error while keeping the
effort live, so the two facts cannot silently diverge.

## Install

```sh
dsh plugin --profile <name> add ./dsh-ultra          # local checkout
dsh plugin --profile <name> add github:you/dsh-ultra # git install (builds via prepare)
```

Runtime `@deepseek-ai/*` dependencies are declared as `peerDependencies` (the
host profile already provides them, so the closure carries no duplicate
copies); `devDependencies` keep the workspace links for local development.
For npm-based distribution, `pnpm publish` ships `lib/` + `cordis.patch.yml`
(the `files` allowlist takes precedence over `.gitignore`), so consumers install
with `dsh plugin --profile <name> add dsh-ultra`.

Git installs require the package build allowance (`allowBuilds` in the profile
`pnpm-workspace.yaml`); see the harness publish guide for the exact key.

## Configuration

The plugin ships with no patch-time config; the schemastery defaults apply. To
override the mapping or the orchestration levels, add a `config` block on the
`ultra-effort` row in your profile patch:

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

`Config` fields:

- `effortMap` — per-level adapter `reasoningEffort` (`off` | `high` | `max`).
- `autoOrchestrateLevels` — levels that enable automatic orchestration.

## Development

This package is a standalone repo whose `pnpm-workspace.yaml` links the DeepSeek
Harness checkout (sibling directory) as a pnpm workspace, so every
`@deepseek-ai/*` import resolves against the harness source. Verified flow:

```sh
# 1. (one-time, in deepseek-harness) build the dependency closure so the
#    packages' `lib/types/*.d.ts` exist for type resolution:
npx tsc -b packages/core/agent-default-model/tsconfig.json \
          packages/interaction/commands/tsconfig.json \
          packages/settings/settings/tsconfig.json
# 2. install + gates (in dsh-ultra):
pnpm install        # resolves harness workspace deps + dev deps
pnpm typecheck      # tsc -p tsconfig.json (noEmit, resolves types from lib/types)
pnpm test           # vitest: effort mapping + /effort wiring
pnpm build          # emits ESM + types to lib/ (also runs on git install via prepare)
```

The build/`prepare` emits only `src/` (rootDir), leaving `@deepseek-ai/*` as
bare imports resolved by the host at runtime. Typecheck deliberately clears the
harness base's source-path mapping (`paths: {}`) and resolves from the built
`.d.ts`, so vendored framework sources are never pulled into this program.
Vitest instead maps every `@deepseek-ai/*` package to the harness checkout's
`src/` via `vitest.config.ts` aliases, so tests exercise the harness source
directly (the harness's own `vite-tsconfig-paths` discovery does not reach this
directory, which sits outside the harness tree).

## Known Limitations and Deferred Work

- Applies the selected effort to the **default** model selection (new agents
  and children). Steering an already-resident session's persisted header is
  intentionally deferred to avoid touching the agent loop (ADR-001).
- The orchestration toggle currently has no consumer until `ultra-orchestrator`
  lands.

## License

MIT

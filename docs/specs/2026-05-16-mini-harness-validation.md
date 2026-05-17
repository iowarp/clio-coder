# Mini Harness Validation, 2026-05-16

This note records a real-target validation pass for Clio Coder against the
homelab `mini` target. It is intentionally source- and receipt-grounded: no
mock model endpoints, no synthetic TUI, no remote publication.

## Scope

- Start time: 2026-05-16 17:03 CDT.
- Minimum run window: 60 minutes, ending no earlier than 18:03 CDT.
- Target: `mini`.
- Runtime: `llamacpp`.
- Endpoint: `http://192.168.86.141:8080`.
- Primary model: `AgenticQwen-30B-A3B-i1-Q4_K_M`.
- Harness paths under test:
  - `clio targets --json`
  - `clio models --target mini --json`
  - direct llama.cpp `/health`, `/v1/models`, and chat-completions probes
  - `clio --print` through the active mini model
  - `clio run` dispatch with explicit target/model/tool profile
  - tmux-driven interactive TUI model selection and `/run`
  - receipt creation and verification

## Source Grounding

- `.claude/skills/clio-testing/SKILL.md` defines the test layers and requires
  real spawn/pty harness checks for CLI/TUI behavior.
- `~/.claude/skills/hlab/SKILL.md` identifies `mini` as the AI inference/NFS
  node at `192.168.86.141`.
- `~/dotfiles/homelab/inventory.yaml` identifies `llama-server` on `mini:8080`
  as a systemd `llama` service with `/health` and `/v1/models` endpoints.
- `src/interactive/slash-commands.ts` routes `/model [pattern[:thinking]]`
  through `resolveModelReference()` and `/run` through the dispatch contract
  with explicit `target`, `model`, `thinking`, and `toolProfile` options.
- `src/domains/providers/models/local-models/clio-local-coding-targets.yaml`
  defines `agenticqwen-30b-a3b-i1` as a qwen-tool, reasoning-capable local
  coding model with 262144 context and 65536 max tokens.

## Live Baseline

| Check | Result |
| --- | --- |
| Local clock | 2026-05-16 17:03:09 CDT |
| `clio models --target mini --json` | 23 mini models; `AgenticQwen-30B-A3B-i1-Q4_K_M` first |
| AgenticQwen capabilities | `CTR----`, context 262144, max tokens 65536, reasoning true |

## Run Log

The sections below were filled during the timed pass.

### Direct Endpoint

| Check | Result |
| --- | --- |
| `curl /health` | `{"status":"ok"}` |
| `curl /v1/models` | 23 live models; `AgenticQwen-30B-A3B-i1-Q4_K_M` present |
| Raw chat-completions probe | `HOUR_DIRECT_AGENTIC_OK` |
| Raw chat usage | 16 prompt tokens, 7 completion tokens, 23 total |

### CLI Model Selection

| Check | Result |
| --- | --- |
| `clio doctor --json` under isolated copied config | `ok: true` |
| `clio targets --json` | 6 targets; `mini` available via `store:api_key:llamacpp-completion` |
| `mini` runtime | `llamacpp` |
| `mini` default model | `AgenticQwen-30B-A3B-i1-Q4_K_M` |
| `mini` capabilities | chat/tools/reasoning true, qwen tool calls, qwen chat-template thinking, structured JSON schema, 262144 context, 65536 max tokens |
| `clio models --target mini --json` | 23 rows; AgenticQwen first |
| `clio --print` | returned `HOUR_CLIO_PRINT_MINI_OK`; stderr only warned that `CLIO.md` fingerprint differs from current project state |
| `clio --mode json` | streamed 27 JSONL events and final text `HOUR_CLIO_JSON_MINI_OK` |

### Dispatch Receipts

All dispatch checks used:

```bash
node dist/cli/index.js run \
  --target mini \
  --model AgenticQwen-30B-A3B-i1-Q4_K_M \
  --thinking off \
  --json ...
```

| Run | Agent | Tool profile | Result | Time | Tokens | Tool calls | Notes |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `2vxy2i78vhdg` | scout | `minimal-local` | exit 0, integrity present | 4961 ms | 1603 | 3 | `ls` x2, `read` x1; 3 allowed, 0 blocked |
| `38ffp663hwxt` | worker | `science-local` | exit 0, integrity present | 30960 ms | 5058 | 9 | `package_script typecheck` passed twice; model also tried `run_build`/`run_lint` with invalid `--no-emit` args, producing 3 tool errors before recovering |
| `wxf6l53kwgcs` | worker | `full-agent` | exit 0, integrity present | 3926 ms | 1411 | 2 | `read` x1, `ls` x1; no writes or shell commands used despite broad requested action surface |

`science-local` is real validation-capable but still exposes enough execution
verbs for the local model to make argument-selection mistakes. The successful
path was `package_script` with `script=typecheck`; the failed path was adding
`--no-emit` to `run_build`/`run_lint`, where `tsup` and Biome reject that flag.

### Tmux TUI

Tmux was launched against the isolated copied config:

```bash
CLIO_HOME=/tmp/clio-mini-hour... \
CLIO_CONFIG_DIR=/tmp/clio-mini-hour.../config \
CLIO_DATA_DIR=/tmp/clio-mini-hour.../data \
CLIO_CACHE_DIR=/tmp/clio-mini-hour.../cache \
node dist/cli/index.js
```

| Check | Result |
| --- | --- |
| TUI boot | rendered `Clio Coder`, 6/6 targets, active `mini · AgenticQwen-30B-A3B-i1-Q4_K_M` |
| `/model mini/AgenticQwen-30B-A3B-i1-Q4_K_M:off` | printed `[/model] active: mini/AgenticQwen-30B-A3B-i1-Q4_K_M thinking=off` |
| `/model` overlay | rendered `360 models · 6 targets · 91 local 269 cloud`, current AgenticQwen row selected, mini llama.cpp rows with `262kctx` and `TR`/`TRV` caps |
| `/thinking` after `:off` | selector showed `off` selected |
| `/model Qwen3.5-0.8B-UD-Q4_K_XL:off` | printed active mini/Qwen3.5-0.8B selection |
| `/model AgenticQwen-30B-A3B-i1-Q4_K_M:high` | printed active AgenticQwen selection with high thinking |
| TUI chat | returned `HOUR_TMUX_AGENTIC_FINAL_OK` through `mini/AgenticQwen-30B-A3B-i1-Q4_K_M`, `↑17 ↓33`, no tool call |
| TUI `/run` | run `18wecptojkj4`, exit 0, `minimal-local`, 4299 ms, 1582 tokens, 3 tool calls |
| `/receipts verify 18wecptojkj4` | `ok` |

Observed UI wrinkle: after direct `/model ...:off`, the footer still rendered
`◆ high` even though the `/thinking` selector showed `off` selected. The
setting did update when later selecting `AgenticQwen...:high`; the stale footer
appears to be a repaint/state-propagation issue rather than a failed resolver.

### Soak

The timed soak loop ran from `2026-05-16 17:09:09 CDT` to
`2026-05-16 18:03:09 CDT`, after the original 17:03 user request window.

Each iteration queried the live llama.cpp health endpoint, the live llama.cpp
model list, Clio's mini model list, and a direct AgenticQwen chat marker. Every
third iteration also ran a real `clio run` `minimal-local` dispatch.

| Iteration | Timestamp | Health | Live models | Clio mini models | Chat marker | Dispatch |
| --- | --- | --- | ---: | ---: | --- | --- |
| 1 | 17:09:10 | ok | 23 | 23 | `SOAK_1_OK` | skipped |
| 2 | 17:13:44 | ok | 23 | 23 | `SOAK_2_OK` | skipped |
| 3 | 17:18:19 | ok | 23 | 23 | `SOAK_3_OK` | `3mc0quck47is`, exit 0, 1648 tokens, 3 tools |
| 4 | 17:23:13 | ok | 23 | 23 | `SOAK_4_OK` | skipped |
| 5 | 17:27:45 | ok | 23 | 23 | `SOAK_5_OK` | skipped |
| 6 | 17:32:20 | ok | 23 | 23 | `SOAK_6_OK` | `2qtofdd3i88l`, exit 0, 1555 tokens, 3 tools |
| 7 | 17:37:12 | ok | 23 | 23 | `SOAK_7_OK` | skipped |
| 8 | 17:41:47 | ok | 23 | 23 | `SOAK_8_OK` | skipped |
| 9 | 17:46:19 | ok | 23 | 23 | `SOAK_9_OK` | `7n3ql8ne64th`, exit 0, 1462 tokens, 2 tools |
| 10 | 17:51:10 | ok | 23 | 23 | `SOAK_10_OK` | skipped |
| 11 | 17:55:46 | ok | 23 | 23 | `SOAK_11_OK` | skipped |
| 12 | 18:00:20 | ok | 23 | 23 | `SOAK_12_OK` | `26qy0ohczwi0`, exit 0, 477 tokens, 2 tools |
| 13 | 18:02:54 | ok | 23 | 23 | `SOAK_13_OK` | skipped |

All four soak dispatch receipts had integrity blocks, exit code 0, and
`minimal-local` recorded in safety metadata. No health failures, model-count
drift, blocked tools, or dispatch failures were observed.

### Regression Suite

Final verification after the timed mini soak:

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run lint` | passed, 606 files checked |
| `npm run test` | passed, 1282 tests / 254 suites |
| `npm run test:e2e` | passed, 68 tests / 4 suites |

## Findings

- The real mini llama.cpp target stayed available for the full timed pass.
- Clio's configured model inventory matched the live llama.cpp `/v1/models`
  inventory across every soak iteration.
- `AgenticQwen-30B-A3B-i1-Q4_K_M` handled raw chat, top-level Clio chat,
  JSONL mode, dispatch workers, and TUI chat.
- Model selection by slash command resolved both AgenticQwen and another mini
  model, and the model picker exposed the live mini models with context/caps.
- Receipt-backed `minimal-local` dispatch is stable on mini.
- `science-local` can run validation, but the local model may misuse validation
  tool arguments when multiple execution tools are present.
- The TUI footer can lag behind `/model ...:off` thinking changes even when the
  `/thinking` selector shows the new value.

## Cleanup

Completed.

- Closed the tmux TUI session used for interactive mini testing.
- Removed the isolated copied-config tree at `/tmp/clio-mini-hour...`.
- Verified no `clio-mini-hour`, `clio-real`, or `clio-source-probe.ts`
  leftovers in `/tmp`.
- Verified no related tmux sessions or Clio test processes were left running.

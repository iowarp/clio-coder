## Bring an installed coding agent

CLIO Coder can dispatch a focused task to a configured coding peer or open an interactive handoff pane. Install and authenticate that peer's own CLI first, then inspect what is available:

```sh
clio-coder interop inspect --json
clio-coder configure --interop
```

In the terminal, `/library interop` shows available connections. Supported managed modes vary by peer: Claude Code, Codex, OpenCode, GitHub Copilot, and the Antigravity CLI have ACP recipes; other peers may use a headless CLI or a pane.

- `/run <agent-id> <task>` uses a configured ACP connection; `/run acp:<id> <task>` names one explicitly.
- `/run --target <target> <agent> <task>` uses a configured headless target.
- `/panes peer [--cwd <path>] <agent> [brief]` opens an interactive pane beside the conversation.

Managed ACP and headless runs record results in sealed run records. A pane is an interactive handoff and does not produce a run record. For a headless task, `--worktree` preserves a Git task branch for review; it does not confine the peer's filesystem or network access.

A peer that runs its own tool loop is refused write-capable work unless you trust it with `trustedUnmediated: true` in your user settings: on the target for a headless peer, or on its external-agent entry for an ACP peer.

## Delegate to the Antigravity CLI

The Antigravity CLI (`agy`) is a built-in ACP target with the id `antigravity`. Sign in with `agy`, add the connection with `clio-coder configure --interop`, then run `/run antigravity <task>`. CLIO Coder uses the `agy` login already on the machine and needs `agy` 1.5.1 or later.

A dispatch can name a model and a thinking level, and a `<model>-<level>` id selects both. When `agy` does not offer the choice, the run fails and lists the values it does offer. A question from `agy` appears as a card headed "Delegated agent"; with no operator attached, it is cancelled.

A steer reaches `agy` as its own prompt while the turn keeps running. When the `agy` quota runs out, the run fails with the reset time and the retry moves to another target. CLIO Coder judges each `run_command` and `run_workflow` call by the command it runs.

## Review resources from another agent

The Library can discover supported foreign resources and review their origin, scope, trust, and actual availability before adoption. It identifies unsupported components rather than treating an entire foreign package as compatible.

Run `clio-coder interop adopt <host> --dry-run`, for example with `claude-code`, `codex`, or `copilot`, to see the plan. Run it again without `--dry-run` to approve it into your user library, or add `--project`. In the terminal, `o` in `/library` opens the same review.

## Connect an ACP frontend

To use CLIO Coder from an editor that speaks the Agent Client Protocol (ACP), point the editor's ACP agent entry at `clio-coder acp`. The editor then exchanges JSON-RPC with that process over stdio, with session listing, resume, fork, modes, and model selection.

```sh
clio-coder acp --cwd /path/to/project
```

These launch options are the operator's limits; a client can narrow them but never widen them:

| Option | Effect |
| --- | --- |
| `--cwd PATH` | Pins the workspace. Without it, the editor's first session request selects it. |
| `--permission-timeout MS` | Longest wait, in milliseconds, for one permission answer from the editor; defaults to `integrations.externalAgents.defaults.permissionTimeoutMs`, 120000. |
| `--autonomy LEVEL` | The highest autonomy any session may use, `default` or `yolo`; it never raises your configured level. |
| `--allow-tools NAMES` | Limits the session's tools to these comma-separated names, as `clio-coder run` does; `none` disables all. |
| `--delegate-tools NAMES` | Limits the tools the session's dispatched workers may hold. |
| `--read-only` | Holds every session at the read-only ceiling. No file outside CLIO Coder's own home changes. |

`clio-coder acp auth login` opens the interactive Quick Connect setup, so an editor's terminal sign-in step can create a connection. Stdout carries only protocol messages; diagnostics go to stderr. The [ACP protocol reference](../architecture/acp.md) covers capabilities, authentication, permissions, and telemetry in detail. Consult the full guide for peer-specific setup and for installing CLIO Coder's portable library in other agents.

## Built on the Pi SDK

CLIO Coder's model connections, agent loop, and terminal interface are built on the Pi SDK. CLIO Coder pins the Pi 1.5.2 packages to exact versions and bundles the one terminal package it patches, so an npm install needs no patch step. CLIO Coder owns everything above that layer: permissions, workers, sessions, run records, and its own handling for local model servers.

Pi's coding agent is also a delegation peer. With the `pi` command installed and signed in, a target on the `pi-cli` runtime runs headless worker tasks under Pi's own login. Like other peers that run their own tool loop, it needs `trustedUnmediated: true` on the target before it may take write-capable work. Developers upgrading the SDK can read the [Pi SDK boundary](../architecture/pi-boundary.md).

# Editors and other agents

Use supported agent connections and editor integrations.

## Bring an installed coding agent

Clio can dispatch a focused task to a configured coding peer or open an interactive handoff pane. Install and authenticate that peer's own CLI first, then inspect what Clio can use:

```sh
clio-coder interop inspect --json
clio-coder configure --interop
```

In the terminal, `/interop` shows available connections. Supported managed modes vary by peer: Claude Code, Codex, and OpenCode have ACP recipes; other peers may use a headless CLI or a pane.

- `/delegate <peer> <task>` uses a configured ACP connection.
- `/run --target <target> <agent> <task>` uses a configured headless target.
- `/peer <peer> <brief>` opens an interactive Herdr pane.

Managed ACP and headless runs record results and receipts. A pane is an interactive handoff and does not produce a managed receipt. For a headless task, `--worktree` preserves a Git task branch for review; it does not confine the peer's filesystem or network access.

A peer that runs its own tool loop is refused write-capable work unless you trust it with `trustedUnmediated: true` in your user settings: on the target for a headless peer, or on its external-agent entry for an ACP peer.

## Review resources from another agent

The Library can discover supported foreign resources and review their origin, scope, trust, and actual availability before adoption. It identifies unsupported components rather than treating an entire foreign package as compatible.

Open `/library`, then use its local-agent discovery action. Inspect the proposed resources and approve the ones you want in your user or project library.

## Connect an ACP frontend

```sh
clio-coder acp --cwd /path/to/project
```

This serves Clio over stdio for an ACP frontend, with session listing, resume, modes, and model options. Consult the full guide for peer-specific setup, permission limits, and installing Clio's portable library in other agents.

# Security policy

Clio Coder is alpha software. Until the project reaches a stable release, only
the latest tagged minor version receives security fixes.

| Version  | Supported          |
| -------- | ------------------ |
| `0.1.x`  | Latest patch only  |
| `< 0.1`  | No                 |

## Reporting a vulnerability

Do **not** open a public GitHub issue for security reports.

Use one of the following private channels:

1. **GitHub private security advisory.** Open a draft advisory at
   <https://github.com/iowarp/clio-coder/security/advisories/new>. This is
   the preferred channel because it keeps the report scoped to the
   maintainers and the reporter.
2. **Email.** Send a description to `a.kougkas@gmail.com` with subject prefix
   `[clio-coder security]`.

Include:

- Affected version (`clio --version` output).
- A minimal reproduction or proof of concept.
- The impact you observed (information disclosure, code execution,
  privilege escalation, credential exposure, sandbox bypass).
- Whether the issue requires a specific runtime, target, or model.

## What to expect

- Acknowledgement within five working days.
- A coordinated fix window. The maintainer will share a target patch date
  and credit the reporter in the release notes if requested.
- Public disclosure after a fix ships, unless the reporter requests
  earlier disclosure or the issue is independently public.

## Scope

In scope:

- The `clio` CLI and its subcommands.
- The interactive TUI session and slash-command surface.
- The dispatch worker subprocess path and IPC.
- Receipts, audit JSONL, and session JSONL persistence.
- The damage-control rule pack and safety mode gates.

Out of scope:

- Vulnerabilities in upstream dependencies that already have a public CVE
  and are tracked through dependency updates.
- Local attacks that require an attacker who already has read or write
  access to the user's home directory.
- Bugs in third-party model providers, local runtimes, or CLI-backed
  runtimes; report those upstream.

## Responsible use

Clio Coder writes to the local filesystem, dispatches subprocesses, and can
reach external model APIs when configured to. Run it inside a repository
you own and review every tool call before granting `super` mode. Do not
paste API keys, private source, or proprietary prompts into public issues
or pull requests.

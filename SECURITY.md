# Security Policy

Clio Coder is alpha software. Until the project reaches a stable release,
only the latest tagged alpha minor version receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| `0.2.x` | Latest alpha patch |
| `0.1.x` | No                 |
| `< 0.1` | No                 |

## Reporting a Vulnerability

Do **not** open a public GitHub issue for security reports.

Use one of these private channels:

1. **GitHub private security advisory** (preferred). Open a draft advisory at
   <https://github.com/iowarp/clio-coder/security/advisories/new>. It keeps
   the report scoped to the maintainers and the reporter.
2. **Email.** Send a description to `a.kougkas@gmail.com` with the subject
   prefix `[clio-coder security]`.

Include:

- The affected version (`clio --version` output) or commit.
- A minimal reproduction or proof of concept.
- The impact you observed: information disclosure, code execution, privilege
  escalation, credential exposure, or policy bypass.
- Whether the issue requires a specific runtime, target, or model.

Remove secrets from logs and screenshots before sending.

## What to Expect

- Acknowledgement within five working days.
- A coordinated fix window. The maintainer will share a target patch date and
  credit the reporter in the release notes if requested.
- Public disclosure after a fix ships, unless the reporter requests earlier
  disclosure or the issue is independently public.

## Scope

In scope:

- The `clio` CLI and its subcommands.
- The interactive TUI session and slash-command surface.
- Credential storage and leakage.
- Shell execution safety, the damage-control rule pack, and project safety
  policy enforcement.
- Filesystem write restrictions.
- The dispatch worker path and ACP delegation, including permission
  mediation.
- Receipts, audit JSONL, and session JSONL persistence.
- Runtime and provider auth behavior.

Out of scope:

- Vulnerabilities in upstream dependencies that already have a public CVE and
  are tracked through dependency updates.
- Local attacks that require an attacker who already has read or write access
  to the user's home directory.
- Bugs in third-party model providers or local model runtimes; report those
  upstream.
- Social engineering or spam.

## Responsible Use

Clio Coder writes to the local filesystem, dispatches workers, and can reach
external model APIs when configured to. Run it inside a repository you own
and review privileged actions before approving them. Do not paste API keys,
private source, or proprietary prompts into public issues or pull requests.

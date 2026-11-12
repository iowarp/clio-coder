# Security Policy

Clio Coder is pre-1.0 software. Security fixes ship in the newest release, so
the first step for any concern is to update to it.

| Version | Status |
| --- | --- |
| `0.8.x` | Current line, starting with its release candidates. Security fixes land here. |
| `0.7.x` | Stable line until 0.8.0 is released. |
| `< 0.7` | Superseded. Update to the current line. |

## Reporting a vulnerability

Please do **not** open a public GitHub issue, discussion or pull request for a
security problem, and do not send one with `/report bug`.

Use one of these private channels:

1. **GitHub private security advisory** (preferred). Open a draft advisory at
   <https://github.com/iowarp/clio-coder/security/advisories/new>. Only the
   maintainers and you can see it. `clio-coder report security` prints the
   same link and files nothing public.
2. **Email.** Send a description to `a.kougkas@gmail.com` with the subject
   prefix `[clio-coder security]`.

A useful report includes:

- The affected version (`clio-coder --version`) or commit.
- The smallest reproduction or proof of concept you have.
- What you observed: information disclosure, code execution, privilege
  escalation, credential exposure, or a safety policy that did not hold.
- Whether it needs a specific runtime, target, model, platform or setting.

Remove secrets from logs and screenshots before sending. You do not need a
complete analysis to report; a clear description of what you saw is enough to
start.

## What to expect

- An acknowledgement within five working days.
- A coordinated fix. The maintainer shares a target date for the patch and,
  if you want it, credits you in the release notes.
- Public disclosure after a fix ships, unless you ask for earlier disclosure
  or the issue is already public.

## Scope

In scope:

- The `clio-coder` command and its subcommands, the terminal interface,
  headless `clio-coder run`, and the ACP server.
- The desktop app (alpha) and its local server: authentication, launch links,
  origin checks, session access and the background service.
- The installers, `clio-coder upgrade` and `clio-coder uninstall`.
- The OS sandbox and what it hides, the damage-control rules, approval asks,
  project trust and the project safety policy.
- Credential storage, redaction, and anything that could send a credential
  to a place the operator did not choose.
- Dispatched workers and fleet nodes, MCP servers, extension runtimes and
  delegation to other coding agents, including how their permissions are
  mediated.
- Reports, diagnostic bundles and encrypted shares.
- Session, run and telemetry records on disk.

Out of scope:

- Issues confined to an upstream project with no demonstrated impact on Clio
  Coder. Do report an exploitable problem in a dependency we ship or an
  integration we provide, even when an upstream advisory already exists.
- Attacks that require an attacker who already has read or write access to
  the user's home directory.
- Bugs in third-party model providers or local model runtimes. Report those
  upstream.
- Social engineering and spam.

## Running Clio Coder safely

Clio Coder edits files, runs commands, dispatches workers and calls the model
endpoints you configure. Where the host has a sandbox backend (bubblewrap on
Linux, Seatbelt on macOS), it runs shell commands inside an OS sandbox under
`safety.sandbox`, which defaults to `auto`. The
[safety model](docs/architecture/safety-model.md) describes what the sandbox
hides and how approvals work, and each release's
[changelog](CHANGELOG.md) lists the known limits.

The sandbox narrows what a command can reach. It does not make an untrusted
repository safe to run unattended. Review a project's Clio Coder configuration
before you trust it, read an approval card before you answer it, and keep the
desktop app's launch links private. Do not paste API keys, private source or
proprietary prompts into public issues or pull requests; `/report` masks
paths, host names and secrets and shows you the text before it is sent.

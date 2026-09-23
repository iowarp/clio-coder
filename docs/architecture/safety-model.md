# Clio Coder Safety Model

This document specifies the security, admission, and permission architecture of Clio Coder across [src/domains/safety/](../../src/domains/safety/).

**Core Invariant**: *Admission policy is not a general operating-system sandbox. Clio enforces security through strict admission gating, path containment, damage-control rules, and explicit operator consent.*

---

## 1. Dual-Axis Security: Autonomy & Safety Net

Clio evaluates actions across two orthogonal axes:
1. **Autonomy Level**: Governs what actions the agent may execute without prompting the operator.
2. **Safety Net**: Rules that detect destructive or risky actions regardless of autonomy level.

### Autonomy Levels

| Level | Read Access | Mutate Workspace | Shell Execution | External Network |
| :--- | :--- | :--- | :--- | :--- |
| `read-only` | Allowed (inside workspace) | Refused / Parks | Refused / Parks | Refused |
| `auto-edit` *(Default)* | Allowed | Allowed (inside write roots) | Parks for confirmation | Parks for confirmation |
| `full-auto` | Allowed | Allowed | Allowed (non-destructive) | Allowed |

*Note*: Test runners (`npm test`, `pytest`, `cargo test`) are recognized as read-safe execution at `auto-edit`.

### Presentation vs Authority
- **Consequence Tiers** (`low`, `medium`, `high`, `critical`) are purely advisory visual signals rendered in approval prompts.
- **Authority**: Determined strictly by the policy engine rules, never by LLM self-classification.

---

## 2. Policy Engine Evaluation Order

Every tool call passes through the admission pipeline in strict sequence:

```
[Tool Invocation]
       │
       ▼
1. Tool Policy Gating ──(Refused?)──► [Reject Call]
       │ OK
       ▼
2. Path Containment & Symlink Resolution ──(Escaping?)──► [Park / Refuse]
       │ OK
       ▼
3. Damage-Control Pattern Matching ──(Destructive?)──► [Hard Block / Require Confirmation]
       │ OK
       ▼
4. Autonomy Check ──(Exceeds Level?)──► [Park for Operator Approval]
       │ Permitted
       ▼
[Execute Action]
```

### Symlink & Path Canonicalization Invariants
- **Full Path Traversal**: Resolves every intermediate symlink component to prevent directory breakout.
- **`..` Resolution**: Traversal after a symlink resolves relative to the *target* directory, matching OS kernel resolution.
- **Write Roots**: Writes outside declared `write_roots` are strictly rejected.

---

## 3. Shell Admission & Damage Control

Shell commands executed via `bash` pass through semantic analysis before spawning:

### 3.1 Damage-Control Rules (`damage-control-rules.yaml`)
- **Hard Blocked**:
  - Recursive deletions (`rm -rf /`, `rm -rf ~`, `rm -rf .git`).
  - Raw disk or partition writes (`dd`, `mkfs`, `fdisk`).
  - Remote shell execution (`curl ... | sh`, `wget ... | bash`).
  - Privilege escalation (`sudo`, `su`, `chmod 777`).
- **Confirmation Required**:
  - Arbitrary network calls (`curl`, `wget`, `ssh`).
  - Git branch destruction (`git push --force`, `git reset --hard`).
  - System service modification (`systemctl`, `service`).

### 3.2 Dynamic Argument & Expansion Inspection
- Parses shell AST to detect hidden writes, redirects (`> $HOME/.bashrc`), and variable expansion attacks.
- Chained directory changes (`cd dir && do_something`) resolve paths relative to intermediate working directories.

---

## 4. Protected Paths & Workspace Isolation

The following paths are permanently protected from agent mutations:
- `.git/` internal directory and hooks.
- `.clio-coder/` state directories, credentials, and cache.
- User home directory outside current repository root (`~/.config`, `~/.ssh`).
- Installed plugin and harness extension roots.

Attempts to write or unlink protected paths fail closed immediately.

---

## 5. Worker Isolation & Subagent Permissions

When dispatches spawn workers:
- **Inherited Floor**: Subagents inherit the parent's autonomy level or lower; they can never escalate autonomy.
- **Write Scope Scoping**: `write_roots` are restricted to declared task boundaries.
- **Git Worktree Isolation**: Concurrent workers run in isolated git worktrees (`clio/task/<runId>`) to prevent concurrent workspace corruption.
- **Lease Reclamation**: Process-level writer leases prevent multiple workers from concurrently writing to the same repository paths.

---

## 6. Rigor Gates & Finish Contracts

Tasks requiring verification enforce deterministic finish contracts:
- Verification checks declared in `tasks[].intent.verification` must run and exit code 0.
- Evidence bundles record execution digests, exit codes, and durations.
- Self-reported claims of completion are verified against host-run check results before receipts seal as `verified`.

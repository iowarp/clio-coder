# Information flow

Information flow keeps named content, such as files under `secrets/`, away from destinations the operator did not choose. Clio labels content when a source rule matches and checks its restrictions before bytes leave for a model or a mediated outbound tool. A refusal holds at `yolo` as well as `default`. With no source rules and no carried restrictions, ordinary behavior is unchanged.

This controls where observed content may go. The [safety model](../architecture/safety-model.md) still decides whether a read or tool call may run; allowing a recipient does not grant access to a protected file.

## Declare sources and recipients

Put `informationFlow` in the project's `.clio-coder/safety.yaml`. Each source has a unique `id`, at least one entry in `paths` or `tools`, and a required `recipients` list. Paths are relative to the policy root; a plain path covers its subtree, and `*` and `**` patterns are supported. Tool sources name an exact registry tool, `mcp:<server>` for all tools of a server, or `mcp:<server>/<tool>` for one tool. `recipients: []` forbids every transfer of matching content.

| Recipient | What it allows |
| --- | --- |
| `target:<id>` | A model target pinned in `informationFlow.targets` by runtime and endpoint. The live target must match both. Use endpoint `none` for a runtime without a URL. |
| `endpoint:<url>` | A mediated outbound tool's exact HTTP(S) URL, including path and query. |
| `origin:<scheme://host[:port]>` | A mediated outbound tool's URLs on that origin. |
| `mcp:<server>` | An MCP server pinned in `informationFlow.mcp` by command, arguments, working directory and declared environment. |
| `group:<name>` | The recipient references listed under `informationFlow.recipients.<name>`. |

Endpoint identity normalizes scheme, host and default port, drops credentials and fragments, and retains path and query. Endpoint and origin recipients apply to outbound tools; approve model requests with a pinned target. Changing the URL behind a target id does not preserve its approval. MCP bindings use `command`, `args`, optional `cwd` relative to the policy root, and optional `env`; omitted `cwd` means the policy root and omitted `env` means no declared entries. The live launch declaration must match the pin.

For example, this complete policy keeps content under `secrets/` on one local model target:

```yaml
version: 1
informationFlow:
  targets:
    local:
      runtime: llamacpp
      endpoint: http://127.0.0.1:8080/v1
  recipients:
    private-models: ["target:local"]
  sources:
    - id: secrets-local
      paths: [secrets/]
      recipients: ["group:private-models"]
```

Configure a target named `local` with that runtime and endpoint, review and approve this policy, then restart Clio. A permitted read of `secrets/notes.txt` labels the session with `secrets-local`. Subsequent model requests may reach the pinned `local` target; switching to a cloud target refuses the next request before it sends. Locality is not inferred from the address: the operator's pin supplies the approval. If several rules label the session, every rule must allow the destination.

The [configuration reference](configuration-reference.md#project-files) lists the project files and their schema sources.

## Review, approve and revoke

Run these commands from the workspace where the policy will apply:

```bash
clio-coder config trust safety
clio-coder config trust safety --hash <reviewed-sha256>
```

The first command is read-only: it shows captured files and their digest, followed by the exact approval command. Review those bytes before running that command. Approval is per canonical workspace and pins the exact policy bytes. Restart to load safety changes; see [project trust](commands-and-modes.md#project-trust).

An unapproved edit can only forbid more. The last approved snapshot retains its source rules, including ones removed by the edit; newly introduced unapproved rules label content with no recipients. They cannot authorize sending. If content was read under an unapproved rule, approving those **exact bytes** later and restarting opens those earlier reads to that rule's approved recipients. Any other policy change cannot widen destinations for content already read. Start a new session to work without those old restrictions; resume and compaction preserve them.

`clio-coder config trust safety --revoke` removes the workspace approval and the approved flow snapshot. After restart, rules still present in the unapproved file label content without admitting any recipient. Deleting the safety file disables future source labeling after restart and removes the snapshot. Neither revocation nor deletion erases restrictions already carried by a session. A fresh session avoids carrying earlier reads.

## What acquires a label

Path-taking read-class tools such as `read`, `ls`, `grep`, `find` and `data` label matching sources. Directory-walking tools also label sources below the directory they walk. Named tool sources label that tool's results. Bash calls and operator `!` commands label source paths they name, directory operands and glob prefixes that may walk a source. Inlined `@file` references label the referenced content too.

Shell observation is conservative: `git add .`, `find .` and `cat *.md` can label context when a source lies below the command's working directory, even if the output contains no source bytes. Clio does not provide full shell coverage. Reads hidden in scripts, variables, command substitution, relative paths after `cd`, and searches with no path operand such as `rg x` are not reliably observed.

Labels are session provenance, not per-token tracking. They travel through summaries, compaction, resume, branches and worker results; removing a visible message does not clear them. A worker's labels enter the parent before derived output. A label absorbed before a session exists is retained, and outbound transfer is refused until it can be persisted.

## Workers and other agents

Native HTTP workers admit each model request, so they can read a source on an allowed target and refuse a later request to a disallowed one. Claude Code, Codex and other CLI or SDK runtimes cannot admit their own model requests through Clio. She refuses their launch whenever any source rule, approved or unapproved, does not allow their pinned target, even before the parent has read a source. Ordinary tool mediation in an SDK does not supply this model-request boundary.

ACP agents and pane peers have no pinned model destination that Clio can approve for this purpose, so source rules refuse those delegations or content handoffs. A worker that hits this boundary ends with `information_flow_blocked`; dispatch never retries or fails over that outcome. See [exit codes and output](exit-codes-and-output.md).

## Read a refusal and recover

A policy refusal names the rule, source path or tool, and requested destination. When recipients exist, it also names the allowed recipients. Follow the recovery for that case:

| Refusal | Recovery |
| --- | --- |
| Destination is outside the rule's recipients | Switch to an allowed destination, or start a new session for work that must reach the requested destination. |
| Rule was unapproved when content was read | Approve the exact policy bytes with `clio-coder config trust safety` and restart. |
| Approved rule names no recipient | What was read stays in that session. Start a new session for work that must leave it. |
| Policy changed since a read with no recipients | Start a new session to continue without that content's old restriction. |
| Endpoint cannot be identified | Fix the destination so its identity can be established; an unresolved endpoint receives no approval. |
| Runtime cannot admit its own model requests | Use a native HTTP target, or add the pinned target to every applicable rule and approve again. Unapproved rules require approval and restart. |
| Session provenance cannot be read | Restore the session ledger and reopen the session before transferring restricted context. |
| Restriction cannot be persisted | Restore session persistence; transfer remains refused until the label is written. |
| Approved flow snapshot is unavailable or unwritable | Restore the named state file or state-directory access. Re-approve with `clio-coder config trust safety` when the refusal says the trust record does not approve the snapshot. |

Changing policy, switching models or choosing `yolo` does not clear a session's provenance. Use a new session when the refusal calls for leaving earlier content behind.

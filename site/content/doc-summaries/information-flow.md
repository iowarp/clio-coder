## What it does

Information flow keeps named content, such as files under `secrets/`, away from destinations you did not choose. A source rule labels content when a session observes it, and the restrictions are checked before bytes leave for a model or a mediated outbound tool. It does nothing until a project declares rules and you approve them.

This controls where observed content may go. The safety model still decides whether a read or tool call may run.

## Declare and approve

Put `informationFlow` in the project's `.clio-coder/safety.yaml`, with each source naming its paths or tools and its allowed recipients. Then review and approve those exact bytes:

```sh
clio-coder config trust safety
clio-coder config trust safety --hash <reviewed-sha256>
clio-coder config trust safety --revoke
```

Restart CLIO Coder after approving. An unapproved edit can only forbid more.

Recipients can be a pinned model target, an exact endpoint, an origin, a pinned MCP server, or a named group. Follow [the tutorial](/tutorials/information-flow-rules.html) for a complete worked policy.

## Example policy

This policy keeps content under `secrets/` on one local model target:

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

After approval and restart, reading `secrets/notes.txt` labels the session. Requests to the `local` target still go out; switching to a cloud target refuses the next request before it sends. `recipients: []` forbids every transfer.

The first `config trust safety` command is read-only and prints the digest to approve. After `--revoke`, rules left in the file label content without allowing any recipient.

## What acquires a label

Read tools such as `read`, `grep`, and `find` label matching paths, including sources below a directory they walk. Bash commands and `@file` references label the paths they name; reads hidden in scripts or variables are not reliably seen.

Labels belong to the session and survive compaction, resume, handoffs, and worker results. Changing the policy, the model, or the autonomy mode does not clear them. Files the session writes carry no label.

## Read a refusal and recover

A refusal names the rule, the source path or tool, the requested destination, and any allowed recipients.

| Refusal | Recovery |
| --- | --- |
| Destination is outside the rule's recipients | Switch to an allowed destination, or start a new session |
| Rule was unapproved when content was read | Approve the exact bytes and restart |
| Approved rule names no recipient | Start a new session for work that must leave |
| Runtime cannot admit its own model requests | Use a native HTTP target, or add its pinned target to every rule |

Claude Code, Codex, and other external runtimes are refused whenever a rule does not allow their pinned target. At `yolo`, mediated outbound tools skip the label check, but model requests are still checked.

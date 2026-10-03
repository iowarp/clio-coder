Some files should reach only a model you chose. An information-flow rule names a source, such as everything under `secrets/`, and the destinations its content may go to. Once a session has read that source, Clio Coder refuses to send the conversation anywhere else, in every permission mode.

::: note Advanced, new in v0.6.0
Information flow does nothing until a project declares source rules and you approve them. The policy format is new and may change. It tracks what a session has read; it is not an operating-system sandbox.
:::

::: needs
- A project where specific paths or tool results must stay with specific models.
- A configured target for each allowed model, usually a local or institutional one.
- A restart after you approve the policy.
:::

## Declare a source and where it may go

This policy keeps anything read under `secrets/` on one local model target:

```yaml title=.clio-coder/safety.yaml
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

A target is pinned by runtime and endpoint, so pointing the same name at another URL does not keep the approval. A source can also be a tool or an MCP server, and `recipients: []` means the content may go nowhere.

## Review and approve

::: steps
### Show what would be approved

```sh
clio-coder config trust safety
```

This prints the policy files, their digest, and the exact approval command. It changes nothing.

### Approve those exact bytes

```sh
clio-coder config trust safety --hash <reviewed-sha256>
```

Approval belongs to this workspace and this content. Restart Clio Coder to load it.
:::

An edit you have not approved can only restrict more: a new, unapproved rule labels content and allows no destination.

## What happens in a session

Reading `secrets/notes.txt` labels the session with `secrets-local`. Requests to the pinned `local` target continue. Switch to a cloud model and the next request is refused before it is sent, with the rule, the source, and the allowed destinations named.

The label follows the session through summaries, compaction, resume, branches, and worker results. Changing the model, the policy, or the permission mode does not clear it. To work without it, start a new session.

::: result Workers and other agents
Native workers check each model request. Coding agents that make their own model calls, such as Claude Code or Codex, are refused at launch when any rule does not allow their target, and ACP agents and pane peers are refused.
:::

::: limits
- Labels apply to the whole session, not to individual passages.
- Shell commands are observed conservatively and incompletely. A read hidden in a script, a variable, or a `cd` is not reliably seen.
- A rule controls where content may go. Whether a file may be read at all is still decided by permissions.
:::

::: next
- [Tools and permissions](/docs/guide/tool-usage.html)
- <a href="<!-- source-blob -->/docs/guide/information-flow.md">Information flow guide in the repository</a>
- [Choose a model for your project](/tutorials/choose-model-for-your-project.html)
:::

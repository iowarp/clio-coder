A plugin carries content such as skills and prompts. An extension is code: it runs in its own process, declares everything it may do, and loads only after you approve those capabilities. This guide scaffolds a small extension, tests it, installs it, and shows what the approval covers.

::: note Version scope
This guide describes v0.6.8, runtime api 2. The runtime runs inside bubblewrap on Linux or Seatbelt on macOS when a backend exists. Check `/extensions` for the confinement your host gives it.
:::

::: needs
- Clio Coder installed, on Linux or macOS for a confined runtime.
- Node.js and a little TypeScript. The scaffold includes an entrypoint and a test.
:::

::: steps
### Scaffold a package

```sh
clio-coder extensions init lint-status --template status
```

This creates the package under `.clio-coder/dev/extensions/lint-status/` and prints the next commands; `--dir` puts it elsewhere. The templates are `status`, `hook`, `panel`, `tool`, and `workspace`. Each gives you a manifest, a TypeScript entrypoint, and a test.

### Read the manifest

`clio-coder-extension.yaml` holds the declaration. Clio Coder discovers and validates it without importing or executing package code. The `runtime` block is the capability envelope, which is the part you consent to.

### Validate and test

```sh
clio-coder extensions validate .clio-coder/dev/extensions/lint-status
clio-coder extensions test .clio-coder/dev/extensions/lint-status
```

Tests can use the package's test host, which drives the same registration code the runtime uses, with in-memory state and a fake clock.

### Install and review

```sh
clio-coder extensions install .clio-coder/dev/extensions/lint-status
```

The install prints what the package would be allowed to do, then records the digest of that envelope. If the manifest changes between review and apply, the install refuses and asks for a fresh review.

### Use and manage it

```text
/extensions
/extensions reload
```

`/extensions` shows each package's state, generation, failures, commands, and confinement. From the shell, use `clio-coder extensions list`, `disable`, `enable`, and `remove`.
:::

::: result What you should see
The extension listed with its confinement, and its status in the session. This shows it loaded under the approved envelope. It does not make the code safe, so review what you install as you would any dependency.
:::

## Choose plugin or extension

::: compare
| You want to | Use |
| --- | --- |
| Share skills, prompts, agents, or playbooks | A plugin |
| Add a hook on a tool call, a runtime tool, a panel, or a timer | An extension |
| Add both, under one name | A plugin paired with an extension |
:::

A project's own extensions also need `clio-coder config trust extensions`. To try ideas without installing, a folder under `.clio-coder/dev/extensions/<id>/` is a dev extension for the terminal session, in a workspace whose project extensions you trust.

::: limits Boundaries
- Without a sandbox backend, an extension runtime runs with your permissions.
- Dev extensions load in terminal sessions. The desktop Library shows the terminal command for extension lifecycle actions.
- Reinstalling changed content needs a fresh approval.
:::

::: next
- [Add skills and plugins deliberately](/tutorials/add-skills-and-plugins-deliberately.html)
- [Install plugins](/docs/guide/plugins.html)
:::

Clio Coder's Library contains skills, agents, prompts, fleets, and plugins. You can add a procedure to one project or install it for your user. Preview what will be written, inspect the resource, and load it when a task needs it.

::: note Version scope
This guide describes v0.6.0. Library recipes and executable harness extensions have different roles, and installing either is not a grant of authority.
:::

::: diagram library-flow
:::

## Browse what ships with Clio

Open `/library` in the terminal or press Alt+L. On the desktop alpha, the Library page lists the catalog with an **Installed only** filter. In the terminal, **Browse** shows available content and **Installed** manages your copies.

::: capture tui-library-skill-tdd
:::

## Preview a small addition

::: steps
### Preview the install

Start with a resource you can evaluate, such as the shipped test-driven-development skill:

```sh
clio-coder library install skill:tdd --project --dry-run
```

Check the destination, dependencies, scope, and package pin. The `--json` form carries the full plan.

::: capture cli-library-dry-run
:::

### Install it for this project

```sh
clio-coder library install skill:tdd --project
```

### Load it for one concrete task

```text
/skill tdd Add coverage for this parser before changing its behavior.
```
:::

::: capture tui-library-installed
:::

::: result What installing establishes
The skill is available and pinned. Installing it does not establish that it writes the right tests; review its instructions, the resulting changes, and the recorded checks. The [Library guide](/docs/guide/resource-library.html) covers the current controls.
:::

## Choose project or user scope

Project packages take precedence over matching user packages, and a disabled project copy also suppresses the user copy. A project can therefore keep a resource unavailable instead of inheriting it from one developer's setup.

::: compare
| Scope | Who it serves | What takes precedence |
| --- | --- | --- |
| Project | Everyone working in this repository | A matching project package, even when disabled |
| User | You, across projects | Used when the project has no matching package |
:::

Scope helps reproducibility: another person can see which procedures belong to the project. It is not a filesystem sandbox, and the project's normal execution and tool controls still apply.

## Use plugins for related resources

A Library plugin groups related skills, prompts, agents, fleets, and supporting files. The catalog ships with Clio, but its content is not installed automatically.

```sh
clio-coder library list --kind plugin
clio-coder library install plugin:materio --dry-run
```

::: capture cli-library-list-plugin
:::

Review the bundle before installing it, and add `--project` when it should belong to the workspace. Local bundles use the same review flow; the [plugin guide](/docs/guide/plugins.html) covers structure and lifecycle.

Installation records a pin over the complete package tree, and drifted content is blocked from loading. Verifying a pin is not a way to approve arbitrary edits to an installed package; use the documented update and review workflow.

## Keep discovery separate from loading

A large Library should not mean every resource enters every model request. The coordinator starts with a smaller attached toolkit and discovers secondary capabilities when a task calls for them, and recipes load on demand.

Write clear resource descriptions and narrow procedures. A skill that explains one project's numerical-test conventions is easier to select and inspect than a bundle that promises to solve every task.

After changes made by another process, `/library reload` refreshes recipes and `/skill off` clears an active skill's armed tool surface. Neither erases earlier instructions from the conversation, and disabling a resource does not stop a tool already running.

## Know when you need an extension

Library plugins provide portable recipes. Executable harness extensions add runtime tools, hooks, or interface behavior through `clio-coder extensions`, and adding tool schemas requires a new session; reloading recipes does not change them.

::: limits
- Choose the least extensive mechanism that supplies the task.
- Review executable code before using it, and account for its commands and network access under your own machine's permissions.
- A bigger Library helps only when it serves a better-defined task.
:::

::: next
- [Your first session with Clio](/tutorials/first-session.html)
- [Library guide](/docs/guide/resource-library.html)
- [Plugin guide](/docs/guide/plugins.html)
:::

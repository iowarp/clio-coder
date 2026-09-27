Clio Coder's Library contains skills, agents, prompts, fleets, and plugins. You can add a procedure to one project or install it for your user. Preview what will be written, inspect the resource, and activate it when the task needs it.

This guide describes v0.5.7. Library recipes and executable harness extensions have different roles; installing either is not a blanket grant of authority.

## Preview a small addition

Start with a resource you can evaluate. The shipped test-driven-development skill is one example:

```sh
clio-coder library install skill:tdd --project --dry-run
```

The dry run lets you review the planned installation. Check the destination, dependencies, scope, and package pin. If the package fits the project, install it:

```sh
clio-coder library install skill:tdd --project
```

In the terminal, activate the skill for a concrete task:

```text
/skill tdd Add coverage for this parser before changing its behavior.
```

Use the [Library guide](/docs/guide/resource-library.html) for current controls. Installing the skill does not establish that it will write the right tests. Review its instructions, resulting changes, and execution evidence.

## Choose project or user scope

Project packages take precedence over matching user packages. A disabled project copy also suppresses the user copy. That gives a project a way to keep a resource unavailable rather than accidentally inheriting it from an individual developer.

Open `/library` or press Alt+L to browse categories. Browse shows available content; Installed manages copies. Inspect the selected scope before updating, disabling, or removing a package.

Scope is useful for reproducibility: another person can understand which procedures belong to the project. It is not a filesystem sandbox. The project's normal execution and tool controls still apply.

## Use plugins for related resources

A Library plugin groups related skills, prompts, agents, fleets, and supporting files. The catalog ships with Clio, but its content is not installed automatically.

```sh
clio-coder library list --kind plugin
clio-coder library install plugin:materio --dry-run
```

Review the bundle before deciding whether to install it. Add `--project` when the bundle should belong to the workspace. Local bundles use the same review flow. The [plugin guide](/docs/guide/plugins.html) covers package structure and lifecycle.

Installation records a pin over the complete package tree. Drifted content is blocked from loading. Verifying a pin is not a way to approve arbitrary edits to the installed package; use the documented update and review workflow.

## Keep discovery separate from loading

A large Library should not mean that every resource enters every model request. The coordinator's smaller attached toolkit and capability discovery let it find secondary capabilities when a task calls for them. Recipes are loaded on demand.

That makes it useful to write clear resource descriptions and narrow procedures. A skill explaining one project's numerical-test conventions is easier to select and inspect than a bundle promising to solve every development task.

After changes made by another process, `/library reload` refreshes recipes. `/skill off` clears an active skill's armed tool surface. Neither operation erases earlier instructions from the conversation, and disabling a resource does not stop an in-flight tool.

## Know when you need an extension

Library plugins provide portable recipes. Executable harness extensions add runtime tools, hooks, or interface behavior through `clio-coder extensions`. Adding tool schemas requires a new session; reloading recipes does not change those schemas.

Choose the least extensive mechanism that supplies the task's needs. Review executable code before using it, and account for commands and network access under your own machine's permissions. Start with the [first-session guide](/tutorials/first-session.html), then add one resource whose contribution you can inspect. A bigger Library is useful only when it helps you complete a better-defined task.

## Install a bundle of resources

Plugins keep related skills, prompts, agents, fleets, and supporting files together. Browse the shipped catalog and preview an installation before writing it:

```sh
clio-coder library list --kind plugin
clio-coder library install plugin:materio --dry-run
clio-coder library install plugin:materio
```

The catalog ships with Clio, but its content is not installed automatically. Add `--project` to keep a package in the current workspace; otherwise installation uses user scope.

Project packages load only in a workspace you have approved. Your own first project install approves it. After that, a change to the project's package set, including one that arrives with a clone or a pull, stays listed but unloaded until you review it with `clio-coder config trust plugins` and run the approval command it prints.

A local bundle uses the same review flow:

```sh
clio-coder library install ./my-plugin --project
```

## Keep the installed copy under control

```sh
clio-coder library inspect materio --json
clio-coder library drift materio
clio-coder library disable materio
clio-coder library enable materio
```

Installation records a verified pin covering the complete package tree. Drifted content is blocked from loading; `pin` verifies the recorded pin rather than approving edits. Review an update before replacing a modified copy.

In the terminal, open **Library → Plugins** to browse members and review lifecycle actions. Run `/library reload` after changing recipes externally.

## Choose the right kind of extension

Library plugins supply portable recipes. Executable harness extensions provide runtime tools, hooks, and interface behavior and use `clio-coder extensions` instead. Project extensions follow the same approval through `clio-coder config trust extensions`. Adding tool schemas requires a new session; recipe reload does not change those schemas.

See [skills and resources](/docs/guide/resource-library.html) for everyday Library controls. The full plugin guide covers private catalogs and package authoring.

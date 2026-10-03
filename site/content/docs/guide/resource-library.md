# Skills and resources

Browse and use skills, prompts, agents, fleets, and plugins.

## Find a useful skill

The Library contains **skills, agents, prompts, fleets, and plugins**. Open `/library` or press **Alt+L**. Switch categories with left/right, search with `/`, and open a package with Enter.

Use **Browse** to find available content and **Installed** to manage your copies. Choose **User** for tools shared across projects or **Project** for resources specific to this workspace.

For example, preview and install the test-driven-development skill:

```sh
clio-coder library install skill:tdd --project --dry-run
clio-coder library install skill:tdd --project
```

Then activate it in the terminal:

```text
/skill tdd Add coverage for this parser before changing its behavior.
```

## Review before installing

The install review shows the destination, dependencies, and verified package pin. In the Library, the selected row offers install, update, enable/disable, and remove actions when applicable. Management actions name the owning package and selected scope.

Project packages take precedence over matching user packages. A disabled project copy also suppresses the user copy, so a project can explicitly keep a resource unavailable. A project package set you have not approved for the workspace is listed but not loaded, and does not override your user copy; see [plugins](/docs/guide/plugins.html).

## Refresh a running session

After changing recipes through another process, run:

```text
/library reload
```

Disabling a package prevents subsequent discovery; it does not stop an in-flight tool or erase instructions already read. `/skill off` clears an active skill's armed tool surface without erasing earlier context.

For bundles of related resources, see [plugins](/docs/guide/plugins.html). To review resources from other coding agents, see [interoperability](/docs/guide/interop.html).

# Write and install extensions

Install and write extensions that declare what they may do.

## Plugin or extension

A plugin carries content such as skills, prompts, and playbooks. An extension is code that runs in its own process, declares everything it may do, and loads only after you approve those capabilities.

## Manage extensions

```sh
clio-coder extensions list
clio-coder extensions install <path>
clio-coder extensions disable <id>
clio-coder extensions remove <id>
```

`install` prints what the package would be allowed to do and records the digest of that declaration. If the manifest changes between review and apply, the install refuses and asks for a fresh review. In a session, `/extensions` shows each package's state, commands, and confinement.

| Command | What it does |
| --- | --- |
| `init <id> [--template <name>]` | Scaffold a manifest, entrypoint, and test |
| `validate <path>` | Check the manifest; print the envelope and its digest |
| `install <path> [--user\|--project]` | Review and install; user scope by default |
| `enable`, `disable`, `remove <id>` | Change one installed copy |
| `run <id> <command>` | Run one extension command headlessly |

Prefix each with `clio-coder extensions`. `enable`, `disable`, and `remove` act on the project copy when one exists, unless `--user` or `--project` selects one.

## Where packages live

User packages live under `<configDir>/extensions/<id>/`, project packages under `.clio-coder/extensions/<id>/`. A project package shadows the user package with the same ID, even when disabled, but only once you approve project extensions for the workspace:

```sh
clio-coder config trust extensions
clio-coder config trust extensions --hash <sha256>
```

The first is a read-only review; the second approves it. Until then a project copy lists as `untrusted` and the user copy keeps loading.

## What an extension can add

Hooks at prompt submit and around tool calls, runtime tools the model can call, status lines, panels, and work on a timer. A `before_tool` hook can refuse a call. The runtime runs inside bubblewrap on Linux or Seatbelt on macOS when a backend exists; without one, it runs with your permissions.

Approval covers the manifest's `runtime` block, the capability envelope: commands, hooks, tools with their action class, interface slots, content the runtime may see (`prompt`, `tool-args`, `tool-results`, `assistant-text`), file roots, and whether it may run programs or use the network.

Command tools under `capabilities.tools` run a `node` or `python3` script per call with no OS sandbox in 0.7.0; prefer a runtime tool when confinement matters.

## Write one

```sh
clio-coder extensions init <id> --template status
```

The templates are `status`, `hook`, `panel`, `tool`, and `workspace`. Follow [the extension tutorial](/tutorials/write-an-extension-with-declared-capabilities.html) for the whole path. A project's own extensions also need `clio-coder config trust extensions`.

The manifest, `clio-coder-extension.yaml`, requires `id`, `version`, and `description`:

```yaml
id: lab-guard
version: 1.0.0
description: Refuse writes to protected paths.
runtime:
  api: 2
  entrypoint: runtime/extension.ts
  commands:
    - { name: protect, description: Protect a path against write and edit calls. }
```

The code must register exactly what the manifest declares, and Clio Coder never installs dependencies. Run `validate` and `test`, then `install`; a running session picks it up after `/extensions reload`.

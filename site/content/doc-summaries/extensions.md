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

## What an extension can add

Hooks at prompt submit and around tool calls, runtime tools the model can call, status lines, panels, and work on a timer. A `before_tool` hook can refuse a call. The runtime runs inside bubblewrap on Linux or Seatbelt on macOS when a backend exists; without one, it runs with your permissions.

## Write one

```sh
clio-coder extensions init <id> --template status
```

The templates are `status`, `hook`, `panel`, `tool`, and `workspace`. Follow [the extension tutorial](/tutorials/write-an-extension-with-declared-capabilities.html) for the whole path. A project's own extensions also need `clio-coder config trust extensions`.

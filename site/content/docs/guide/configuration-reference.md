# Configuration essentials

Find settings layers, save scopes, and the full configuration reference.

## Prefer the Settings Center

Use `/settings`, desktop **Settings**, or:

```sh
clio-coder configure --settings
```

Configure and desktop Settings share eight sections: Connections, Chat, Fleet, Context & Memory, Permissions & Limits, Appearance, Integrations, and Advanced. Terminal `/settings` groups the same controls into its own areas and lists the settings people change; every key still works in `settings.yaml`. The guided controls help you select a discovered model instead of typing a model ID. See [Connect a model](/docs/guide/configuration-and-targets.html) for the walkthrough.

## Know where a change is saved

| Layer | File or scope |
| --- | --- |
| User defaults | `settings.yaml` in CLIO Coder's configuration directory |
| Shared project settings | `.clio-coder/settings.yaml` |
| Local project settings | `.clio-coder/settings.local.yaml` |
| Active session | The session/project/global choices offered by supported terminal controls |

Find the resolved locations on your machine:

```sh
clio-coder paths --json
```

`safety.sandbox` (`auto`, `required`, `off`) and `safety.sandboxNetwork` control the OS sandbox for dispatched native workers' commands and for your own session's shell commands at `default`. Objects merge by key; arrays and scalars replace the lower layer. Credential-bearing keys in project settings are ignored. Project saves require trusted project settings.

Saved routes seed a new session. A settings write from another process does not redirect a conversation already running; use that session's model controls.

## Look up an exact key

The full reference covers supported settings keys, defaults, CLI flags, project file ownership, and MCP trust. Use **Read the full guide** above or ask CLIO Coder to retrieve the relevant bundled documentation before editing YAML.

Settings validation is strict. For an older installation, `clio-coder upgrade` applies the registered migration and preserves a version-1 backup. For connection and installation diagnostics, use [doctor](/docs/guide/doctor.html).

A session started in a repository subdirectory reads the repository's `.clio-coder/` settings, agents, skills, rules, hooks, and MCP servers. CLIO Coder writes an allow-list `.clio-coder/.gitignore`, so authored files can be committed while generated files stay out. A blanket `.clio-coder/` rule in your own `.gitignore` still hides them.

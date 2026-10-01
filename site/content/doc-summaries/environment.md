## Use settings for ordinary preferences

Choose models, permissions, output style, and context behavior in [Settings](/docs/guide/configuration-and-targets.html). Environment variables are useful when a script, container, or separate installation needs a different directory or an existing credential.

## Locate or separate installation state

```sh
clio-coder paths --json
```

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_HOME` | Set a shared root for Clio's directories |
| `CLIO_CODER_CONFIG_DIR` | Override the configuration directory |
| `CLIO_CODER_DATA_DIR` | Override the data directory |
| `CLIO_CODER_STATE_DIR` | Override the state directory |
| `CLIO_CODER_CACHE_DIR` | Override the cache directory |
| `CLIO_CODER_BIN_DIR` | Choose where the installer puts the `clio-coder` launcher (default `~/.local/bin`) |
| `CLIO_CODER_NODE_VERSION` | Choose the Node.js version the installer installs |

Individual directory overrides take precedence over the shared root. Separate state is useful for an isolated evaluation or a dedicated automation environment.

## Credentials and terminal behavior

Supported providers can read their conventional credential variables, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`, when that provider is selected. Prefer Clio's managed authentication flow for normal interactive setup, and keep secrets out of project settings and transcripts.

`VISUAL` and `EDITOR` select an external editor, with `VISUAL` taking precedence. Terminal variables such as `TERM` and `COLORTERM` describe the environment; they do not grant tool permissions.

The full guide lists provider-specific inputs, behavior overrides, and diagnostic switches. Use it when preparing automation or collecting a trace; most installations need no environment variables.

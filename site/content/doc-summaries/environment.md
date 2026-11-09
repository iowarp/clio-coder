## Use settings for ordinary preferences

Choose models, permissions, output style, and context behavior in [Settings](/docs/guide/configuration-and-targets.html). Environment variables are useful when a script, container, or separate installation needs a different directory or an existing credential.

## Locate or separate installation state

```sh
clio-coder paths --json
```

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_HOME` | Set a shared root for Clio Coder's directories |
| `CLIO_CODER_CONFIG_DIR` | Override the configuration directory |
| `CLIO_CODER_DATA_DIR` | Override the data directory |
| `CLIO_CODER_STATE_DIR` | Override the state directory |
| `CLIO_CODER_CACHE_DIR` | Override the cache directory |
| `CLIO_CODER_BIN_DIR` | Choose where the installer puts the `clio-coder` launcher (default `~/.local/bin`) |
| `CLIO_CODER_NODE_VERSION` | Choose the Node.js version the installer installs |

Individual directory overrides take precedence over the shared root. Separate state is useful for an isolated evaluation or a dedicated automation environment.

## How each directory is resolved

Clio Coder resolves the config, data, state, and cache directories one at a time. The first match wins:

| Order | Source | Example |
| --- | --- | --- |
| 1 | The per-role variable | `CLIO_CODER_CONFIG_DIR` |
| 2 | The shared root | `CLIO_CODER_HOME` |
| 3 | Platform defaults | `XDG_CONFIG_HOME` on Linux, `APPDATA` or `LOCALAPPDATA` on Windows |

So you can keep everything under one root and still move only the cache elsewhere:

```sh
export CLIO_CODER_HOME="$HOME/clio-eval"
export CLIO_CODER_CACHE_DIR=/scratch/clio-cache
clio-coder paths --json
```

`clio-coder paths` creates nothing, so it is a safe way to confirm a layout before the first run. Scripts should parse its `--json` output rather than repeat these rules. With `CLIO_CODER_HOME` set, the installer root defaults to `$CLIO_CODER_HOME/install`; `CLIO_CODER_INSTALL_DIR` overrides it.

An isolated root still reads other coding agents' user skills and prompts from your real home. Set `CLIO_CODER_INTEROP_HOME=none` to read none of them, or a path to read another home.

## Credentials and terminal behavior

Supported providers can read their conventional credential variables, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`, when that provider is selected. Prefer Clio Coder's managed authentication flow for normal interactive setup, and keep secrets out of project settings and transcripts.

| Variable | Used for |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GEMINI_API_KEY` | Gemini |
| `AWS_*` | Bedrock credentials |
| `OLLAMA_API_KEY` | An Ollama target at `https://ollama.com` |

Google Vertex uses its application credentials. The managed alternative is `clio-coder auth`, with `auth login` and `auth status` per target.

`VISUAL` and `EDITOR` select an external editor, with `VISUAL` taking precedence. Terminal variables such as `TERM` and `COLORTERM` describe the environment; they do not grant tool permissions.

## Collect a trace

Debug toggles are off by default and turn on with `1`. `CLIO_CODER_TRACE_BOOT=1` turns on a boot-phase timing trace for a slow startup. The render trace takes a file path instead, and records timing but no conversation text:

```sh
CLIO_CODER_RENDER_TRACE="$PWD/render.jsonl" clio-coder
```

Setting it to `1` writes a file named `1` in the working directory.

The full guide lists provider-specific inputs, behavior overrides, and diagnostic switches. Use it when preparing automation or collecting a trace; most installations need no environment variables.

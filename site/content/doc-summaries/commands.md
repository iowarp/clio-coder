## Launch and inspect

| Command | Use it to |
| --- | --- |
| `clio-coder` | Open the terminal in your project |
| `clio-coder gui --open` | Open the local desktop alpha |
| `clio-coder configure` | Connect a model with Guided setup |
| `clio-coder doctor` | Check installation and connections |
| `clio-coder --help` | See installed commands |

For a single task without the interactive interface:

```sh
clio-coder run "Explain this project's test setup. Do not change files." --cwd /path/to/project
```

Add `--json` when you need machine-readable events. A request to avoid edits is task guidance; use the tool restrictions in the full guide when execution must be constrained.

## Everyday terminal commands

| Command | What it opens or does |
| --- | --- |
| `/help` | Commands and effective keybindings |
| `/model` | Model picker; apply to this session or save for the project or globally |
| `/settings` | Settings, grouped by area |
| `/library` | Skills, prompts, agents, fleets, and plugins |
| `/context` | Context usage and pending handoffs |
| `/usage` | Session usage and supported subscription quotas |
| `/resume` | Previous conversations |
| `/tree` | Conversation history and branches |
| `/new` | A fresh conversation |
| `/view` | Artifacts and recorded results |

## A few keys to remember

**Ctrl+G** opens the action menu. Choose an entry with arrows and Enter, or its displayed suffix; Esc closes it. This is useful when your terminal intercepts an Alt shortcut. `/help` shows any custom bindings.

| Default key | Action |
| --- | --- |
| Enter | Send; while running, steer at the next available slot |
| Ctrl+J | Insert a newline |
| Ctrl+Q | Queue a message for the end of the active turn |
| Alt+Q | Recover queued messages into the draft |
| Alt+M | Open the model picker |
| Alt+L | Open the Library |
| Alt+O | Cycle the output detail level |
| Alt+W | Open Workers |

Ctrl+C closes an active overlay, cancels a running turn, or clears an idle draft. When idle with an empty draft and no queued messages, two presses within about 1.2 seconds exit.

For a course correction, type it in the composer and press **Ctrl+G i** (Interrupt with draft), or use `/interrupt <text>`. Work already completed remains in the session record.

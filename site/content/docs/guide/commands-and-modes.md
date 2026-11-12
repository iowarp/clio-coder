# Commands and shortcuts

Navigate the terminal, choose models, and control a session.

## Launch and inspect

| Command | Use it to |
| --- | --- |
| `clio-coder` | Open the terminal in your project |
| `clio-coder gui --open` | Open the local desktop alpha |
| `clio-coder configure` | Connect a model with Guided setup |
| `clio-coder doctor` | Check installation and connections |
| `clio-coder upgrade` | Update CLIO Coder |
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
| `/config` | Connections in Settings; **Add a target** runs setup inside the session |
| `/library` | Skills, prompts, agents, playbooks, and plugins |
| `/context` | Context usage and pending handoffs |
| `/usage` | Session usage and supported subscription quotas |
| `/rewind` | Preview and restore this session's file snapshots |
| `/rename [name]` | Name the session so `/resume` can find it |
| `/fork [name]` | Fork from an assistant turn into a new session, optionally named |
| `/loop <interval> <task>` | Run a task as a fresh turn on a schedule while the session is idle |
| `/reload` | Reload settings, Library resources, and extension runtimes |
| `/restart` | Save the session and restart into it |
| `/resume` | Previous conversations; `/resume <id>` reopens one directly |
| `/tree` | Conversation history and branches |
| `/new` | A fresh conversation |
| `/view` | Artifacts and recorded results |

## A few keys to remember

Alt+letter runs a CLIO Coder action, and **Ctrl+G** then the same letter runs it in any terminal, including ones that intercept Alt. The menu also lists a few actions with no Alt key; arrows and Enter work too, and Esc closes it. On an empty composer, `?` shows the keys; `/help` shows every binding, custom ones included.

| Default key | Action |
| --- | --- |
| Enter | Send; while running, queue the message for the next pause between tool calls |
| Ctrl+J | Insert a newline |
| Alt+S | Send now: interrupt the run and submit the draft |
| Alt+Q | Open the queue to reorder, edit, or remove waiting messages; `a` puts them all back in the draft |
| Alt+M | Open the model picker |
| Alt+L | Open the Library |
| Alt+O | Cycle the output detail level |
| Alt+W | Open Workers: the Fleet Runs board, or the workers dock in a session with panes |

Ctrl+C closes an active overlay, cancels a running turn, or clears an idle draft. When idle with an empty draft and no queued messages, two presses within about 1.2 seconds exit.

For a course correction, type it in the composer and press **Alt+S** (or **Ctrl+G s**). Work already completed remains in the session record. In the queue, `t` moves a message to the end of the turn.

A clean exit prints a summary of the session and the `/resume <id>` line that reopens it. Sessions are resumed from inside the app, not with a command-line flag.

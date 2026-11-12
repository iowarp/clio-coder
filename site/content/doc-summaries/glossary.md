## Words you meet first

Each term below in a sentence or two, with the guide that explains it. The full guide then gives the precise definitions, mapped to the source types that own them.

## Sessions and models

| Term | What it means |
| --- | --- |
| Session | One conversation with CLIO Coder in a project. It is saved, so you can resume it later. See [Commands and modes](/docs/guide/commands-and-modes.html). |
| Target (connection) | A place CLIO Coder sends prompts to: a provider account or a local model server, with its default model. Settings call it a connection. See [Configuration and targets](/docs/guide/configuration-and-targets.html). |
| Chat route | The target and model your main conversation uses right now. |
| Compaction | Shortening a long conversation into a summary so it fits the model's context window. See [Context continuity](/docs/guide/context-continuity.html). |
| Handbook | `CLIO-CODER.md` at the repository root: the project's name, conventions and rules, written by you and kept in Git. |
| Memory | Notes CLIO Coder keeps while you work, such as your requirements and what failed, so it can remind the agent later. See [Proactive memory](/docs/guide/proactive-memory.html). |
| Doctor | `clio-coder doctor`, a read-only check of your install, connections and sandbox. See [Doctor](/docs/guide/doctor.html). |

## Safety

| Term | What it means |
| --- | --- |
| Autonomy level | How much CLIO Coder may do without you: `default` asks when something is risky, `yolo` never waits for you. See [Sandbox and safety](/docs/guide/sandbox-and-safety.html). |
| Sandbox | An operating-system wall around shell commands. Inside it a command can write only to the project and scratch folders and cannot read your credentials. |
| Contained | A command that runs inside the sandbox. At `default` most contained work runs without asking. |
| Safety judge | A model that checks a risky call against what you asked for, before you are asked. It allows it, refuses it, or passes it to you. |
| Approval card | The question CLIO Coder shows when a call needs your answer. One nobody answers is denied after a timeout. |
| Snapshot | A private copy of your files that CLIO Coder takes before it changes them. `/rewind` restores one. |

## Workers and results

| Term | What it means |
| --- | --- |
| Worker | A separate agent that does one task for the main session, often on its own branch. See [Fleet dispatch](/docs/guide/fleet-dispatch.html). |
| Fleet | The workers available to you and the routes they run on. |
| Dispatch | Handing a task to a worker, with `/run` in a session or `clio-coder run --agent` from a shell. |
| Worktree | A separate checkout of your repository on its own branch, where a worker can change files without touching yours. |
| Run record | The sealed record of a finished worker run: what it did, what it changed and which checks passed. `/view verify <runId>` checks it. |
| Check (verifier) | A command in `.clio-coder/verifiers.yaml` that decides whether work is right, such as a test suite or a benchmark. |
| Peer | Another coding agent, such as Claude Code, Codex or OpenCode, that CLIO Coder hands a task to. See [Coding agent interoperability](/docs/guide/interop.html). |
| Store | A place outside your working tree for result files and datasets, shared by every checkout of the project. See [Store](/docs/guide/store.html). |
| Research campaign | A loop where the agent tries one change at a time and keeps it only when a measured number improves and every check still passes. See [Research and arena](/docs/guide/research-and-arena.html). |
| Arena match | The same task given to several models, each result run through the same check, so you can compare them and vote blind. |
| Sweep | A set of run directories for one experiment, each checked on its own. See [Slurm](/docs/guide/slurm.html). |

## Packages

| Term | What it means |
| --- | --- |
| Skill | Written instructions for a procedure, in a `SKILL.md` file, that the agent loads when the task needs it. |
| Prompt template | A saved prompt you run as a slash command, such as `/bugfix`. |
| Library | The installable packages CLIO Coder knows about, browsed with `/library`. See [Library packages](/docs/guide/resource-library.html). |
| Plugin | A package of content only: skills, prompts, agents and playbooks. Installing one never runs code. See [Plugins](/docs/guide/plugins.html). |
| Extension | A package of code that changes CLIO Coder itself. It runs in its own process, after you review what it may do. See [Extensions](/docs/guide/harness-extensions.html). |

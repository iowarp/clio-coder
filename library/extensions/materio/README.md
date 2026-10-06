# Materio extension

The Materio extension adds a materials research lab bench to Clio Coder's
terminal app. It reads the project's `.research/` files to draw a phase strip,
task board, agent and findings islands, composer rail and footer, and refreshes
them after research edits. Local commands inspect state, review task artifacts,
manage checkpoints and report provider token counts and declared cost.

This directory is an independent API 2 extension. Its manifest is
`clio-coder-extension.yaml`, and it carries its runtime, skin and Python helpers.
It serves `plugin: materio`; the [Materio plugin](../../plugins/materio/README.md)
is a separate content package containing skills, prompts, agents and a playbook.
Each package has its own digest, install state and lifecycle. Installing the
extension alone does not install the plugin or register its research prompts.

## Install and enter the lab

Install `extension:materio` from Clio's Library and review the extension's
declared permissions. In a terminal, use:

```bash
clio-coder library install extension:materio --user
```

Use `/reload` in an existing session, then `/ext:materio:lab` or the host
workspace menu to enter the lab. Leave with the host leader's `b` or
`/workspace off`. With the lab active, Ctrl+G introduces its free leader keys:

| Key | Action |
| --- | --- |
| `f` | Offer the next research action for operator review. |
| `c` | Save a research checkpoint. |
| `v` | Review task findings. |
| `d` | Show reported tokens and declared cost. |
| `h` | Show lab help. |

The extension's commands always have their own names:

- `/ext:materio:status [task]` inspects research state or opens findings review;
  `status check N` rechecks the selected task's artifacts.
- `/ext:materio:progress` shows task progress and the next step.
- `/ext:materio:help` shows available controls and plugin requirements.
- `/ext:materio:checkpoint save [label]|list|restore <archive>` manages local
  snapshots. Restore asks for confirmation and saves current state first.
- `/ext:materio:cost` shows usage by research step. Unknown pricing stays unknown.

Install `plugin:materio` separately to add the research workflow. While that
plugin is installed, enabled and in effect, the extension can serve its
`/materio:status`, `/materio:progress`, `/materio:help` and `/materio:checkpoint`
prompts locally. The other research prompts invoke the model and can use the
extension's tools. If the plugin or an individual prompt is unavailable, the
extension explains the requirement and keeps its local commands available.
The paper handoff requires the separate WTF-P plugin to be installed and enabled.

## Permissions and capability envelope

The install review covers the capability envelope declared in the manifest:

- Filesystem read access to the workspace (`.`), and write access to `.research`.
- Subprocess execution for the included Python helpers; Python 3.10+ is required,
  and shell syntax checking uses Bash.
- No declared network access. Citation checks run offline.
- Prompt and tool-argument content access. Dispatch arguments associate a run
  with its exact task write root; an ambiguous run is not assigned by guess.
- Session state and persistent extension store for researcher forms, run
  associations and usage tracking.
- The four tools `interview`, `record_decision`, `set_task_status` and
  `complete_task`; local commands; research-file watches; declared lifecycle
  events; a `before_tool` dispatch hook; status, band, card, toast and interview
  UI; and the lab workspace and skin.

Clio runs the extension in its own process with Node permission flags and the
available OS confinement. The extension review displays the actual confinement
on the current host. Node's permission model reduces accidental access; it does
not contain hostile code by itself. An envelope change requires fresh consent.
The served plugin's identity and active prompt names are read-only snapshot facts
and grant no additional capabilities.

## Research forms and guardrails

The `interview` tool collects and confirms research identity, virtual lab,
workflow and data registration inputs. Confirmed research identity publication
initializes missing `.research/STATE.md`, configuration and directories. Workers
return candidate questions or draft documents; the researcher owns publication
and approval. The plugin prompts provide the model's workflow for these forms.

Task tools validate transitions and dependencies, preserve existing decisions,
and read back writes. `record_decision` requires existing research state and
explains how to initialize it when missing. Completion requires a summary
readback and researcher acceptance of current guardrails. Missing summaries or
changed artifacts keep a task at checkpoint until it is checked and reviewed.

The runtime runs conservative physics, script syntax and offline citation
helpers. Findings are advisory; prepared artifacts do not establish executed
experiments or validated scientific results. The runtime never executes the
generated experiment or analysis program. The `autoCheckpoint` option defaults
to `true` and saves a snapshot after accepted task review and readback. Optional
named-file Git recording follows the project's `commit_research` setting.

## Package checks

From a Clio checkout with a current build and an isolated temporary directory:

```bash
clio-coder extensions test library/extensions/materio
```

The package tests exercise local state, forms, artifact review, checkpoints,
usage accounting and plugin-aware command guidance. They use local fixtures
without model traffic. They do not establish live scientific research results.

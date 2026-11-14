CLIO Coder works in the repository you open. For your first session, give it a small, concrete task: explain how the project builds and runs its tests. That lets you see how it reads code and uses tools before asking it to make a change.

::: note Version scope
This tutorial describes v0.8.0. The recordings on this page come from a small JavaScript project with one failing test and Qwen 3.8 27B on a local model server. The first starts with no model configured. The install step was not recorded.
:::

## 1. Install CLIO Coder

The installer brings its own Node.js and needs no root. Linux, macOS, and WSL are the primary platforms. Native Windows is best effort, so use the current stable release. On Linux, the installer offers to add the desktop app when it finishes.

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

## 2. Connect a model

Open a terminal in a repository you know and start CLIO Coder:

```sh
cd /path/to/your/project
clio-coder
```

With no model configured, setup starts on its own:

```text
No model target is configured. Clio needs a model before it can do anything else, so setup starts now.
```

Setup looks for a provider key in your environment, a stored sign-in and a local model server, and lists what it found. Pick one, or choose **Set up something else** and answer what you have: an API key, a subscription, a model server or gateway, or a setup file from your lab or team. Use a model that supports tool calling.

CLIO Coder sends the model one short test request and saves only when it answers; a browser sign-in you complete is the exception. In the recording, setup found a model server and saved it:

```text
◇  Testing litellm / qwen3.8-27b ... answered in 0.4 s.
◇  target litellm saved, runtime litellm
◇  chat runs on litellm, model qwen3.8-27b
◇  fleet default is litellm
◇  settings written to ~/.config/clio-coder/settings.yaml
◇  Saved. Chat and workers use this model. Change it any time with /model or /config.
```

`clio-coder configure` runs setup again at any time. Its **Connect by endpoint** is the shortcut when you already know the URL. LM Studio commonly serves at `http://localhost:1234`; Ollama commonly serves at `http://localhost:11434`. The [connection guide](/docs/guide/configuration-and-targets.html) covers setup and credentials.

If you have used CLIO Coder before, you can skip this step. A chat route you already chose stays in use, and CLIO Coder will not swap it for another when it stops working.

If a connection fails, run:

```sh
clio-coder doctor
```

## 3. Open a workspace

When setup saves, the terminal workspace opens in the same folder. In the recording, its header read `Model      litellm · qwen3.8-27b` and the status line ended `200K ctx`, the context window of the model it found. Later, `clio-coder` opens the workspace directly.

Or open the desktop alpha in your browser:

```sh
clio-coder gui --open
```

In the desktop, open a workspace folder and start a task. If you have not configured a model, **Guided setup** is also available in the browser; terminal configuration is optional. For this tutorial, either interface gives you a place to enter the first request.

## 4. Ask a focused question

Try this request:

> Explain how this repository builds and runs its tests. Identify the main entry points and suggest one verification task. Do not change files yet.

Follow the tool activity as CLIO Coder reads the repository. The recording ends while it plans its first reads. If an approval card appears, read the call before allowing it. If the answer misses an important directory or build system, name it in a follow-up.

## 5. Make the next task specific

Once you understand the project, ask for one change you can check. Name the problem, what to do and how to verify it. The recording below gave this request for the project's one failing test:

> The absolute-zero test fails. Find the cause, fix it, and run the test check.

::: capture cast-first-task
:::

The agent changed `kelvin <= 0` to `kelvin < 0` in `temperature.mjs`, ran the declared test check (`checked test · exit 0`), and ended its report with `All 7 tests pass now, measured with the test check.`

Use your project's real test name. Read the diff and the check output yourself before you commit the change.

## Keep going

In the terminal, `/help` lists commands, `/model` selects a model, `/settings` opens the settings center, and `/config` opens your connections, where **Add a target** runs setup again without leaving the session.

When you quit, CLIO Coder prints a summary of the session and a `/resume <id>` line. Start `clio-coder` again and type that line to return to the conversation, or use `/resume` alone to pick from a list.

The [commands guide](/docs/guide/commands-and-modes.html) covers shortcuts and session controls. The [tools guide](/docs/guide/tool-usage.html) explains the repository tools and their permissions.

::: next
- [Let CLIO Coder work without watching every call](/tutorials/let-it-work-with-containment-and-rewind.html)
- [A numerical change, checked with CLIO Coder](/tutorials/temperature-calibration.html)
- [Commands and modes](/docs/guide/commands-and-modes.html)
:::

CLIO Coder works in the repository you open. For your first session, give it a small, concrete task: explain how the project builds and runs its tests. That lets you see how it reads code and uses tools before asking it to make a change.

## 1. Install CLIO Coder

The installer brings its own Node.js and needs no root. Linux, macOS, and WSL are the primary platforms. Native Windows is best effort, so use the current stable release. On Linux, the installer offers to add the desktop app when it finishes.

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

Open a terminal in a repository you know:

```sh
cd /path/to/your/project
clio-coder configure
```

## 2. Connect a model

Choose **Guided setup** and answer what you have: an API key, a subscription, a model server or gateway, or a setup file from your lab or team. CLIO Coder sends the model one short test request and saves when it answers. Use a model that supports tool calling.

**Connect by endpoint** is the shortcut when you already know the URL. LM Studio commonly serves at `http://localhost:1234`; Ollama commonly serves at `http://localhost:11434`. The [connection guide](/docs/guide/configuration-and-targets.html) covers setup and credentials.

If you have used CLIO Coder before, you can skip this step. A chat route you already chose stays in use, and CLIO Coder will not swap it for another when it stops working.

With no route chosen, starting `clio-coder` looks for a saved connection, a provider key in your environment, a stored sign-in, or a local model server. A new installation lists what it found in setup. Otherwise it opens chat with the first one that has a model, and it uses a local model server only after you say yes.

If a connection fails, run:

```sh
clio-coder doctor
```

## 3. Open a workspace

Launch the terminal workspace:

```sh
clio-coder
```

Or open the desktop alpha in your browser:

```sh
clio-coder gui --open
```

In the desktop, open a workspace folder and start a task. If you have not configured a model, **Guided setup** is also available in the browser; terminal configuration is optional. For this tutorial, either interface gives you a place to enter the first request.

## 4. Ask a focused question

Try this request:

> Explain how this repository builds and runs its tests. Identify the main entry points and suggest one verification task. Do not change files yet.

Follow the tool activity as CLIO Coder reads the repository. Review any permission request before allowing it. If the answer misses an important directory or build system, name it in a follow-up.

## 5. Make the next task specific

Once you understand the project, ask for a check you recognize:

> Run the existing parser tests and report the results. Do not edit files.

Use your project's real test name. Read the command and its output before deciding on a change. If you later ask CLIO Coder to edit code, inspect the diff and rerun the relevant checks.

## Keep going

In the terminal, `/help` lists commands, `/model` selects a model, `/settings` opens the settings center, and `/config` opens your connections, where **Add a target** runs setup again without leaving the session.

When you quit, CLIO Coder prints a summary of the session and a `/resume <id>` line. Start `clio-coder` again and type that line to return to the conversation, or use `/resume` alone to pick from a list.

The [commands guide](/docs/guide/commands-and-modes.html) covers shortcuts and session controls. The [tools guide](/docs/guide/tool-usage.html) explains the repository tools and their permissions.

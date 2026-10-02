Clio Coder has two interfaces to the same runtime. The terminal offers the primary workflow. The desktop alpha opens locally in your browser and gives you a visual workspace for projects and conversations.

## Clio Coder in the terminal

Open your repository and launch Clio:

```sh
cd /path/to/your/project
clio-coder
```

![Clio Coder terminal at start, with the project, its Git state, the selected model, and the composer](/assets/tui-boot.webp)

The terminal combines the conversation, tool calls, permissions, and worker activity. Type `/help` to see available commands, or `/model` to choose a model.

![Clio Coder in the terminal running a declared test check through verify, then showing the reference temperatures from the test file as a table](/assets/tui-verify.webp)

Each tool call stays on its own line with its result, so you can see what ran before you read the answer. `/view` opens the recorded calls and their output.

During a turn, **Enter** steers the current work, **Ctrl+Q** queues a follow-up, and **Escape** cancels the run. Review a permission card before allowing an action. **Deny** skips that call; **Stop** ends the turn.

## Clio Coder on the desktop

From a terminal, run:

```sh
clio-coder gui --open
```

The command opens the local application with its access link. Open a workspace folder, describe a task, and choose a model and thinking level from the composer. The rail on the left groups tasks by workspace, and the Progress pane keeps the plan, changed files, and context beside the conversation.

Before Clio runs a command or edits a file, it asks. The approval names the call, what allowing it authorizes, and what it can affect. A first run with no model connection opens on guided setup, which asks the same questions as `clio-coder configure`.

::: capture gui-home gui-task gui-approval gui-setup
The desktop from a new task to a finished one: the composer, the answer with its tool calls, a parked approval, and guided setup.
:::

The desktop is in alpha and covers a subset of terminal workflows. Treat it as an optional way to use Clio, and keep the terminal available for commands that the desktop does not yet expose.

On Linux with a systemd user session, you can install the optional background application:

```sh
clio-coder gui background install --open
```

For an optional Linux desktop entry, run `clio-coder gui launcher install`. The background service and launcher each have an `uninstall` command. The <a href="<!-- source-blob -->/docs/guide/commands-and-modes.md#graphical-application">full command guide</a> covers those options.

## Choose where to begin

Start in the terminal if you work mostly from a shell or need the primary set of Clio workflows. Start on the desktop if you prefer browsing projects and working with attachments in a visual interface.

Both launch commands use the installed Clio Coder package. You do not need an account on this website. Your model connections use your own local server, institutional endpoint, or cloud provider.

Try [a temperature-calibration example with recorded checks](/tutorials/temperature-calibration.html), or follow [your first session](/tutorials/first-session.html) for a concrete task to try in either workspace.

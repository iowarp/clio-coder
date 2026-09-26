Clio Coder has two interfaces to the same runtime. The terminal offers the primary workflow. The desktop alpha opens locally in your browser and gives you a visual workspace for projects and conversations.

## Clio Coder on the desktop

From a terminal, run:

```sh
clio-coder gui --open
```

The command opens the local application with its access link. Select a project, start a conversation, and choose a model. You can attach files and inspect session activity from the workspace.

![Clio Coder desktop conversation with file attachments, session controls, and model selection](/assets/gui-conversation.webp)

The desktop is in alpha and covers a subset of terminal workflows. Treat it as an optional way to use Clio, and keep the terminal available for commands that the desktop does not yet expose.

On Linux with a systemd user session, you can install the optional background application:

```sh
clio-coder gui background install --open
```

See the [installation guide](/docs.html) for background service, launcher, and uninstall options.

## Clio Coder in the terminal

Open your repository and launch Clio:

```sh
cd /path/to/your/project
clio-coder
```

![Clio Coder terminal workspace with the model connection, composer, and keyboard shortcuts](/assets/tui-boot.webp)

The terminal combines the conversation, tool calls, permissions, and worker activity. Type `/help` to see available commands, or `/model` to choose a model.

During a turn, **Enter** steers the current work, **Ctrl+Q** queues a follow-up, and **Escape** interrupts. Review a permission card before allowing an action. **Deny** skips that call; **Stop** ends the turn.

## Choose where to begin

Start on the desktop if you prefer browsing projects and working with attachments in a visual interface. Start in the terminal if you work mostly from a shell or need the primary set of Clio workflows.

Both launch commands use the installed Clio Coder package. You do not need an account on this website. Your model connections use your own local server, institutional endpoint, or cloud provider.

Follow [your first session](/tutorials/first-session.html) for a concrete task to try in either workspace.

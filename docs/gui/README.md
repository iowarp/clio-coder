# GUI reference

Clio Coder includes a graphical application as an opt-in alpha for power users. The
terminal is the primary interface, and nothing here is needed to use it. The
application runs only when you start it with one of the commands below; the CLI,
the TUI and `clio-coder acp` work the same whether or not it is used. `clio-coder gui`
is listed under `clio-coder --help --all` rather than in the default help, and the
installer does not mention it.

## Commands

| Command | What it does |
| --- | --- |
| `clio-coder docs [topic]` | Opens the shipped documentation in your browser. A loopback server starts in the background, so the terminal is free, and later calls reuse it. |
| `clio-coder docs --stop` | Stops that server and removes its record. |
| `clio-coder docs --foreground` | Serves privately in the terminal until Ctrl+C. It never adopts the background app or the shared server. |
| `clio-coder gui [--open]` | Serves the whole application in the terminal until Ctrl+C. |
| `clio-coder gui background install\|status\|start\|open\|stop\|uninstall` | Runs the application as a login service. Linux with a systemd user session only. |
| `clio-coder gui launcher install\|status\|uninstall` | Adds a desktop entry that starts the application on demand. Linux only. |

Every server binds `127.0.0.1` and requires a private launch token. The documentation
server stops on `--stop` or after 15 minutes without an open page. Its record and log
are private files under `<state>/gui/`, and `clio-coder docs` refuses to signal a
process it cannot show is its own server. Foreground `docs` and `gui` run on Linux
and macOS, and the browser opens automatically on those two; on Windows, open the
printed link. `clio-coder uninstall` stops and removes an installed background
service and desktop entry before it deletes Clio Coder state.

## Changing the model

The route beside **Send** opens target, model and thinking. Saving writes your user
settings, so the choice reaches this conversation's next request and every new
conversation, the CLI and the TUI; the picker says so before its button. A model
for one conversation alone is not available yet.

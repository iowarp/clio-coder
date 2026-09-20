# GUI reference

Clio Coder ships a graphical application as an early preview. It is a companion to
the terminal agent, and it does not claim production parity. This page is the
operator guide for starting it. The recovered design and parity documents that
back its implementation follow.

## Launching the application

The default build bundles the application. These commands start and manage it.

| Command | What it does |
| --- | --- |
| `clio-coder docs [topic]` | Opens the shipped documentation in your browser. A loopback server starts in the background, so the terminal is free, and later calls reuse it. |
| `clio-coder docs --stop` | Stops that server and removes its record. |
| `clio-coder docs --foreground` | Serves privately in the terminal until Ctrl+C. It never adopts the background app or the shared server. |
| `clio-coder gui [--open]` | Serves the whole application in the terminal until Ctrl+C. |
| `clio-coder gui background install\|status\|start\|open\|stop\|uninstall` | Runs the application as a login service. Linux with a systemd user session only. |

The documentation server binds `127.0.0.1` and requires a private launch token. It
stops on `--stop` or after 15 minutes without an open page, because an open page
holds it through its event stream. Its record and log are private files under
`<state>/gui/`, and `clio-coder docs` refuses to signal a process it cannot show is
its own server. Where the operating system exposes process start times (Linux)
that check needs no answer from the server. On macOS and Windows a server that
does not answer cannot be proven ours, so it is left running and its record is
cleared. Foreground `docs` and `gui` run on Linux and macOS, and the browser opens
automatically on those two. On Windows, open the printed link. Background
installation and the desktop launcher need Linux with systemd.

## Sidebar navigation

The desktop sidebar lists every destination. **Collapse sidebar** at its top, or `Ctrl`
or `Cmd` plus `\`, shrinks it to an icon rail, and **Expand sidebar** restores it.
Each icon keeps its name for assistive technology and shows it as a tooltip on hover
and on keyboard focus, and the active destination stays marked. The choice is
remembered per browser. The mobile navigation drawer is unchanged, and the command
palette (`Ctrl` or `Cmd` plus `K`) offers the same toggle.

## Design and parity documents

Working documents for `apps/clio-coder-gui`. Every file here was recovered from the
retired `apps/workbench` reference application before it was deleted, and re-verified
against the current `src/` where the original had gone stale.

| Document | What it is |
| --- | --- |
| [`parity/01-cli-surface.md`](parity/01-cli-surface.md) | Command-line surface parity, 32 rows |
| [`parity/02-slash-and-surfaces.md`](parity/02-slash-and-surfaces.md) | Slash-command families and interactive surfaces, 63 rows |
| [`parity/03-domains-and-plan.md`](parity/03-domains-and-plan.md) | Runtime domain roster and the ordered implementation plan |
| [`settings-write-surface.md`](settings-write-surface.md) | The settings coverage table, ported to schema v2. Gates what the GUI may write |
| [`event-bus-coverage.md`](event-bus-coverage.md) | Canonical event families and which cross the ACP boundary |
| [`workflow-coverage.md`](workflow-coverage.md) | Human workflow coverage, 33 rows |
| [`cli-surface-routing.md`](cli-surface-routing.md) | Every registered command and where it is routed in the GUI |
| [`boundary-doctrine.md`](boundary-doctrine.md) | Why the parity verdicts land where they do |
| [`delivery-order.md`](delivery-order.md) | Delivery sequence and the work that cannot be done inside the GUI |
| [`performance-baseline.md`](performance-baseline.md) | Measured rendering evidence and the v0.5.0 regression budgets |
| [`inspector-presentation.md`](inspector-presentation.md) | What the retired inspectors showed and in what order |
| [`chat-rendering-spec.md`](chat-rendering-spec.md) | The conversation view and inspector blueprint, 17 artifacts with destination paths |

The settings table is the load-bearing one. It records that the workbench's original
table named 27 v1 keys that schema v2 retired, and that `SETTING_CONTROLS` in
`src/core/settings-controls.ts` already machine-generates the leaf registry, so the
GUI derives its form from the schema rather than transcribing paths by hand.

The chat specification is the implementation blueprint for the conversation view.
It carries the turn-grouping model, the per-tool-kind card taxonomy, diff and
approval rendering, and the closed label vocabularies the inspectors need, each
artifact addressed to the file it belongs in.

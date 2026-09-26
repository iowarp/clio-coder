# Clio Coder graphical application

The alpha browser interface for Clio Coder. It provides project and conversation
views, attachments, session boards, context controls, fleet previews, traces,
evidence, library access, and configuration. A local Node service connects these
views to the shared runtime through ACP.

See [the documentation map](../../docs/README.md) for operator guides and
[`DESIGN.md`](DESIGN.md) for the application's design and authority boundaries.

## Running it

```sh
clio-coder gui --open       # reuse the owned background app or start a private server
```

Bare `gui` reuses this installation's owned background application when present.
Otherwise it serves privately until Ctrl+C. `gui --foreground` explicitly selects
the private server.

`clio-coder gui background …` and `clio-coder gui launcher …` add a login service
and a desktop entry on Linux with a systemd user session. Each is installed only on
request and removed by its own `uninstall` or by `clio-coder uninstall`.

## Inspecting work and configuration

Traces keeps search and source/status filters in the URL. Open a recorded run,
select a phase in its waterfall, and inspect its events, checks, and accounting.
Unknown prices remain unavailable. A session trace has no worker receipt unless
work was actually dispatched.

Fleet shows installation-wide execution and dispatch history. Open a worker to
inspect its recorded output, then follow its associated Evidence or trace link
when available. Evidence can select a recent dispatch, collect its bundle for a
chosen workspace, and show receipt integrity, observed validation, and review as
separate checks.

Library supports searching available and installed resources and inspecting a
package before staging a lifecycle plan. Review its destinations, dependencies,
refused steps, and effects on dependents before applying the exact plan. Canceling
releases the staged source. Browsing does not install packages or run verifiers.

Settings search links each supported control to its effective value and sources.
Drafts are applied explicitly to the user layer; workspace and command-line
overrides remain visible. Toolchain distinguishes PATH resolution from Clio's
vendored copy, and removing that copy leaves a PATH installation intact. System
groups health findings and offers an explicit fresh version probe.

Help opens [the public documentation](https://coder.iowarp.ai/docs.html) and shows
the installed Markdown reference path. `Control+/` opens Help. The documentation
command and native reader have been removed; the bundled reference and offline
`clio_docs` retrieval remain available.

## How it stays separate

- **Its own process.** The CLI loads the application only inside the `gui` command
  and inside `uninstall` when a GUI service or launcher is
  installed, so ordinary commands, the TUI and help/version load none of it.
  The application drives Clio Coder through ACP children and fixed CLI commands; it
  is not a second implementation of the runtime.
- **Local and authenticated.** The server binds `127.0.0.1` and requires a random
  256-bit token, carried in the launch link's fragment and then as a bearer token.
  Host and Origin are checked, static files are contained, and a content security
  policy forbids remote scripts, fonts and connections.
- **Session and saved settings have distinct scopes.** The model picker can select
  the next request's model and thinking level for the current conversation. Saving
  a default uses the runtime settings-control path and applies to every project.

## Developing

From the repository root, `pnpm run build` builds the CLI and bundles this app into
`dist/gui/`. For client work, run the server and Vite in two terminals:

```sh
pnpm --filter @iowarp/clio-coder-gui dev:server   # API on 4317
pnpm --filter @iowarp/clio-coder-gui dev:client   # Vite on 4318; open the printed link on 4318
pnpm --filter @iowarp/clio-coder-gui start --fixture   # a disposable Clio home with fabricated tools
```

## Verifying

Run these from this folder. The browser smoke needs Chrome at
`/usr/bin/google-chrome` (or `--chrome=<path>`); build a private client for it,
because the root test lane rebuilds `dist/client`.

```sh
pnpm run typecheck && npx biome check . && pnpm run test:full && pnpm run build
node scripts/check-contrast.mjs
npx vite build --outDir <scratch>/client --emptyOutDir
pnpm run smoke:browser --client <scratch>/client/   # 1600, 1050, 390 and 320 px with Axe
pnpm run visual --client <scratch>/client/ --out <scratch>/shots --route   # review screenshots
pnpm run perf --client <scratch>/client/ --out <scratch>/perf             # streaming measurements
```

`test:acp-real` drives the built CLI against a local model fixture, and `test:pwa`
checks the installable background app; both need more of the machine and are run
separately.

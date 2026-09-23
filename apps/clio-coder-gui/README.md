# Clio Coder graphical application

An alpha browser front end for Clio Coder, for power users. The terminal is the
primary interface. This application is opt-in: nothing starts it unless you run one
of the commands below, and the CLI, the TUI and `clio-coder acp` behave the same
whether or not it is used. The operator guide is
[`docs/gui/README.md`](../../docs/gui/README.md); [`DESIGN.md`](DESIGN.md) is the
design authority for this folder.

## Running it

```sh
clio-coder gui [--open]      # the whole application, served in this terminal until Ctrl+C
clio-coder docs [topic]      # the shipped documentation in your browser
```

`clio-coder gui background …` and `clio-coder gui launcher …` add a login service
and a desktop entry on Linux with a systemd user session. Each is installed only on
request and removed by its own `uninstall` or by `clio-coder uninstall`.

## How it stays separate

- **Its own process.** The CLI loads the application only inside the `gui` and
  `docs` commands, and inside `uninstall` when a GUI service or launcher is
  installed, so ordinary commands, the TUI and help/version load none of it.
  The application drives Clio Coder through ACP children and fixed CLI commands; it
  is not a second implementation of the runtime.
- **Local and authenticated.** The server binds `127.0.0.1` and requires a random
  256-bit token, carried in the launch link's fragment and then as a bearer token.
  Host and Origin are checked, static files are contained, and a content security
  policy forbids remote scripts, fonts and connections.
- **Saved settings are the runtime's.** The model picker beside Send and the Settings
  page write your user settings through the runtime's own safe-settings and
  settings-control paths, and say "Saved for every project" before they do.

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
pnpm run smoke:browser --client <scratch>/client/   # 1600, 1050 and 390 px with Axe
pnpm run visual --client <scratch>/client/ --out <scratch>/shots --route   # review screenshots
pnpm run perf --client <scratch>/client/ --out <scratch>/perf             # streaming measurements
```

`test:acp-real` drives the built CLI against a local model fixture, and `test:pwa`
checks the installable background app; both need more of the machine and are run
separately.

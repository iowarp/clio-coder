# Clio Coder web

The checkout application exposes Clio through a browser or installed local PWA.
It includes toolchain management, sessions, traces, documentation, settings and
routing inspection, target operations, fleet history, evidence, evals and usage,
library discovery, interop and system health. These views use typed REST APIs
and event streams backed by Clio's existing runtime seams and fixed CLI commands.
The CLI, TUI, and ACP continue to run independently. The packaged `clio-coder web`
command belongs to R1.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @iowarp/clio-coder-web build
pnpm --filter @iowarp/clio-coder-web start
```

Open the full loopback URL printed by the server, then choose **Toolchain** or
**Traces**, or choose **Sessions** to open a workspace by absolute path, start a
conversation, or load a saved session. Up to four sessions can be open at once.
Permission cards offer one-time allow or reject. Unanswered cards escalate after
45 seconds and cancel the turn after 10 minutes. Session controls include cancel,
labels, safe settings, autonomy, target probes, and confirmed deletion of closed
sessions; fleet activity and evidence-ready facts stream alongside the conversation. Trace history includes server-side filters and pagination, run details,
phase timelines, event payloads, gates, processes, receipts, and live tails. Trace
reads use your configured Clio state directory; a missing database shows an empty
state. Receipt summaries omit large payload fields until you request the full receipt.
`--port 4317` selects a port; the default is an ephemeral port. Ctrl+C or SIGTERM
closes the listener and both domain workers. Starting without a client build
prints the build command and exits with failure.

To try the complete installation flow without touching your Clio installation:

```sh
pnpm --filter @iowarp/clio-coder-web start --fixture
```

Fixture mode creates a fresh temporary Clio home, clears PATH in the workers,
and substitutes a fabricated Herdr binary and license. Install Herdr, watch the
progress, and remove its vendored copy. Yazi and Croc remain visible, but fixture
mode refuses their downloads. The temporary home is removed on graceful shutdown.

For client development, run these in two terminals after the first build:

```sh
pnpm --filter @iowarp/clio-coder-web dev:server
pnpm --filter @iowarp/clio-coder-web dev:client
```

The server uses port 4317 and Vite uses port 4318. Open the printed launch link
with its port changed to 4318, retaining the token fragment. The Vite proxy
rewrites its own development Origin to the backend Origin; unrelated origins
remain subject to the backend's rejection.

```sh
pnpm --filter @iowarp/clio-coder-web verify
pnpm --filter @iowarp/clio-coder-web openapi
pnpm run test:web
```

`verify` checks server and browser TypeScript, root Biome rules, the app's Node
tests, the Vite build, and the Chrome/Axe browser smoke. Tests prohibit uninjected fetches and use isolated
homes. OpenAPI generation uses the same route table as the handlers and typed
client; tests reject semantic drift in the checked-in JSON.

`pnpm --filter @iowarp/clio-coder-web smoke:browser` uses Chrome at
`/usr/bin/google-chrome`; pass `--chrome=/absolute/path` to override it. The smoke
runs against isolated app/ACP fixtures at 1600, 1050, and 390 px, blocks external
requests, checks accessibility and page overflow, and writes its report and
screenshots to a temporary directory outside the checkout, printed in the report
(`TMPDIR` controls its parent). It requires a current client build. The application
has light/dark themes, a keyboard-accessible mobile navigation dialog, and a
shared safe Markdown, code, and diagram renderer; [DESIGN.md](DESIGN.md) records
the retained rules. Fonts are served locally.

The server binds only `127.0.0.1`. A random 256-bit token is printed in the URL
fragment, moved into the tab's session storage, and removed from the address bar.
API requests require bearer authentication; EventSource uses the same token in
its query because it cannot set an Authorization header. Host and Origin are
checked; static files have realpath containment and a content security policy.
Choose **Docs** for the shipped reference tree and local search. Markdown page
links stay inside the app; blueprints are available when `docs/html/` exists in
the package (normally a source checkout). Blueprint pages run in a sandboxed
origin and cannot read the app token. The documentation index refreshes on server
restart. Unavailable source references are shown as text with an explanation.

Choose **Settings** to inspect a workspace’s effective settings and their origin
layers, or **Why** to inspect customization sources, trust, precedence, and reload
behavior. These pages are read-only. Credential/environment values and executable
argument vectors are hidden; source issues are summarized without raw contents.

Chat Markdown is rendered as React elements: raw HTML stays text, images are not
fetched, and only HTTP, HTTPS, and mailto links are active. Prism produces token
trees; strict Mermaid output is sanitized before SVG mounting. The CSP permits
inline styles for those diagrams while scripts, connections, and fonts remain
same-origin.
The toolchain adapter admits only registry download/document URLs before calling
its fetcher; upstream redirects follow the root installer's download behavior,
and the domain verifies all asset and document checksums. Process creation enters
`server/process-policy.ts`; source imports enter the explicit Clio shims and
worker-only adapters. These are code-level controls; the S9 permission-mode experiment is recorded below.

Operations and idempotency keys live for this server epoch. Completed snapshots
are retained in completion order up to 256 records and 16 MiB, while active operations are retained.
An evicted operation's key still maps to its original id, preventing a duplicate
mutation within the epoch; its snapshot returns 404. Progress is bounded to 256
entries and 64 KiB. Installs and removals have no cancel control because the
underlying domain APIs cannot interrupt their synchronous work. Worker deadlines
return an unavailable problem without pretending that synchronous work stopped.

SSE retains at most 4,096 envelopes and 8 MiB, supports cursor replay and resync,
and closes a slow connection after its queued bytes exceed a full replay plus a
512 KiB live burst. The S1 client refetches operation snapshots on progress and
uses revisions to keep a late response from replacing a newer terminal record.
Session deltas use a shared revision buffer so a late snapshot cannot duplicate
or erase newer streamed text. Text items are bounded to 64 KiB, the visible
timeline to 2 MiB / 2,048 items, and turn summaries to 128. Permissions retain 32
cards and fleet activity 128 facts; pending client deltas share the 8 MiB / 4,096
entry bound. The server retains 16 closed session snapshots plus active sessions.

Recent workspaces and child ownership records live under `<state>/web/`.
On restart, only a recorded ACP child with a matching birth token and a proven
dead owner can be terminated. Other live servers sharing the state directory
retain their children. Reconciliation never edits Clio session ledgers.

`pnpm --filter @iowarp/clio-coder-web test:acp-real` drives the built CLI against
a local OpenAI-compatible fixture in a scratch home. It includes durable session
load/replay and records real child RSS/boot measurements. It is separate from the
network-disabled default test lane.

See [SPRINT.md](SPRINT.md) for canonical status,
[the S1 implementation handoff](notes/2026-09-11-S1.md) for acceptance evidence,
and [the S1 closeout](notes/2026-09-11-S1-closeout.md) for the approved CI checker
update and final verification. [S2 evidence](notes/2026-09-11-S2.md) records trace
coverage and browser checks. [S3 evidence](notes/2026-09-11-S3.md) records session
and process-lifecycle verification. [S4 evidence](notes/2026-09-11-S4.md) records
permission/control verification and measured reconnect behavior. [S5 evidence](notes/2026-09-11-S5.md)
records renderer, design, and browser accessibility verification. [S6 evidence](notes/2026-09-11-S6.md)
records documentation, link and blueprint checks. [S7a evidence](notes/2026-09-11-S7a.md)
records layered settings, customization, redaction and worker-deadline checks.
S1-S7b provide sessions, trace and documentation browsing, settings inspection,
and target operations. Target listing and offline models/profiles/bindings are
workspace REST reads. Target probe, use, and removal return operation IDs;
use/removal run Clio's canonical commands and return typed follow-up reads.
Probes are cancellable and check all configured endpoints, matching the CLI.
Adding targets remains a CLI configuration task because the current CLI has no
non-interactive JSON add contract. CLI children use fixed arguments, a four-child
limit, 60-second deadlines, and 8 MiB stdout / 256 KiB stderr limits. Stderr never
crosses the REST boundary. Finished-operation events omit snapshots larger than
256 KiB; clients retrieve those through the operation REST endpoint.

Fleet history is available at `/fleet` and `/api/fleet/`. Fleet roots and dispatch
runs use cursor pagination; individual runs and full receipts have direct read
endpoints. Council and gate views retain Clio's canonical bounded windows and
report truncation. Reads run in the domain worker, enforce artifact containment,
and reject an oversized dispatch ledger rather than reporting empty history.

Evidence reports are available at `/evidence` and `/api/evidence`, with cursor
pagination and a detail endpoint for findings, canonical trust axes, admitted
provenance and authenticated gate decisions. Historical reports without a trust
file report `unknown`; an intact receipt alone never means the work was validated.
`POST /api/workspaces/:id/evidence/:runId/build` collects a run's evidence through
Clio, then reads the artifact from the store. `POST
/api/workspaces/:id/receipts/:runId/verify` rechecks the original receipt and
returns its canonical `pending`, `verified`, `failed` or `unavailable` result in
an operation. Both require an idempotency key and an empty JSON object. A completed
verification command can report failed integrity. A failed evidence build may
still have written a report containing integrity findings; refresh before retrying.
Evidence reads enforce containment and 8 MiB per file, with a 10,000-directory /
64 MiB overview inventory ceiling. They never parse the build command's prose.

Evaluation history is at `/evals` and `/api/evals`, with cursor pagination and
`/api/evals/:id` for trial outcomes, measurements and stored verdicts. The worker
uses `listEvalReports` and `loadEvalArtifactV4`; it reaches beyond the CLI's eight
report summary window. Unreadable or retired files are counted, and absent token
measurements remain absent. Transcript attachments are counted without exposing
their contents. Inventory limits are 10,000 files / 64 MiB total / 8 MiB per file.

`/usage` reads `GET /api/workspaces/:id/usage` through the fixed
`usage report --repo <canonical-workspace> --days 30 --json` command. Its actual
JSON Lines stream is decoded strictly under the runner's existing output bounds.
The API retains every fact and suggestion, labels the source schema experimental,
and distinguishes missing stores and unknown usage from measured zero. Clio
filters sessions and dispatches to the workspace; audit, evidence and memory
facts retain the CLI's installation-wide scope. Refreshing either view executes
no evaluations or suggested actions.

The workspace library is at `/library`. REST reads under
`/api/workspaces/:id/library` expose canonical packages, installed copies, recipe
resources, and discovery diagnostics. `/extensions` uses the existing installed
extension reader; `/agents` bridges `agents --json` to preserve resolved specs;
`/verifiers` bridges `verifiers inspect --json` because its discovery composes
protected tool code. Viewing these collections runs no checks, extension commands,
installs or removals. The library retains canonical truncation flags (512 packages,
256 copies, 1,024 resources); verifier inspection retains its 64-check window.

System inspection is available at `/system` and `GET /api/system`: canonical
`runDoctor({fix: false})` findings and the four resolved Clio folders. Failed
settings/credential parser text is withheld because it may quote secret values;
the finding and its status remain visible. The endpoint offers no repair method.
`GET /api/meta` also reports Node, platform and the three Pi package versions.

`/system/interop` reads `GET /api/workspaces/:id/interop`. Every registered kind
is represented, including absent or unknown executables and resource-only
conventions. Canonical discovery reads declared resource/configuration metadata,
never foreign sessions or history. Version probes run only `--version`, bounded
by the runtime to two seconds and 4 KiB per executable; resource walks retain the
runtime's 4,096-file, depth-12 and 2 MiB/file limits and diagnostics. The API does
not accept/decline agents or launch their work commands.

The checkout server supports `--open`, `--idle-exit <milliseconds>`, `--port <0–65535>`,
`--token <32–256 URL-safe characters>`, and `--log-file <path>`. Without `--token`, each
launch generates a fresh 256-bit token. The authenticated URL is printed once;
the optional private, append-only lifecycle log excludes it and request content.
Existing log files must belong to the current user, have one link, and be regular
files; symlinks are refused. Parent directories must already exist.

`--idle-exit` is disabled by default. When enabled, all active HTTP responses,
including global and resource SSE streams, keep the process alive. The last
response closing starts the idle window. Turns (including permission waits),
operations, CLI jobs, session setup/cleanup, and pending worker calls also keep
it alive. Once these settle, a full idle window precedes shutdown and reaping of
owned children. A disconnected browser does not cancel work. `--open` uses the
OS browser opener with a single loopback URL argument; failure leaves the printed
URL usable. Automatic browser opening is implemented for Linux and macOS;
Windows currently requires opening the printed URL.

From the checkout, install a Linux application entry with:

```sh
pnpm --filter @iowarp/clio-coder-web start launcher install
pnpm --filter @iowarp/clio-coder-web start launcher status
pnpm --filter @iowarp/clio-coder-web start launcher uninstall
```

Each command accepts `--prefix <absolute XDG data directory>` for an isolated
installation. The default is `$XDG_DATA_HOME` or `~/.local/share`. The entry is
`applications/io.iowarp.ClioCoder.desktop`, paired with a private
`io.iowarp.ClioCoder.desktop.owner.json` manifest containing version, owner,
content checksum, and absolute launch paths. It starts the checkout's Node,
tsx loader, and server with `--open --idle-exit 60000`, independent of the working
directory. `status` distinguishes absent, installed, unavailable launch targets,
and conflicting ownership. Uninstall removes only the verified pair, including
when the checkout has moved; modified or unowned files are preserved. Install
is idempotent for identical content and refuses replacement until the owned
entry is uninstalled. macOS and Windows desktop installation explicitly refuse.
This source launcher requires the client build; packaged command integration is R1.

The HTTP process and reads worker deny ambient `fetch`. The ops worker captures
one downloader before installing that guard and passes it only to the pinned
toolchain adapter. The test lane replaces ambient fetch before startup, so even
that capability cannot use a real network during tests. Boundary tests reject
direct socket imports except the fixed, authenticated loopback readiness request,
and process creation outside the declared module. These
controls govern the app; canonical CLI/ACP children retain the runtime's target,
provider, and tool networking. Node's permission model does not supply a network
allowlist or a complete sandbox for these children and native modules.

E8 was measured on the exact Node 22.19.0 baseline and Node 24.20.0. Node 22 lacks
`--permission-audit`; Node 24 supports it through diagnostics channels. The audit
covered startup, system/tool reads, and a fabricated tool install: reads of the
checkout/dependencies, scratch Clio roots and tsx cache, `/proc/<pid>/stat`, and a
`/tsconfig.json` existence probe; writes within scratch state/data/cache; worker
and inspector probes from tsx. No real download was involved. Enforce mode passed
those calls on both versions with `--permission --allow-child-process --allow-worker`,
read grants for the checkout, scratch root and `/proc`, and a write grant for the
scratch root. The experiment exposed Node 22 worker loader inheritance: source
workers now explicitly register tsx before importing TypeScript. Plain baseline
startup and both worker calls pass as well. Permission flags are not a launcher
default: these measured roots do not cover arbitrary workspaces selected later,
and a valid directory outside those grants was explicitly refused with HTTP 422. Bundled-mode policy verification belongs to S10/R1. Logs and the exact access
set are recorded outside the checkout in `/var/tmp/clio-web-verification/E8-*`.

The Linux desktop check used WSLg/Weston and Chrome 152 with an isolated XDG
application registry and browser profile. GLib listed the entry as visible and
activated its absolute command from `/`; the authenticated app connected and
closing the page stopped the server after **60,163 ms** on the monotonic clock.
Status and uninstall then reported absent, preserving unrelated files. This
exercises native application activation; a physical GNOME/KDE menu click was not
performed on this Weston environment. Repeat the desktop check after R1 changes
the launcher target to the installed command.

The installable PWA uses an explicitly enabled **background service** on Linux
with a running systemd user session. Set it up after building the checkout:

```sh
pnpm --filter @iowarp/clio-coder-web start background install --open
pnpm --filter @iowarp/clio-coder-web start background status
```

The first command starts Clio, enables it for subsequent logins, installs its
native application entry, and opens the authenticated browser. Choose **Install
Clio Coder** in the page footer or your browser’s install command. The installed
app uses the same interface and REST APIs as browser tabs. Closing a window leaves
the background server available. Systemd restarts it after an unexpected failure.
It runs during your user session; it does not enable lingering or a machine-wide
service, and normal CLI, TUI and headless invocations remain independent.

The default address is `http://127.0.0.1:4317`. Installation accepts `--port`,
`--directory <absolute private directory>` and `--prefix <absolute XDG data directory>`.
The default private directory is `<Clio state>/web/background`. Repeated installation
preserves the existing origin and credential. A busy port fails explicitly;
it never silently moves an installed app to another address. The configuration
pins the four Clio folders, package root, Node/loader/entry paths and PATH.
It does not copy provider credentials or other environment secrets. Configure
provider credentials through Clio’s normal credential store; shell-only environment
variables are not imported into the user service manager by this installer.

The private configuration contains a random 256-bit token and requires owner-only
permissions. Neither the systemd unit, journal startup message, status output,
manifest nor public assets contains the token. Successful authentication to a
background endpoint remembers the token in this browser profile’s origin-scoped
storage, so new installed windows and a restarted browser can reconnect.
**Forget this browser** clears that access in its open windows without stopping
Clio or deleting work. Reopen the native Clio desktop entry to connect again.
Use a trusted browser profile; clearing site data also forgets the connection.

The service worker caches only a public recovery page, its stylesheet and script,
and an icon. It never caches API responses, conversations or authentication,
and never queues commands. When Clio is temporarily unavailable, reopening the
installed app shows a calm reconnect screen that retries automatically. An app
window cannot launch a stopped Node process; this was the limitation measured
by the original E5 experiment and is why persistent availability is now supplied
by the explicitly installed user service.

```sh
pnpm --filter @iowarp/clio-coder-web start background open
pnpm --filter @iowarp/clio-coder-web start background stop
pnpm --filter @iowarp/clio-coder-web start background start
pnpm --filter @iowarp/clio-coder-web start background uninstall
```

`open` starts the owned service if needed and opens its authenticated URL. `stop`
leaves it enabled for the next login. `uninstall` disables and stops it, removes
only its verified configuration/unit/desktop files, and preserves Clio projects,
conversations and unrelated files. Remove the browser’s installed icon using its
own uninstall command. Modified or unowned installation files are preserved with
an explicit error. The on-demand and background launchers use the same native
entry; uninstall the owned old launch mode before installing the other one.
The source setup must be reinstalled if its checkout or Node installation moves.
Packaged installation and lifecycle checks belong to R1.

PWA assets are exposed only in background mode; foreground launch retains its
per-launch token and optional idle shutdown. Native background setup is currently
Linux/systemd only. Chrome on Linux is the verified installation target; this
slice does not claim macOS/Windows service installation or a remotely hosted,
shared-user deployment.

`pnpm --filter @iowarp/clio-coder-web test:pwa` is an explicit native acceptance
lane, separate from deterministic `verify`. It requires a graphical Chrome and
systemd user session, uses private temporary Clio/browser/XDG directories and a
uniquely named service, then uninstalls both the service and PWA. `CHROME_PATH`
selects the browser executable and `TMPDIR` selects the artifact directory.
It checks manifest installability, standalone windows, persistent authentication,
server crash/restart, offline recovery and its cache contents, browser restart,
forgetting access across windows, and ownership-safe removal.

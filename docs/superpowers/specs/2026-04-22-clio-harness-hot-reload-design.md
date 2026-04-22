# Clio Harness Hot-Reload — Design

- **Status:** Brainstorming complete. Awaiting user review before the writing-plans phase.
- **Date:** 2026-04-22
- **Author:** akougkas + Claude (Opus 4.7)
- **Branch target:** `feat/harness-hot-reload` from `main` @ `5300d82`
- **Scope gate:** v0. Tools-only hot-swap. All other source changes classify as restart.

## 1. Problem

Clio is a long-running TUI coding-agent. Its distribution path is `dist/cli/index.js` linked via `npm link`. The intended workflow is "build Clio with Clio": run a persistent `clio` session and edit `src/**` from inside it. Today every edit requires `Ctrl+D` to exit, `npm run build`, `clio` to relaunch, and context loss across the chat transcript.

## 2. Goal

A running `clio` session detects every edit under `src/**` and either:

1. **Hot-swaps** the change live when it affects only tool implementations (`src/tools/*.ts` minus `registry.ts`, `bootstrap.ts`, `truncate-utf8.ts`).
2. **Prompts the user to restart** when the change is structurally incompatible with hot-swap. A footer indicator flips to `restart-required` naming the file and reason. Pressing `R` runs the existing four-phase shutdown, respawns `clio` with the current session id in `CLIO_RESUME_SESSION_ID`, and resumes the chat on the new boot.
3. **Ignores** tests, docs, dist, node_modules, markdown under src, and unrelated files.

Workers are handled separately: a change under `src/worker/**` takes effect on the next dispatch (which already spawns a fresh subprocess). The footer indicator surfaces that state, not a restart demand.

## 3. Hard constraints

1. The three invariants in `CLAUDE.md` §3 stay intact. Boundary checker in `tests/boundaries/check-boundaries.ts` must pass after every change.
2. No new runtime dependency unless justified. This design adds `esbuild` as an explicit dep (already transitive via `tsup`) and nothing else.
3. Feature is gated behind `CLIO_SELF_DEV=1`. Default `clio` runs from `dist/` and never touches `src/`.
4. Workers remain OS-isolated subprocesses. Worker code changes never crash the orchestrator.
5. Session state survives the restart path via `session.resume(sessionId)` wired through a new `CLIO_RESUME_SESSION_ID` env contract.

## 4. Classification matrix

Every path under the repo lands in exactly one of four classes. This matrix is the ground truth; the `src/harness/classifier.ts` implementation is its executable form.

| Path pattern | Class | Reason |
|---|---|---|
| `src/tools/*.ts` except `registry.ts`, `bootstrap.ts`, `truncate-utf8.ts` | **hot** | Each tool is a self-contained object with a closed-over `run()`. `ToolRegistry.register(spec)` mutates a `Map`. `chat-loop` reads `listVisible()` each turn, so a re-registered spec takes effect on the next tool invocation. |
| `src/tools/{registry,bootstrap,truncate-utf8}.ts` | restart | Registry shape / bootstrap composition / cross-tool utility. |
| `src/engine/**` | restart | Engine boundary. Re-importing pi-mono classes mid-run is ill-defined. |
| `src/core/**` | restart | Boot foundation (termination, xdg, config, shared-bus, domain-loader). Held in module-scope singletons. |
| `src/domains/**` | restart | Extensions wire `SafeEventBus` subscriptions without tracked unsubscribe handles. Manifests drive topological order. Contracts are compiled types used across domains. |
| `src/worker/**` | **worker-next-dispatch** | Next spawned worker uses the new code. Orchestrator unaffected. Footer shows informational state only. |
| `src/entry/orchestrator.ts` | restart | Boot composition root. |
| `src/cli/**` | restart | argv parsed at boot; the running process holds the pre-change parse. |
| `src/interactive/**` | restart | Statically imported from `interactive/index.ts`; no indirection in v0. |
| `tests/**`, `docs/**`, any `*.md`, any `*.mdx` | ignore | No runtime impact. |
| `package.json`, `package-lock.json`, `tsconfig*.json`, `tsup.config.ts`, `biome.json`, `.gitignore`, `.github/**` | restart | Build graph, CI, or dep shift. |
| `dist/**`, `node_modules/**`, `.git/**`, anything outside `src/` and root config | ignore | Not source-of-truth. |
| Anything under `src/harness/**` | restart | Changing hot-reload code while hot-reload is active is a footgun. Prompt a restart. |

Note: `src/domains/providers/**` deserves the `restart` class specifically because it carries `EndpointDescriptor`, which the worker also consumes. The generic `src/domains/**` rule handles it correctly; no special case needed.

## 5. Module layout

A new top-level subsystem under `src/harness/`:

```
src/harness/
  watcher.ts        fs.watch(src/, { recursive: true }) + debounce, emits FileChangeEvent
  classifier.ts     pure function (path) => { class, reason }
  hot-compile.ts    esbuild.transform({ loader: "ts", format: "esm" }) → write to cache dir
  tool-reloader.ts  given a src/tools/*.ts path: compile, dynamic-import, call registry.register
  restart.ts        detached respawn + CLIO_RESUME_SESSION_ID + trigger 4-phase shutdown
  state.ts          footer indicator state machine + last-event details
  index.ts          public surface: startHarness(deps): HarnessHandle
```

### Boundary rules for src/harness/**

- May import from `src/core/*` (bus, xdg, config, termination, shared types).
- May import the concrete `ToolRegistry` interface from `src/tools/registry.ts` (contract-only, not `bootstrap.ts`).
- May import from `node:*` freely.
- May NOT import from `src/engine/**` (no pi-mono).
- May NOT import from `src/domains/**` (no cross-domain reach).
- May NOT import from `src/interactive/**` or `src/worker/**`.
- Consumers wire the harness from `src/entry/orchestrator.ts`; the harness exposes only its `startHarness(deps)` factory and a small handle type.

The boundary checker gains a new rule specific to `src/harness/**` to enforce this.

## 6. Runtime behavior

### 6.1 Boot path

In `src/cli/clio.ts` (or `src/entry/orchestrator.ts`), after `loadDomains`, before `startInteractive`:

```ts
if (process.env.CLIO_SELF_DEV === "1") {
  const repoRoot = resolveRepoRoot();  // walks up from import.meta.url to find package.json
  if (!existsSync(join(repoRoot, "src"))) {
    process.stderr.write("clio: CLIO_SELF_DEV=1 requires a dev checkout with src/; continuing without hot-reload.\n");
  } else {
    const handle = await startHarness({
      repoRoot,
      toolRegistry,
      bus,
      session,
      termination,
    });
    termination.onDrain(() => handle.stop());
  }
}
```

Also: after `loadDomains`, if `process.env.CLIO_RESUME_SESSION_ID` is set and the `session` contract is available, call `session.resume(id)` once before entering the interactive loop. This is a cross-cutting benefit: it also makes `clio --resume` (added later) easy to wire.

### 6.2 Watcher

- `fs.watch(path.join(repoRoot, "src"), { recursive: true })` + `fs.watch` on root config files individually (`package.json` etc).
- Debounce 50ms per path. Editors write through a rename or multi-event sequence; debounce collapses.
- Ignore events whose path ends in `~`, `.swp`, or matches `4913` (vim atomic-write sentinel).
- Emit a `FileChangeEvent { path, kind: "change" | "rename" | "delete" }` to a local event-bus-like callback that the harness index subscribes.

### 6.3 Classifier

Pure function. No I/O. Input is the absolute path; output is `{ class: "hot" | "restart" | "worker-next-dispatch" | "ignore", reason: string }`. Unit-testable against the matrix in §4.

### 6.4 Hot-swap pipeline (tools only)

1. Classifier returns `hot` for `src/tools/read.ts`.
2. `hot-compile.ts` reads the file, runs `esbuild.transform(source, { loader: "ts", format: "esm", sourcefile: path })`, writes the JS to `$CLIO_CACHE_DIR/hot/tools/read-<shortHash>.mjs`.
3. `tool-reloader.ts` dynamic-imports the new file. The module's named exports follow a convention (every tool file exports exactly one `<name>Tool` object; see `src/tools/bootstrap.ts`).
4. The reloader resolves the spec object (by convention: look for a property whose name ends in `Tool` and whose value looks like a `ToolSpec`), normalizes with the `allowedModes` metadata from `bootstrap.ts` (preserved in-memory at boot), and calls `toolRegistry.register(spec)`.
5. State machine flips to `hot-reload-ready`, emits `HarnessHotreloadSucceeded { path, elapsedMs }`, footer shows `⚡ hot-reloaded tools/read.ts (14ms)` for 3s.
6. On compile/import failure, emit `HarnessHotreloadFailed { path, error }`, footer shows `⚠ hot-reload failed: <short error>`, keep the old spec live.

Cache-busting is automatic: each write uses a fresh filename (`<hash>` changes with content). Node's ESM loader treats each URL as a new module. Accepted leak: old module versions stay in memory until `clio` exits. A counter in `state.ts` tracks reload count; when it exceeds 100 we log a note suggesting a restart. v0 does not implement the experimental loader path.

### 6.5 Restart path

1. Classifier returns `restart`.
2. State machine flips to `restart-required`, emits `HarnessRestartRequired { paths: [changedPath], reason }`. Footer shows `⟳ restart required (src/domains/session/manifest.ts). press R`.
3. The interactive input handler in `src/interactive/index.ts` grows one new branch: when state is `restart-required` and `R` (or `r`) is pressed outside the editor focus, it calls `handle.restart()`.
4. `restart.ts` captures `session.current()?.id`, then:
   ```ts
   const child = spawn(process.execPath, process.argv.slice(1), {
     stdio: "inherit",
     detached: true,
     env: { ...process.env,
            ...(sessionId ? { CLIO_RESUME_SESSION_ID: sessionId } : {}),
            CLIO_SELF_DEV: "1" },
   });
   child.unref();
   emit HarnessRestartTriggered { sessionId };
   await termination.shutdown(0);
   ```
5. The parent's 4-phase shutdown runs. The child boots to the banner, picks up `CLIO_RESUME_SESSION_ID`, and calls `session.resume(id)` before entering the TUI. The terminal transfers to the child because `stdio: "inherit"` shares the same TTY file descriptors; when the parent exits, the child continues owning them.

### 6.6 Worker-next-dispatch path

1. Classifier returns `worker-next-dispatch`.
2. State machine sets a flag `workerReloadPending: Set<string>`. Footer shows `⟲ worker refresh on next dispatch (3 files)`.
3. No action beyond display. The next `dispatch()` spawns a fresh subprocess from `dist/worker/entry.js` (or the dev-mode equivalent); the new code is picked up transparently.

Note: when workers spawn from `dist/`, they use the pre-change compiled worker. For worker changes to actually take effect in dev mode, `spawnWorker` must be redirected to `tsx src/worker/entry.ts`. That redirect is its own scope; for this PR the footer indicator is informational and the reload is nominal. If the user runs `npm run build` in the background, the next dispatch picks up the new code. A follow-up PR can wire `CLIO_SELF_DEV` to use a tsx-shimmed worker entry.

## 7. Event-bus contract

Add to `src/core/bus-events.ts`:

```ts
HarnessWatcherStarted:     "harness.watcher.started",
HarnessFileChanged:        "harness.file.changed",
HarnessHotreloadSucceeded: "harness.hotreload.succeeded",
HarnessHotreloadFailed:    "harness.hotreload.failed",
HarnessRestartRequired:    "harness.restart.required",
HarnessRestartTriggered:   "harness.restart.triggered",
```

Payloads:

- `HarnessWatcherStarted { root: string }`
- `HarnessFileChanged { path: string, class: "hot" | "restart" | "worker-next-dispatch" | "ignore" }`
- `HarnessHotreloadSucceeded { path: string, elapsedMs: number }`
- `HarnessHotreloadFailed { path: string, error: string }`
- `HarnessRestartRequired { paths: string[], reason: string }`
- `HarnessRestartTriggered { sessionId: string | null }`

Workers do not receive these events; they are orchestrator-internal.

## 8. UX

### 8.1 Footer indicator

`src/interactive/footer-panel.ts` gains a `harness?: HarnessFooterState` prop:

```ts
type HarnessFooterState =
  | { kind: "idle" }
  | { kind: "hot-ready"; message: string; until: number }        // e.g. "⚡ read.ts (14ms)"
  | { kind: "hot-failed"; message: string; until: number }       // "⚠ write.ts: syntax error at line 42"
  | { kind: "restart-required"; files: string[] }                // "⟳ restart required (2 files). press R"
  | { kind: "worker-pending"; count: number }                    // "⟲ worker refresh on next dispatch (3 files)"
```

Transient states (`hot-ready`, `hot-failed`) auto-clear after 3s to `idle`. Persistent states (`restart-required`, `worker-pending`) stay until a new event supersedes them. The indicator occupies a single new line below the existing footer content when non-idle.

### 8.2 Restart keystroke

Added to `src/interactive/index.ts` input routing:

- When the harness state is `restart-required` **and** the editor is not focused / not capturing (no input in progress), a bare `R` or `r` calls `harness.restart()`.
- Escape does nothing (state persists). The user can also edit more files; each change merges into the `restart-required` file list.
- If the editor has focus and user types `r`, it goes to the editor normally. The restart keystroke only fires when the chat editor is empty or unfocused. Explicit unfocus: briefing shows users already have `Ctrl+D` to quit, so this is a safe low-effort gesture.

### 8.3 Banner message

When `CLIO_SELF_DEV=1` is active, the boot banner gets one extra line:

```
  ◆ clio  IOWarp orchestrator coding-agent
  v0.1.0-dev · pi-mono 0.68.1 · ready
  CLIO_SELF_DEV=1 · hot-reload on src/tools/*.ts · watching src/
```

## 9. Error handling

- **Watcher startup fails** (e.g. recursive watch unsupported): log a warning, skip hot-reload, boot continues normally.
- **Compile error in a tool file**: caught by esbuild, surfaced as `hot-failed`, old tool stays active. Do not crash the session.
- **Import error after compile**: same — `hot-failed`, old spec stays. Exceptions caught in the reloader.
- **`session.current()` returns null at restart time**: spawn child without `CLIO_RESUME_SESSION_ID`; the child boots fresh. Log a warning to stderr.
- **`spawn` fails**: emit `HarnessHotreloadFailed`-equivalent, stay in `restart-required`. Do not call `termination.shutdown()`.
- **Running from `dist/` accidentally with `CLIO_SELF_DEV=1`**: the pre-start check (`existsSync(repoRoot/src)`) guards this. Otherwise log a stderr note and skip.

## 10. Testing

Three layers, matching the existing test discipline in `.claude/skills/clio-testing/SKILL.md`.

### 10.1 Unit — `tests/unit/harness-*.test.ts`

- `classifier.test.ts`: one assertion per row of the matrix in §4. Feed absolute and relative paths; assert `{ class, reason }`. Edge cases: `.md` inside `src/tools/`, files directly under `src/`, paths outside the repo.
- `state.test.ts`: state-machine transitions (idle → hot-ready → idle after 3s; idle → restart-required → restart-required+more-files; idle → worker-pending → idle when cleared).
- `restart.test.ts`: construct the spawn argument list without actually spawning; assert env carries `CLIO_RESUME_SESSION_ID` and argv carries the saved slice. Mock `child_process.spawn` with a stub.

### 10.2 Integration — `tests/integration/harness-hotreload.test.ts`

- Set up a scratch XDG home (via `src/core/xdg.ts` reset pattern).
- Create a minimal tool spec source at `$TMP/src/tools/fake.ts`.
- Construct a `ToolRegistry`, mount the harness, edit the fake tool to change its output, assert that within 500ms the registry's `get("fake")` returns a spec whose `run()` produces the new output.
- Exercise the compile-fail path: write an invalid TS source, assert `HarnessHotreloadFailed` is emitted and the old spec stays.

### 10.3 E2e — `tests/e2e/self-dev.test.ts`

- Spawn `CLIO_SELF_DEV=1 clio` via `tests/harness/pty.ts` in a fixture directory that mirrors a minimal Clio source tree (or runs against the real tree but with a throwaway tool).
- Edit a real tool file (e.g. make `read.ts` prepend `[DEV]` to every output). Observe footer flipping through `hot-ready`.
- Edit `src/domains/session/manifest.ts` (a harmless noop edit). Observe footer flipping to `restart-required`.
- Send `R` keystroke. Observe the banner reappearing with the same session id surfaced in `/tree` or `/history`.
- Revert the test edits in `afterEach`.

No `scripts/diag-*.ts` — the briefing explicitly bans that pattern.

## 11. Open risks

1. **`fs.watch` recursive on some filesystems** (esp. overlayfs in containers). Mitigation: feature-detect at startup; if the watcher returns zero events after 1s on a known file touch, log a warning and degrade gracefully.
2. **TUI footer line clashes with pi-tui rendering budget**. Mitigation: the footer only adds a line when state ≠ idle; idle state renders the existing footer unchanged. Verify in the e2e pty buffer.
3. **esbuild dep pull**. esbuild is ~12MB on disk but already transitively present via `tsup`. Making it an explicit dep doesn't change install footprint meaningfully. Document in commit message.
4. **Restart loses in-flight dispatch**. The 4-phase shutdown already SIGTERMs workers with a 3s grace. Users pressing `R` mid-dispatch will see workers cancel. Same semantics as `Ctrl+D`. Acceptable for v0.
5. **Classifier drift**: if Clio adds a new top-level source directory (e.g. `src/utils/`), the classifier defaults to `restart`, which is the safe choice. Update the matrix + unit tests when that happens.

## 12. Out of scope for this PR

- Overlay / renderer / slash-command / chat-loop hot-swap. Requires indirection layers not yet built.
- Domain `extension.ts` hot-swap. Requires `SafeEventBus` unsubscribe tracking per-extension.
- `--experimental-vm-modules` loader path. Only if memory drift over a long session proves disruptive.
- Dev-mode worker spawn via `tsx src/worker/entry.ts`. The classifier already flags worker changes; upgrading the spawn path is a follow-up.
- `clio --resume <id>` CLI flag. The `CLIO_RESUME_SESSION_ID` env contract makes it trivial; out of scope for this PR.
- Windows parity. `fs.watch` recursive on Windows has historical quirks; users of `CLIO_SELF_DEV=1` are expected to be on Linux/macOS/WSL.

## 13. Success criterion

A fresh developer:

1. Runs `npm run build && npm link && CLIO_SELF_DEV=1 clio` in the Clio checkout.
2. Edits `src/tools/read.ts` to prepend `[DEV]` to the output.
3. Asks Clio to read a file. The result is prefixed `[DEV]` without any restart.
4. Edits `src/domains/session/manifest.ts` (even a comment).
5. Sees the footer flip to `⟳ restart required (src/domains/session/manifest.ts). press R`.
6. Presses `R`. The banner reappears.
7. Continues the chat. The session id matches; the prior transcript is present; `/tree` shows the same tree.

## 14. Decision log

| Decision | Chosen | Reason |
|---|---|---|
| Hot-swap scope | Tools only in v0 | Only surface with no indirection debt; ships foundation + immediate value. |
| Restart mechanism | Detached respawn (`child.unref()` + `stdio: "inherit"` + `termination.shutdown(0)`) | Cross-platform, no native deps, PID change is inconsequential. |
| Watcher | Native `fs.watch` recursive | Zero deps, Node 20 supports it on Linux/macOS. |
| TS→ESM | `esbuild.transform` to `$CLIO_CACHE_DIR/hot/` | Already transitive via tsup; per-write cache-bust filename is simpler than ESM loader hooks. |
| Module placement | New `src/harness/` top-level | Not engine, not core, not a domain. Own boundary rule. |
| Feature gate | `CLIO_SELF_DEV=1` **and** `src/` exists relative to bundle | Double-guard against accidental activation in production installs. |
| Session resume | New `CLIO_RESUME_SESSION_ID` env var read after `loadDomains` | Minimal wiring, reusable for a future `--resume` flag. |

## 15. Spec self-review

- **Placeholder scan**: no TBDs. Every section has concrete content.
- **Internal consistency**: §4 matrix matches §10.1 test plan. §5 module layout matches §6 pipeline steps. §6.5 restart flow matches §7 event payloads.
- **Scope check**: focused — one PR, one branch, one subsystem. Out-of-scope list (§12) names the follow-ups.
- **Ambiguity check**:
  - §6.4 step 4 "by convention: look for a property whose name ends in Tool" is a convention risk. Alternative: canonicalize by editing each tool file to export a fixed name (e.g. `export const tool`). Chosen: scan for `*Tool` name + shape check; if no match, log `hot-failed`. Documented here, implementer must add a test covering a tool file that doesn't expose a recognizable export.
  - §6.5 "R or r pressed outside the editor focus" — implementation defines "editor focus" via the existing `Editor.focused` predicate in `src/interactive/index.ts`. No new concept.

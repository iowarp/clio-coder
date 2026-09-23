# Conversation-first GUI handoff

Work stays inside `apps/clio-coder-gui`. Another agent changes the Clio runtime, CLI and TUI in the same working tree, so stage and commit only GUI paths and never touch their files. A GUI need that only the runtime can meet (a new ACP field or method) is written down here or filed as an issue, not patched into `src/`. The priority is the ordinary path: choose a project, open a conversation, pick a model, send a request, follow a live run, understand what the agent did, and stay in control. Inspector and administration pages stay reachable but secondary.

## Ethos

The operator's bar is the fluency of the Claude and Codex desktop apps: a full-width pane, one centred reading column, the operator's words in a quiet bubble, unboxed prose, activity folded to a muted line, and nothing on screen that is not information. Match that fluency without copying either app, and keep what makes Clio Coder its own:

- **Honest status and provenance.** Say what the runtime reported in the runtime's own terms. A refused call reads "not approved", not "you rejected this", because `src/tools/registry.ts:1277` words a denial, a cancelled turn and an abort alike. A group says "changed 1 file" only for a change that completed without an error. A model list says where it came from and when. Never invent a value, a rate, a default or an author.
- **Meaning survives greyscale.** Every status is a glyph and a word; colour only supports them.
- **Keyboard and screen reader parity.** A visually hidden label is still announced; hover-revealed actions also appear on focus and on touch; a control that unmounts hands focus back to the one that opened it.
- **Choices come from the source.** Anything the runtime can enumerate (targets, models, levels, modes) is a select fed by the runtime, with an explicit escape for an exact value; free text is for things only the operator knows.
- **Draft safety and the local boundary.** The composer never loses a draft; the server stays authenticated and local.
- **DESIGN.md is the authority.** Change the code and the document together; a disagreement between them is a bug.
- **Evidence from real renders.** Photograph the change at 2000×1040 dark, 1440×900 light and 390×844 light before calling it done, and look at the images. Check anything that depends on real targets against the operator's real configuration too.
- **Small self-contained commits.** Each one passes the gate below.

## Current checkpoint

Six GUI commits follow `7afc3975`:

- `56054ff8` Code blocks and diagrams keep their chrome to one frameless line inside the dark well (language, Copy; Show source and Copy source on a diagram). The line count appears only past the 24 lines a block shows before scrolling. The conversation and Docs share it, and the Mermaid theme uses the sage `--code-*` palette instead of the retired teal. New token `--code-ink-muted`; the contrast check covers 92 pairs.
- `74bba5a2` The route (target · model, health as the glyph) moved from the header into the composer's actions row beside Send, passed as one object memoized on reported settings and health (`client/chat/route.ts`). Without settings it says "Model not reported".
- `f66f18a0` The Sessions and project-history pages became one reading column of hairline rows (`client/pages/projects.css`), one primary action per page, 36px controls, sentence-case status. Deleting a saved conversation is a two-press in place with focus on Keep. The path field is "Project folder"; the project's action is "New conversation".
- `ba7a4d07` Running workers show in a strip at the transcript's live edge (`LiveWorkers` in `client/chat/FleetStrip.tsx`) with Guide and a two-press Stop; Session tools keep the full fleet history. The held-worker fixture emits the `dispatch` tool call the runtime keeps open, and the smoke steers from the strip.
- `9970bcd9` Model fields pick from the target's catalog (`client/pages/model-select.tsx`, `model-options.ts`) in Session tools and on the Settings page (`chat.model`, `fleet.default.model`, `context.memory.model`, `context.compaction.model`). Choosing a target in Session tools probes its endpoint; the Settings page can check a target again. Verified against the operator's real targets (inception offers mercury-2.5 and mercury-2; openrouter's probe reports `not-configured` and the list falls back to the last catalog).
- The commit carrying this file adds `scripts/visual-review.ts` (`pnpm run visual`) and `tests/harness/history-fixture.ts`.

Verified at `9970bcd9`: typecheck, Biome, `test:full` (345/345), build, contrast (92 pairs), and the smoke at 1600, 1050 and 390px (189 Axe checks, no violations of any impact, no overflow, no script errors or failed requests).

## Since the checkpoint

- **Streaming performance is measured** in `PERFORMANCE.md` by `pnpm run perf` (`scripts/perf-workload.ts`) against the fixture's `[workload]` turn (`tests/fixtures/stream-workload.mjs`). No task over 50 ms in 21 turns; keystroke→`input` p95 ≤ 1.4 ms; event→paint p95 30–32 ms; the composer renders 0 times across 1,258–3,274 streamed deltas. Both headless Chrome and Chrome under WSLg measured 60 Hz, so nothing about 120 Hz is claimed. The reference workload is 6.7 KB, not the ~16 KB DESIGN.md had inherited; `--bytes 16384` measures a real 16.7 KB answer too. `client/render/render-probe.ts` counts renders only when the page defines `__clioRenderCounts`, and the smoke now asserts on every run that the workload stream leaves the composer unrendered. The smoke's first failed diagram exposed `role="alert"` on a `<figcaption>`; the role now sits on a span inside it.

## Pending, in order

1. **A route for this conversation only.** Session tools can change only the saved user defaults, because the runtime's `clio-coder/settings/patch_safe` writes user settings; choosing inception there changes the default for every project, the CLI and the TUI. The operator expects to switch the model for one conversation, as in Claude and Codex. This needs a session-scoped routing method in the runtime (the TUI already keeps session routing state in `src/core/session-routing.ts`). Do not patch `src/`: write the ACP shape the GUI needs, ask for it, and meanwhile make the saved-default consequence plain at the point of change (the composer's route chip could open a small picker that says "Saved for every project").
2. **The rest of the choices audit.** Every field the runtime can enumerate should be a select. Known candidates: `fleet.concurrency` ("auto" or a number), `fleet.worktrees.root`, `integrations.library.remote`, profile and binding models on the Routing page if they become editable, and the target onboarding form's "Default model", which cannot list a catalog before the connection exists (consider saving the connection first, then picking from its probed catalog). The ACP target list carries no `defaultModel`, so Session tools labels the first option "Target default" without naming it; a runtime field would fix that.
3. **Simplify and make it obvious.** The operator's goal is a GUI that a scientist can use without a manual. Candidates, each judged from real renders: Session tools is a long mixed menu (label, a paragraph about saved defaults, settings, a target list with probes, commands, fleet history, close); group it by intent and say less. The Overview and Sessions pages both list recent projects. The Sessions eyebrow ("YOUR WORK · WORKSPACES ON THIS MACHINE · OPEN, RESUME AND DELETE") is instrument voice on a conversation page. First run should reach a conversation in two actions. Inspector pages still use uppercase pill `StatusMark`s.
4. **Smaller known issues.**
   - A worker the operator stopped leaves its delegation row reading "1 tool failed · Failed" in the error tone. The fleet fact says `outcome: cancelled`, `reason: operator_cancel`; it should read "Stopped" in a neutral tone, like "not approved".
   - A group whose only failure is a declined change still reads "1 step failed" in the error tone (`summarizeActivity` in `client/chat/activity.ts`).
   - The approval card's "Waiting 0ms." fact reads oddly in its first second.
   - The fixture's permission call is titled "Write fixture" in `tool_call` and "write" in the update, so `gatedPreview` shows only the path. Check what the real runtime sends before changing the GUI.
   - At 390px a failed delegation row's failure excerpt squeezes its headline to "scout ·…".

## Running and verifying

**The gate** before each commit, from `apps/clio-coder-gui`: `pnpm run typecheck`, `npx biome check .` (run Biome from this directory; the repository root's config formats differently), `pnpm run test:full`, `pnpm run build`, `node scripts/check-contrast.mjs`, and the smoke at all three widths with zero serious or critical Axe violations. The other agent's root `pnpm test` rebuilds `dist/client` and deletes `index.html` mid-run, so the smoke and the visual review run against a private build:

```sh
npx vite build --outDir <scratch>/client-build --emptyOutDir
pnpm run smoke:browser --client <scratch>/client-build/                # 1600, 1050 and 390
pnpm run smoke:browser --client <scratch>/client-build/ --widths 390   # one width while fixing
```

A failed smoke leaves `failure.png` and `report.json` in the `clio-web-browser-*` directory it prints.

**Visual review** uses the ACP fixture with a seeded project (three earlier conversations) and photographs every surface at the three review viewports:

```sh
pnpm run visual --client <scratch>/client-build/ --out <scratch>/shots/before
pnpm run visual --client <scratch>/client-build/ --out <scratch>/shots/after --only conv,fleet,steer --route
pnpm run visual --serve        # fixture API on 4317; then pnpm dev:client and open http://127.0.0.1:4318/#token=test-token
```

Shots: `workspaces`, `history`, `delete`, `empty`, `conv`, `docs`, `approval`, `fleet`, `steer`, `tools`. `--route` makes the fixture advertise safe settings and a healthy target so the composer shows a reported model. Prompts containing `[approval]`, `[fleet]` and `[stream]` reach those fixture turns. In your own Playwright scripts, pass functions without named inner functions to `page.evaluate`/`waitForFunction` (tsx injects `__name`), and never a string: the page's CSP forbids `eval`.

**Streaming performance** runs the same private build through three `[workload]` turns and writes one JSON report; `PERFORMANCE.md` explains every column and is regenerated from those reports, never typed:

```sh
pnpm run perf --client <scratch>/client-build/ --out <scratch>/perf --label <name> [--bytes 16384] [--headed]
```

**The real GUI** for the operator runs from an exact snapshot of a commit, so neither agent's uncommitted work reaches it, and uses the operator's real configuration, targets and credentials:

```sh
git archive HEAD | tar -x -C <scratch>/clio-head
ln -s <repo>/node_modules <scratch>/clio-head/node_modules
ln -s <repo>/apps/clio-coder-gui/node_modules <scratch>/clio-head/apps/clio-coder-gui/node_modules
cd <scratch>/clio-head && node --import tsx scripts/build.ts && node --import tsx scripts/build-codewiki-asset.ts
cd apps/clio-coder-gui && npx vite build
node --import tsx server/main.ts --port 4317 --token <32+ url-safe chars>
```

Open `http://127.0.0.1:4317/#token=<token>`. For live checks, open a scratch folder such as `/tmp/clio-gui-scratch` as the project so the operator's existing sessions stay untouched, and remember that a turn spends real tokens and that saved defaults are global. To check work in progress against real targets without disturbing that server, run the working tree's server on another port (`pnpm run build`, then `node --import tsx server/main.ts --port 4319 --token …`). Stop every server, child and browser you started when finished; `pgrep -af "index.js acp --cwd"` lists stray ACP children.

## Entry points

`client/pages/sessions.tsx` (conversation view, header, Session tools, Sessions pages), `projects.css`, `session-controls.tsx` (saved defaults, delete), `settings-controls.tsx`, `model-select.tsx`, `model-options.ts`, `client/chat/ChatTurn.tsx`, `ActivityGroup.tsx`, `activity.ts`, `tool-cards.tsx`, `tool-presentation.ts`, `diff.ts`, `Approval.tsx`, `Composer.tsx`, `route.ts`, `FleetStrip.tsx`, `fleet-facts.ts`, `live-status.ts`, `message-actions.tsx`, `chat-turn.css`, `composer.css`, `approval.css`, `client/styles.css`, `client/design/tokens.css`, `client/render/Markdown.tsx`, `markdown.css`, `mermaid.ts`, `server/acp/supervisor.ts`, `tests/fixtures/acp-fixture-child.mjs`, `scripts/browser-smoke.ts` and `scripts/visual-review.ts`.

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

The GUI is ready to be called an alpha: `README.md` says so, and every item the previous handoff listed is done or waits only on the runtime requests below. Commits: `49e8f746` (performance), `5bdbb2f6` (truthful endings), `0b55ac30` (route picker and choices), `3c1c2a70` (front door, docs, alpha). Verified on `3c1c2a70`'s tree: typecheck, Biome, `test:full` (348/348), build, contrast (92 pairs), and the smoke at 1600, 1050 and 390px (192 Axe checks, no violations of any impact, no overflow, no script errors or failed requests). Checked against the operator's real configuration in `/tmp/clio-gui-scratch` without saving: the picker opened on `blade` · `dynamo/qwopus3.8-27b-flash@q4_k_m` · `low`, and blade answered the catalog check with 50 models.

- **Streaming performance is measured** in `PERFORMANCE.md` by `pnpm run perf` (`scripts/perf-workload.ts`) against the fixture's `[workload]` turn (`tests/fixtures/stream-workload.mjs`). No task over 50 ms in 21 turns; keystroke→`input` p95 ≤ 1.4 ms; event→paint p95 30–32 ms; the composer renders 0 times across 1,258–3,274 streamed deltas. Both headless Chrome and Chrome under WSLg measured 60 Hz, so nothing about 120 Hz is claimed. The reference workload is 6.7 KB, not the ~16 KB DESIGN.md had inherited; `--bytes 16384` measures a real 16.7 KB answer too. `client/render/render-probe.ts` counts renders only when the page defines `__clioRenderCounts`, and the smoke now asserts on every run that the workload stream leaves the composer unrendered. The smoke's first failed diagram exposed `role="alert"` on a `<figcaption>`; the role now sits on a span inside it.

- **The route picker.** The route chip beside Send opens target, model and thinking (`client/chat/RoutePicker.tsx`) and says "Saved for every project" before its button, because `settings/patch_safe` is the runtime's only write. Session tools lost the four-field saved-defaults form and its paragraph, and the target list with probe buttons: it keeps the label, working freedom (this conversation; the default for new ones, "Saved for every project"), a pointer to the chip and to the Targets page, commands, workers and Close. The dismissal of both disclosures is one hook (`client/interaction/use-details-dismiss.ts`). The fixture lists a second target (`field-station`) under `CLIO_CODER_WEB_FIXTURE_ROUTE`, which the smoke now sets because the real runtime always advertises its settings.
- **Choices.** `fleet.concurrency` and `fleet.worktrees.root` are selects of the runtime's words with an escape to an exact value (`OPEN_CHOICES` in `settings-control-model.ts`). The new-connection form's "Default model" is the shared `ModelSelect` fed by the runtime's model hints. `integrations.library.remote` stays free text, because only the operator knows the remote.
- **Simpler front door.** Overview leads with the project folder field (a first visit reaches a conversation in two actions) and drops the three cards that repeated the rail; Overview and Sessions share `client/pages/project-open.tsx`. The Sessions pages lost the inspector eyebrow. Status marks everywhere are sentence case in the interface face; inspector pages keep the pill and the dashed `unverified` rule.
- **Truthful endings.** A delegation whose run was stopped reads "Stopped" with a dash in the neutral tone (the runtime's `details.outcome` is `canceled`, `src/tools/dispatch-runner.ts:606`), and a call that was not approved reads "Not approved" the same way; groups count both apart from failures ("1 tool not approved", "2 tools completed · 1 stopped"). `toneForOutcome` maps `cancelled` and `stopped` to neutral. The approval card says "Asked just now" in its first second. The fixture titles its permission call `write`, as `src/engine/acp/server.ts:1784` does. At phone width a failed row's excerpt wraps under its headline. Primary buttons centre their label.

## Runtime requests

The GUI needs these from the runtime; none is patched into `src/`.

1. **`clio-coder/session/route`, a route for one conversation.** One ACP child serves one GUI conversation, and the runtime already keeps a live route per process (`applyRoutingAtScope(patch, "session")`, `src/entry/orchestrator.ts:2175`); only an ACP method reaching the `"session"` scope is missing. Shape it like `clio-coder/session/autonomy`:
   - Capability: `agentCapabilities._meta["clio-coder/session"].route: true`.
   - Request: `{ sessionId, target?: string | null, model?: string | null, thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }`. With only `sessionId` it reads.
   - Effect: the session scope only; settings.yaml is untouched. `settings/patch_safe` keeps its meaning (live and saved), and `settings/get_safe` keeps reporting the effective route, which is what the chip shows.
   - Response: `{ route: { target, model, thinkingLevel }, source: "session" | "settings", saved: { target, model, thinkingLevel } }`. `source` says whether this conversation has its own route; `saved` is the default new conversations start with, so the picker can show both.
   - Errors as `patch_safe`: `-32602 invalid_params` (`reason: "target-unknown"`; a model without a target; an unknown thinking level; strings past `ACP_MAX_TARGET_ID_BYTES` or `ACP_MAX_MODEL_ID_BYTES`) and `-32000 prompt_active` during a prompt.
   - GUI half once it lands: a server route beside `/api/sessions/:id/settings`, and in the picker a choice between "This conversation" (the default) and "Save for every project", with the chip saying which one the next request follows.
2. **`defaultModel` on each `clio-coder/targets/list` row.** `safeTargetModels` puts the default first when there is one, but a client cannot tell it from a first wire model, so the empty choice reads an unnamed "Target default". With the field it reads "Target default · <model>".
3. **Choices for open settings controls.** The settings control projection (`src/core/settings-controls.ts`) could carry `choices: ["auto"]` for `fleet.concurrency` and `["auto", "disk", "tmpfs"]` for `fleet.worktrees.root`, with a marker that an exact value (a whole number, an absolute folder) is also accepted, so the GUI stops naming them.

## Pending, in order

1. **Wire the session route** when the runtime ships request 1, and name the target default when it ships request 2.
2. **Judge the new front door from use.** Overview still previews five recent projects that Sessions lists in full; if that reads as repetition, Sessions could become the complete list only and Overview the only place with the field.
3. **Bare "Clio".** Several inspector strings and comments still say "Clio" alone (`grep -rn "Clio [a-z]" client`), against DESIGN.md's naming rule.

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

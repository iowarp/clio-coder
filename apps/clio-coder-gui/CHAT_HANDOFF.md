# Conversation-first GUI handoff

Work stays inside `apps/clio-coder-gui`. Another agent changes the Clio runtime, CLI and TUI in the same working tree, so stage and commit only GUI paths and never touch their files. The priority is the ordinary path: choose a project, open a conversation, send a request, follow a live run, understand what the agent did, and stay in control. Inspector and administration pages stay reachable but secondary.

## Ethos

The operator's bar is the fluency of the Claude and Codex desktop apps: a full-width pane, one centred reading column, the operator's words in a quiet bubble, unboxed prose, activity folded to a muted line, and nothing on screen that is not information. Match that fluency without copying either app, and keep what makes Clio Coder its own:

- **Honest status and provenance.** Say what the runtime reported in the runtime's own terms. A refused call reads "not approved", not "you rejected this", because `src/tools/registry.ts:1277` words a denial, a cancelled turn and an abort alike. A group says "changed 1 file" only for a change that completed without an error. Never invent a value, a rate or an author.
- **Meaning survives greyscale.** Every status is a glyph and a word; colour only supports them.
- **Keyboard and screen reader parity.** A visually hidden label is still announced; hover-revealed actions also appear on focus and on touch.
- **Draft safety and the local boundary.** The composer never loses a draft; the server stays authenticated and local.
- **DESIGN.md is the authority.** Change the code and the document together; a disagreement between them is a bug.
- **Evidence from real renders.** Photograph the change at 2000×1040 dark, 1440×900 light and 390×844 light before calling it done, and look at the images.
- **Small self-contained commits.** Each one passes the gate below.

## Current checkpoint

Eight GUI commits follow `7b0d2405`:

- `745ad21f` `tests/pages.test.ts` reads both `element:` and `lazy:` routes.
- `4a8cf8ae` The Targets operation panel keeps its heading role (`aria-live` instead of `role="status"` on the h2).
- `50aab4c9` The Session tools menu hangs below its button at every width; below 650px it used to cover its own toggle.
- `24375b9e` A refused change keeps its proposal on screen as "Not applied · not approved" with the error under it; the row reads "Not approved" instead of the model-facing last line; group digests say "changed" only for completed changes, and edits and writes share one phrase.
- `9be273d3`, `ecd637ac` `scripts/browser-smoke.ts` is green again for the current flow, with `--widths` and `--client` options.
- `2e15e81a` A pending approval shows its full card once, beside the call. The pinned banner is a one-line strip (what, time left, Review, Reject, Allow once) while that card is mounted, and the full card only when the call is missing or its group is folded.
- `93463c04` The conversation fills the pane: the transcript scrolls at the pane's edge and its content, the approval region and the composer share one centred 820px column (`--conversation-max`). The request is a quiet rounded bubble, responses have no rail or printed author, activity summaries are unframed lines, conversation status marks are sentence-case glyph and word, and the outcome and response actions share one line. DESIGN.md's evidence spine became "The conversation record", with the page frame, status voice, radius and header rules updated to match.

Verified at that checkpoint: typecheck, Biome, `test:full` (340/340), build, contrast (88 pairs), and the smoke at 1600, 1050 and 390px (186 Axe checks, no violations of any impact, no overflow, no script errors or failed requests).

## Pending, in order

1. **Code-block and diagram chrome.** The `ts · 2 lines` bar, the bordered mono Copy button, and the mermaid Show source / Copy source buttons are the heaviest thing left in a response. `client/render/markdown.css` and `Markdown.tsx` are shared with the Docs page, so either scope the change to `.chat-response` or restyle both deliberately.
2. **Model in the composer.** Move the route (target and model, with the target's reported health folded into its glyph) from the header into the composer's actions row, as Claude and Codex show it. The header keeps project, title, status and Session tools. The composer is isolated for streaming performance (DESIGN.md "Streaming cadence"), so pass it stable, memoized props or render the chip beside it; do not let every delta re-render the composer. An unhealthy target must still be written out in full under the header (`SessionHealth` in `client/pages/sessions.tsx`).
3. **Sessions and project-history pages.** `Workspaces` and `Sessions` in `client/pages/sessions.tsx` still use the old `trace-panel` / `trace-run-card` layout with mismatched button sizes. Bring them to the conversation's quieter language: one clear primary action, list rows rather than cards, consistent control heights.
4. **Running workers in the conversation.** Decided: live worker runs belong in the transcript. Guide and Stop now sit at the bottom of Session tools below settings and targets; at 1440px they were cut off inside the menu, and below 650px the "1 worker running" label is visually hidden. Build a compact live-workers strip at the transcript's live edge (after the last turn, so detached runs from earlier turns also show) that reuses `FleetRunRows` with steering from `client/chat/FleetStrip.tsx`; Stop stays a two-press control. The menu keeps the full fleet history. The fixture does not yet emit the attached `dispatch` tool call the runtime keeps running for a worker's life; add it in `heldWorker()` in `tests/fixtures/acp-fixture-child.mjs`: an `in_progress` `tool_call` titled `dispatch` with `rawInput: { agent: "scout", task: "Survey the fixture" }` before `dispatch.enqueued`, and a `failed` `tool_call_update` with an error message and `details.runId` after the run settles. Then move the smoke's Guide/Stop steps from the menu to the strip, and check the Delegate row at 390px, where its state word clipped.
5. **Streaming performance.** Nothing has been measured since the conversation-first changes. Measure per DESIGN.md "Streaming cadence" against the reference budgets there (keystroke→input p95, keystroke→next frame p95, event→paint p50/p95, long tasks during a ~16 KB stream), and record the numbers and the exact workload in a new `PERFORMANCE.md`. Never state a display rate that was not measured.

Smaller known issues:

- A group whose only failure is a declined change still reads "1 step failed" in the error tone. It should say "not approved" in a neutral tone and fold like a settled group (`summarizeActivity` in `client/chat/activity.ts`).
- The approval card's "Waiting 0ms." fact reads oddly in its first second.
- The fixture's permission call is titled "Write fixture" in `tool_call` and "write" in the update, so `gatedPreview` shows only the path. Check what the real runtime sends before changing the GUI.
- Inspector pages still use the uppercase pill `StatusMark`; only the conversation changed voice.
- With no advertised settings, the header route chip reads only "Target".

## Running and verifying

From the repository root, build the client, then start the server with a fixed token so `node --watch` restarts keep the same URL:

```sh
pnpm --filter @iowarp/clio-coder-gui build
cd apps/clio-coder-gui && node --watch --import tsx server/main.ts --port 4317 --token <32+ url-safe chars>
pnpm --filter @iowarp/clio-coder-gui dev:client
```

Open `http://127.0.0.1:4318/#token=<token>`. The server reads local Clio state unless launched with `--fixture`. Use a scratch project for live runs and do not touch the operator's existing sessions. Stop every server and browser when finished.

The gate before each commit, from `apps/clio-coder-gui`: `pnpm run typecheck`, `npx biome check .` (run Biome from this directory; the repository root's config formats differently), `pnpm run test:full`, `pnpm run build`, `node scripts/check-contrast.mjs`, and the smoke. The other agent's root `pnpm test` rebuilds `dist/client` and deletes `index.html` mid-run, so run the smoke against a private build:

```sh
npx vite build --outDir <scratch>/client-build --emptyOutDir
pnpm run smoke:browser --client <scratch>/client-build/            # all three widths
pnpm run smoke:browser --client <scratch>/client-build/ --widths 390  # one breakpoint while fixing
```

A failed smoke leaves `failure.png` and `report.json` in the `clio-web-browser-*` directory it prints.

For visual review, write a scratch script that starts `harness()` from `tests/harness/app.ts` with `scenario: "markdown"` and `clientDir` pointing at the private build, serves it with `@hono/node-server`, and drives `playwright-core` (Chrome at `/usr/bin/google-chrome`). Prompts containing `[approval]`, `[fleet]` and `[stream]` exercise approvals, a held worker and a cancellable stream. Two traps: a scratch directory needs a `package.json` with `"type": "module"` and a `node_modules` symlink to this app's, and `page.evaluate` must take a string rather than a function with named inner functions, because tsx injects `__name`.

Useful entry points: `client/pages/sessions.tsx` (header, Session tools, project pages), `client/chat/ChatTurn.tsx`, `ActivityGroup.tsx`, `activity.ts`, `tool-cards.tsx`, `tool-presentation.ts`, `diff.ts`, `Approval.tsx`, `Composer.tsx`, `FleetStrip.tsx`, `fleet-facts.ts`, `message-actions.tsx`, `chat-turn.css`, `composer.css`, `approval.css`, `client/styles.css`, `client/design/tokens.css`, `client/render/markdown.css`, and `server/acp/supervisor.ts`.

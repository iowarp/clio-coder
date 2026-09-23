# Conversation-first GUI handoff

Work stays inside `apps/clio-coder-gui` while other agents change the Clio runtime, CLI, and TUI. The priority is the ordinary path: choose a project, open a conversation, send a request, follow a live run, understand agent actions and output, and stay in control. Inspector and administration pages stay reachable but secondary.

## Current checkpoint

Three GUI-only commits follow `5abcfb96`:

1. `67ae6747` keeps narrative in wire order. `contracts/session-projection.ts` used to key every narrative chunk of a turn as one item, so prose written after a tool call was appended to the paragraph above it. A narrative stream now starts a new passage after a tool call, a notice, or a same-agent switch between reasoning and prose. Server snapshots and browser deltas share the function, so ids agree.
2. `e6f7d84b` presents tool activity as folded rows. Output reads the runtime's operator copy (`details.resultDisposition.presentation.content`) and strips the model-facing `[tool-result …]` envelope when no copy exists. Each call is one line: glyph, plain verb, target, one fact (exit code, line count, `+7 −1`). Rows follow `src/tools/presentation.ts`: everything folds, diffs stay visible, failures carry their last output line, and a command observed while running shows its output. Reasoning between calls joins the activity group. Reasoning with no call beside it keeps its own one-line disclosure, which previews the newest line while streaming. Settled groups say what they did ("read 2 files, ran 1 command").
3. `05294d33` puts the conversation first. The header is one bar holding the project link, the title (label, else first request), live status, a model chip whose glyph carries reported target health, and one **Session tools** menu. The menu holds the project path, switching, controls, commands, workers, and Close session. Unhealthy targets and context warnings still render in full. The composer keeps one actions row with a stable height. Delivery modes appear only once a mid-turn draft exists, Stop stays visible while running, and Enter-to-send is a checkbox. Navigation keeps ten links in two groups, and the Overview leads with open conversations and recent projects.

Evidence came from a real run against the operator's configured target (`blade`, `dynamo/qwopus3.8-27b-flash`) in a scratch project under the session scratchpad. Two turns covered reads, listings, bash, an edit, a write, and interleaved reasoning. They were observed live at 1440×960 and replayed after a server restart; 390×844 showed no horizontal overflow. Typecheck, Biome, the contrast check (88 pairs), and the build pass. `pnpm run test:full` passes except `tests/pages.test.ts`; under parallel load, nine real-worker tests hit their 4 s operation timeouts and pass when run serially.

## Known gaps, in order

1. `scripts/browser-smoke.ts` has failed since `17e1e3cc`. It waits for an "Open workspace" button at line 283; that flow is now "Start conversation" / "View saved sessions". Later steps also need updating. Close session now lives inside Session tools (open `.conversation__tools > summary` first). A settled non-diff row needs its own `.tool-card > summary` click before its body exists. Fix the script and run it, because it is the only coverage for approvals, rejection, fleet steering, queue take-back, interrupt refusal, stop, close, problem toasts, and Axe at 1600, 1050, and 390px.
2. `tests/pages.test.ts` regexes `client/main.tsx` for `{ path: "…", element:` but most routes are `lazy:`. Teach it both shapes.
3. Approvals were not seen live this session because the real target auto-applied edits. Review the pending, allowed, and rejected states under the new rows using the fixture (`[approval]` prompts in the smoke's markdown scenario, or `--fixture` with `CLIO_CODER_WEB_CLI` pointing at `tests/fixtures/acp-fixture-child.mjs`).
4. Dispatched work has only been reasoned about, not observed. Live workers show in the live chip ("Waiting on 1 worker"), in the Session tools label, and as "Delegate" rows. The FleetStrip with guide/stop controls sits only inside the menu. Decide whether live worker rows belong in the transcript.
5. Remaining visual weight: the request block (accent-soft slab), the uppercase mono outcome and status pills, and the Sessions and project pages, which still use the older heavy layout with mismatched button sizes.
6. Streaming performance has not been measured since these changes. Record numbers in `PERFORMANCE.md` per `DESIGN.md`.
7. `DESIGN.md` still describes the old header and the per-tool card. Update the evidence-spine and shell sections to match.

## Running it

From the repository root, build the client, then start the server with a fixed token so `node --watch` restarts keep the same URL:

```sh
pnpm --filter @iowarp/clio-coder-gui build
cd apps/clio-coder-gui && node --watch --import tsx server/main.ts --port 4317 --token <32+ url-safe chars>
pnpm --filter @iowarp/clio-coder-gui dev:client
```

Open `http://127.0.0.1:4318/#token=<token>`. A server restart drops in-memory sessions; reload one from its project's history with **Load session**. The server reads local Clio state unless launched with `--fixture`. Use a scratch project for live runs and do not touch an operator's existing sessions. This checkpoint opened a scratch `project-lab` folder, which now appears in the GUI's recent projects; that is GUI state only. Stop the server, Vite, and any browser when finished.

The working tree may contain CLI/TUI edits from another agent. Stage and commit only `apps/clio-coder-gui`.

Useful entry points: `client/pages/sessions.tsx` (header, Session tools), `client/chat/ChatTurn.tsx`, `ActivityGroup.tsx`, `tool-cards.tsx`, `tool-presentation.ts` (verbs, digests, fold policy, operator copy), `turns.ts` (segment grouping), `Reasoning.tsx`, `Composer.tsx`, `Approval.tsx`, `FleetStrip.tsx`, `contracts/session-projection.ts`, and `server/acp/supervisor.ts`.

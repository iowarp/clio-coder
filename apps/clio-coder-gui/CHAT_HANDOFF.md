# Conversation-first GUI handoff

This is a handoff for the next GUI session. Work stays inside `apps/clio-coder-gui` while other agents change the Clio runtime, CLI, and TUI. The user's next priority is the ordinary path: choose a project, open a conversation, send a request, follow a live run, understand agent actions and output, and stay in control. The many inspector and administration pages can be refined later. Keep them available, but make the everyday chat feel clear, fast, and visually calm.

## Current checkpoint

GUI-only commits `17e1e3cc`, `a09d3100`, and `44d78f1c` cover recent project entry, saved-session selection, conversation controls, draft persistence, settings safety, reconnect handling, approval details, tool output, and transcript rendering. The project browser reads server-side folders because a browser file picker cannot give the ACP host a usable local path. The conversation has grouped turns, live status, reasoning disclosures, activity groups, tool cards, approval cards, a docked composer, mid-turn steering, and a jump-to-latest control.

The last browser issue was a blank Vite page: its `/api` proxy intercepted frontend source imports such as `/api/client.ts`. `vite.config.ts` now excludes TypeScript source modules from that proxy. A real Chrome load showed the Overview and **Connected** after the fix. The normal GUI build on port 4317 also rendered. TypeScript and Biome checks passed for the committed GUI changes. This establishes a working starting point, not a review of the full live-chat experience.

## Next focus

1. Walk the path from opening a project to a live turn in the actual GUI. Observe a real or isolated run with prose, reasoning, several tool kinds, approval, and completion. Check desktop and narrow viewport layouts. Use the runtime's actual events and contracts; do not infer parity from the component names.
2. Make the conversation the clear primary surface. Review the navigation, project entry, header, transcript, and composer together. Reduce the visual weight and cognitive load of secondary options without removing access to them.
3. Improve how agent invocations, parallel or dispatched work, tool arguments, partial output, final output, errors, and approvals read during a live run. Preserve provenance and distinguish proposed actions from completed ones. Keep streaming updates responsive and avoid transcript jumps.
4. Refine the controls people need while working: sending, multiline input, stopping, interrupting, steering, queue state, approval decisions, retry, and session switching. Explain unavailable capabilities at the point of use. Check focus and keyboard behavior as well as appearance.
5. Use a modern, clean visual hierarchy with readable typography and deliberate spacing. Favor an excellent simple chat over adding more cards or another settings page. Keep accessibility and the authenticated local-server boundary intact.

Useful entry points: `client/pages/sessions.tsx`, `client/chat/ChatTurn.tsx`, `ActivityGroup.tsx`, `tool-cards.tsx`, `Approval.tsx`, `Composer.tsx`, `FleetStrip.tsx`, `client/render/Markdown.tsx`, `client/render/follow-latest.ts`, `client/api/events.ts`, `client/api/sessions.ts`, `contracts/sessions.ts`, and `server/acp/`. The recovered design and parity material is under `../../docs/gui/`; verify older claims against current code before acting on them.

## Running it

From the repository root, build the client and start the GUI server, then run Vite in another terminal:

```sh
pnpm --filter @iowarp/clio-coder-gui build
pnpm --filter @iowarp/clio-coder-gui dev:server
pnpm --filter @iowarp/clio-coder-gui dev:client
```

The server uses `127.0.0.1:4317` and prints a private URL with a token fragment. Open that URL with port `4318` to see live frontend edits; retain the fragment. The server reads the local Clio state unless launched with `--fixture`. Avoid changing an operator's existing sessions while inspecting the GUI. Stop both processes when the inspection is finished.

The working tree may contain unrelated CLI/TUI edits from another agent. Stage and commit only `apps/clio-coder-gui`. The GUI goal remains broader than this handoff; completion needs direct evidence for the project-to-chat flow and live-run presentation, not only a passing build.

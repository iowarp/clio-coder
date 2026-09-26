# GUI settings and onboarding modernization — agent brief

This is an implementation brief for the GUI coding agent, not a description of shipped onboarding. The terminal configure wizard is the reference experience. Its saved configuration is shared with the TUI and GUI; the GUI must make that continuity visible and let a new user connect a model without learning the configuration schema.

## Task and product direction

Continue on `v057`. Other agents are working in this repository. Inspect current changes before editing, coordinate overlapping files, and commit only your own work in one atomic commit at the end. Keep the pass focused on settings terminology, entry points, and the shortest useful first-run flow. Add no new tests; use the relevant existing checks and a brief browser walkthrough. Update user-facing documentation to describe what actually ships.

Preserve two explicit entry points:

- Terminal users install with `npm install -g @iowarp/clio-coder`, run `clio-coder configure`, and start `clio-coder` in their project.
- GUI users install the same package and start `clio-coder gui --open`. Existing desktop-launcher users should reach the same first-run experience.

Do not change bare `clio-coder` to launch the GUI in this pass. That changes an established terminal command and requires a separate product decision. Keep GUI launch opt-in. npm installation still assumes some terminal comfort; this pass improves the experience after launch. A packaged desktop installer is a separate distribution project.

If configuration already supplies a chat-eligible connection and model, skip provider onboarding. Show the current choice briefly and let the user select a project and start a conversation. Reuse settings written by configure; do not ask the user to repeat them. If the saved route exists but its server is stopped or credentials are missing, offer repair of that connection, not a forced fresh setup. Passive reachability alone does not establish that a model can answer.

If there is no usable saved chat route, show one compact **Connect a model** flow inside the GUI. Do not make “run configure in a terminal and come back” the default onboarding screen. Permit browsing or cancellation without saving; explain why starting a conversation still needs a model. First-run state must follow the runtime's configuration and reported readiness, not just a browser `onboardingComplete` flag or the presence of any target, since a worker-only target cannot answer chat.

## Shared settings contract

Use these sections in this order, taking their names and descriptions from the runtime catalog:

| Section | Main purpose |
| --- | --- |
| Connections | Apps, servers, providers, credentials, discovered models |
| Chat | Answering connection/model, thinking, response limits, retries |
| Fleet | Worker defaults, profiles, agent routes, placement, execution limits |
| Context & Memory | Working set, compaction, proactive memory |
| Permissions & Limits | Autonomy, worker approvals, spending/tool limits, review, external-agent tool permissions |
| Appearance | Relevant display preferences; clearly identified terminal settings where exposed |
| Integrations | Project resources, coding agents, plugins, library, Git |
| Advanced | Diagnostics, file locations, effective values, configuration sources |

Consume `SETTINGS_SECTIONS`, `settingsSectionForPath`, and `settingsGroupForPath` from `src/core/settings-navigation.ts`, plus `SETTING_CONTROLS`, `orderedSectionControls`, and `orderSettingsEntries` from `src/core/settings-controls.ts`. The TUI now uses the same grouped catalog order. Apply that order in the GUI server adapter before filtering unsupported controls; do not alphabetize the groups or derive headings from YAML roots. Shared control labels and explanations already flow through the existing adapter, so build on that path.

Use **connection** for the user-facing concept; explain **target** once as its CLI/YAML name. Use **Chat**, **Fleet**, **Proactive memory**, **Permissions & Limits**, and **Appearance** consistently. Keep canonical settings keys and CLI/runtime identifiers unchanged. Legacy internal row ids such as `orchestrator.*`, `workers.*`, or `panes.yazi.*` are implementation details, not labels to copy into the GUI.

Make **Settings** the primary editing destination. Put **Effective settings** and **Configuration sources** behind Advanced/inspection links, preserving existing routes if users have bookmarks. Distinguish current-conversation model changes from saved defaults in plain language beside the save action. Do not claim that a saved default redirects an open ACP conversation or promise TUI project/session edit scopes that the GUI backend does not support.

Mirror organization and meaning while respecting differences in behavior. Terminal panes, terminal streaming, and terminal scrollbar controls do not become browser controls. The existing GUI adapter hides or marks several of these as read-only. Keep that distinction explicit; GUI-only appearance preferences should be labeled as applying to this app. Unavailable controls need an explanation rather than an editor that silently does nothing.

## Minimal first-run flow

Mirror configure's source choices and defaults, using a short sequence rather than the entire settings catalog:

1. **Choose the source:** **An app on this computer**, **A model server**, **An AI subscription**, or **A provider account or API**. Use `CONFIGURE_CATEGORY_CHOICES` in `src/cli/configure-layout.ts` and the runtime support registry as the reference. **An installed coding agent** is a worker-only choice when adding another connection, not a first-chat option. Keep **Connect by endpoint** as an optional shortcut.
2. **Connect:** show the chosen app/provider, known local address, and only required fields. Derive a unique connection id automatically. Reveal endpoint/id overrides under an advanced affordance. Start browser sign-in or accept a credential through a supported runtime-backed flow when needed.
3. **Choose the model:** reuse the shared model selector and runtime inventory. State whether results are live, cached, or catalog-only. If a discoverable server returns no models, offer **Check again** with a useful instruction to start the server or load a model. Typing an unverified id belongs in an explicit advanced fallback. Provide **Use connection default** for later route edits and **Rules only** for proactive memory.
4. **Review and save:** show source, model, evidence, and save scope, with Save/Back/Cancel visible at narrow widths. The first connection sets chat and fleet defaults according to configure's rules; adding or editing a connection preserves unrelated routes. Use shipped defaults for everything else. Put connection/machine details in an optional disclosure.
5. **Choose a project and start:** return directly to the normal conversation path. Avoid a tour, mandatory fleet setup, memory tuning, or an installation checklist.

Share the runtime setup logic rather than implementing authentication, probing, validation, or save semantics a second time. `src/cli/configure-onboarding.ts`, `configure-host.ts`, `configure-target.ts`, and `configure-routing.ts` are the reference pathways; `src/interactive/target-wizard.ts` demonstrates hosting the same wizard with a different presentation. Reuse the existing GUI target routes and model-selection components where they provide the needed contract. If browser hosting requires a small runtime bridge, make it a typed adapter over those capabilities, not terminal escape-sequence playback or an arbitrary shell-command endpoint.

The current `client/pages/target-onboarding-model.ts` deliberately sends sign-in and key setup to a terminal. Read the surrounding server contracts and `apps/clio-coder-gui/DESIGN.md` before changing that behavior. Implement supported credential flows through the authenticated local service and runtime credential store. Keep credentials out of browser persistence, URLs, logs, and returned settings payloads. Explain that browser sign-in may store credentials before the target's final Save, matching configure. If a specific provider still requires its own installed tool, explain that exception beside that provider and retain a usable back path. Do not present a terminal-only auth path as completed GUI onboarding.

Passive checks must retain configure's honest evidence vocabulary. Distinguish reachability from live model discovery, cached/catalog evidence, and unchecked facts. No generation, model download/load, or qualification probe should run just because the page opened. CPU and available-memory observations do not prove GPU/VRAM, model fit, answer quality, or tool-use support. Show generating checks only as explicit user actions when supported.

## Files to inspect first

- Shared runtime: `src/core/settings-navigation.ts`, `src/core/settings-controls.ts`, `src/cli/configure-layout.ts`, `src/cli/configure-onboarding.ts`, `src/cli/configure-host.ts`, `src/cli/configure-routing.ts`.
- Settings GUI: `apps/clio-coder-gui/server/clio/adapters/settings-controls.ts`, `contracts/settings-controls.ts`, `client/pages/settings.tsx`, `settings-controls.tsx`, `settings-control-model.ts`, `config-map-model.ts`.
- Connection GUI: `client/pages/target-onboarding.tsx`, `target-onboarding-model.ts`, shared model selector, target HTTP/service/CLI adapters, and auth contracts.
- Launch/first run: GUI launcher/background service, overview/session creation, workspace selection, navigation/panel labels, and desktop entry.
- Docs: `apps/clio-coder-gui/DESIGN.md`, its README, root README, and `docs/guide/configuration-and-targets.md`.

## Completion evidence

Use existing checks appropriate to changed paths; keep verification concise. Manually inspect a wide browser and a narrow viewport. Demonstrate that an already-configured user skips onboarding; a clean installation can finish one supported setup entirely in the GUI; worker-only targets do not satisfy chat readiness; an empty model list offers recovery; a stopped server can be repaired; cancellation leaves target settings unchanged; and saving preserves unrelated routes and does not redirect an open conversation. Document supported auth paths and any remaining provider-specific limits precisely. Report the final commit and the checks actually run.

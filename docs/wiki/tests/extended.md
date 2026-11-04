---
title: "Extended behavioral tests"
summary: "Overview of the tests/extended suite: which product workflows it exercises end to end (wiki generation outcomes, library import, compaction controls, welcome banner, configure sections, operator extensions, rendering invariants) and where each one enters the source."
sources:
  - "src/domains/context/wiki/generate.ts"
  - "src/domains/interop/import.ts"
  - "src/domains/session/compaction/compact.ts"
  - "src/interactive/welcome-dashboard.ts"
  - "src/cli/configure.ts"
  - "src/domains/extensions/operator-extensions.ts"
symbols:
  - "runWikiGenerate"
  - "planLibraryImport"
  - "compact"
  - "createBootWelcome"
  - "runConfigureCommand"
  - "OperatorExtensions"
tests:
  - "tests/extended/wiki-generation-outcomes.test.ts"
  - "tests/extended/library-import.test.ts"
  - "tests/extended/compaction-controls.test.ts"
  - "tests/extended/compaction-skill-checkpoint.test.ts"
  - "tests/extended/welcome-boot-header.test.ts"
  - "tests/extended/configure-sections.test.ts"
  - "tests/extended/operator-extensions.test.ts"
  - "tests/extended/rendering-invariants.test.ts"
invariants:
  - "A wiki page whose repair draft still fails validation remains pending in the plan, and its navigation reports it as pending rather than complete, as asserted by the wiki-generation-outcomes fixtures."
  - "A library import plan with a script-dependent bare skill is blocked with a reason mentioning scripts, as asserted by the library-import test that calls planLibraryImport on a SKILL.md referencing scripts/check.py."
  - "Compaction with a skill activation and no verifiable skill context is refused with the native-skills-unverified category when provider compaction is requested, as implied by compactWithCalls in compact.ts."
  - "The welcome banner at narrow widths keeps the route-unavailable repair action visible and marks truncation, as asserted by the welcome-boot-header tests at 60 and 40 columns."
validate:
  - "pnpm run test:file -- tests/extended/library-import.test.ts"
  - "pnpm run test:file -- tests/extended/wiki-generation-outcomes.test.ts"
---

# Extended behavioral tests

`tests/extended/` holds the larger end-to-end and behavioral suites for Clio Coder. Each file drives a product workflow through its real entry point (a CLI command, a session turn, a rendered component, or a runtime object) rather than a single module in isolation. A reader needs this page to find which file covers a given workflow, what its fixtures set up, and which source file it enters.

This page is an overview. It does not claim that any test was executed; it describes the cases as written.

## What the suite covers

The eight anchor files group into seven areas.

- **Wiki generation outcomes** (`tests/extended/wiki-generation-outcomes.test.ts`). The suite builds a temporary git repository, runs `runWikiGenerate` from `src/domains/context/wiki/generate.ts` with a fake `dispatch` that writes pages on disk, and asserts the plan, meta, and navigation files afterwards. The test helper `generator` resolves the page path from the prompt text and forwards it to a scripted action. Cases cover a forward link to a later planned sibling (`section/b.md`) that is written, left as a pending draft, left empty, or missing, and a single bounded repair dispatch after an invalid draft (`wiki-repair` agent, `budget` of 10 tool calls with a read reserve of 4, and a `write` tool denied). The repair cases assert that the repair prompt carries 13 diagnostics and that a failed receipt keeps the page pending.
- **Library import** (`tests/extended/library-import.test.ts`). The suite exercises `planLibraryImport`, `applyLibraryImport` and `releaseLibraryImport` from `src/domains/interop/import.ts`, plus the `library` CLI through a child process against `dist/cli/index.js`. Cases include a bare `SKILL.md` import that normalizes the version to `1.2.0` and strips `allowed-tools` from the installed skill, a script-dependent bare skill that is blocked, and a repository-root import that names each nested skill once in its dry-run output. The same file also covers Materio and recipe extensions installed into a project and reloaded.
- **Compaction controls and skill checkpoints** (`tests/extended/compaction-controls.test.ts`, `tests/extended/compaction-skill-checkpoint.test.ts`). These drive `compact` in `src/domains/session/compaction/compact.ts` with a summarizer, cut-point logic in `src/domains/session/compaction/cut-point.ts`, and the session turn loop in `src/session-control/chat-loop.ts`. The checkpoint file builds a history containing a `skillActivation` entry and a `tool_result` carrying a large skill body, then checks that the checkpoint retains skill context while the summary omits the instruction text.
- **Welcome banner** (`tests/extended/welcome-boot-header.test.ts`). The suite renders `createWelcomeDashboard` and `createBootWelcome` from `src/interactive/welcome-dashboard.ts` at widths from 8 to 200 columns. Cases assert the session header shows the route without a latency number, that a failing route shows `route unavailable · /settings targets` without the raw `ECONNREFUSED` text, and that the action stays visible at 60 columns and is marked with an ellipsis at 40.
- **Configure sections** (`tests/extended/configure-sections.test.ts`). The suite runs `runConfigureCommand` from `src/cli/configure.ts` over in-memory streams. It isolates the XDG directories under a temporary home, writes a version 2 `settings.yaml`, and answers prompts line by line, so the numbered readline path is exercised. The onboarding helper `unconfiguredEnv` clears `PATH` so interop detection does not change the prompt count.
- **Operator extensions** (`tests/extended/operator-extensions.test.ts`). The suite exercises `OperatorExtensions` in `src/domains/extensions/operator-extensions.ts`, which composes a v1 `OperatorExtensionRuntime` and a v2 runtime and forwards reload reports. It also covers package activity capture through `bindPackageActivitySink` and `recordPackageActivity` from `src/core/package-activity.ts`. A bounded-capture case records 250 activity rows with no sink, then flushes with a failing sink and a recovered sink, and asserts 200 rows are delivered with `captureDroppedBefore` set to 50 on the first.
- **Rendering invariants** (`tests/extended/rendering-invariants.test.ts`). The suite drives `ChatPanel` and related renderers through `applyEvent` with tool execution events and a `RenderingTerminal` double, then strips terminal sequences and checks the rendered text and geometry.

## Entry points and callers

- `runWikiGenerate` is called by `src/cli/context.ts`, `src/cli/wiki-generate.ts`, `src/domains/context/index.ts` and `src/domains/context/refresh.ts`, as reported by the dependents index. Its wiki-writer dispatch goes through the `dispatch` contract supplied to `modelWikiGenerate`.
- `planLibraryImport` takes an input string, optional `cwd`, `scope` (`user` or `project`), and an optional `format` of `claude-code` or `codex`. It fetches the source with `fetchPluginSource`, detects the format, and returns a plan with `action` of `install` or `blocked`. `applyLibraryImport` re-projects the source and refuses drift, and `releaseLibraryImport` discards retained staging.
- `compact` takes a `CompactInput` containing session entries, a model, a summarizer, and optional telemetry. When telemetry is provided it wraps the call and collects settled call identifiers.
- `runConfigureCommand` takes argv and input/output streams and returns an exit code.

## Things to watch when editing

- Several suites depend on process-wide environment variables and XDG directories. The configure and operator tests restore `process.env` key by key; the configure test comment explains that assigning to `process.env` as a whole detaches Node's environment proxy.
- The library-import CLI cases run against `dist/cli/index.js`, so they require a built `dist` directory. This page does not verify that the build exists.
- The wiki-generation repair assertions check exact diagnostic counts and the `wiki-repair` agent identity. Changing the repair prompt shape or budget defaults in `src/domains/context/wiki/generate.ts` affects these assertions directly.
- The welcome-banner assertions depend on fixed truncation widths. Changes to the layout in `src/interactive/welcome-dashboard.ts` can move the ellipsis mark that the 40-column test checks.

## Test search scope

The focused tests named here were found by searching the anchor files and the import graph from the anchor source files. Whether other suites outside `tests/extended/` cover the same symbols was not searched, and absence of a case in these files does not establish absence elsewhere.

## Coverage limits

This page describes the anchor files at the level of their test cases and the source entry points they call. It does not trace every branch of `runWikiGenerate`, `compact`, `planLibraryImport`, the welcome dashboard layout, or the rendering code, and it does not describe the remaining large files in the suite such as `tests/extended/compaction-controls.test.ts` beyond their fixture setup and the cases read.

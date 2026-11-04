---
title: "Foreign agent interop: detection, import and adoption"
summary: "How Clio detects locally installed foreign coding agents, inventories their resources, and plans, applies or releases the import of Claude Code, Codex and bare-skill packages as foreign-trust Clio library packages. Read this before changing detection, package normalization, or the library import flow."
sources:
  - "src/domains/interop/index.ts"
  - "src/domains/interop/detect.ts"
  - "src/domains/interop/registry.ts"
  - "src/domains/interop/inventory.ts"
  - "src/domains/interop/foreign.ts"
  - "src/domains/interop/adopt.ts"
  - "src/domains/interop/import.ts"
  - "src/domains/interop/projection.ts"
symbols:
  - "InteropDomainModule"
  - "detectInteropAgents"
  - "resolveOnPath"
  - "INTEROP_AGENT_KINDS"
  - "discoverInteropInventory"
  - "detectForeignPlugin"
  - "projectForeignPlugin"
  - "planLibraryImport"
  - "applyLibraryImport"
  - "releaseLibraryImport"
  - "libraryImportPlanSummary"
  - "renderLibraryImportPlan"
  - "preparePortablePackage"
  - "prepareForeignPackage"
  - "unmetRequirements"
  - "planInteropAdoption"
  - "applyInteropAdoption"
tests:
  - "tests/extended/library-import.test.ts"
  - "tests/extended/interop-adoption.test.ts"
invariants:
  - "A library import plan is installable only when the reviewed source has a recognized manifest or a bare SKILL.md, the package id is not already installed in the requested scope, and no package requirement is unmet; otherwise the plan action is blocked."
  - "Applying an import refuses without explicit approval, and refuses when the source tree fingerprint or the re-prepared package digest differs from the reviewed plan."
  - "A root plugin.json always takes precedence over hidden vendor manifests; two hidden vendor manifests without an explicit format are ambiguous and yield no format."
  - "Applying a library import always releases the plan's retained source, whether the apply installs, refuses or throws."
  - "Installed foreign packages carry foreign trust and import provenance; the trust gate setting is reported as admission data, not as proof of runtime availability."
  - "Detection never starts a foreign agent's work command; version probes run with a scratch HOME and a 2000 ms timeout."
validate:
  - "pnpm run test:file -- tests/extended/library-import.test.ts"
  - "pnpm run test:file -- tests/extended/interop-adoption.test.ts"
---

# Foreign agent interop: detection, import and adoption

This area lets Clio see which foreign coding agents are installed on the host and bring their skills, agents, prompts and plugin packages into Clio's own library. A reader needs it when changing how a foreign agent is detected, how a Claude Code or Codex plugin is normalized, or how the explicit `library import` flow plans, applies and releases a package.

## What this area does

The domain has three responsibilities, each with a separate module:

1. **Detection.** `detectInteropAgents` in `src/domains/interop/detect.ts` resolves each known agent's binary on `PATH` and its user install directory, optionally probes the version, and optionally runs a resource inventory. It returns an `InteropReport` of `InteropAgentRecord` values. It keeps standing consent decisions from the previously recorded report so a declined agent is not re-proposed on every run.
2. **Inventory.** `discoverInteropInventory` in `src/domains/interop/inventory.ts` walks a known agent's user and project roots (described by the `INVENTORIES` layouts in `src/domains/interop/registry.ts`) and returns the discovered skills, agents, prompts, hooks, MCP declarations and plugin items.
3. **Import and adoption.** The `src/domains/interop/foreign.ts`, `src/domains/interop/adopt.ts` and `src/domains/interop/import.ts` modules detect a package's format from its manifest, convert its markdown components into Clio's schema, and publish the result through the library install seam with foreign trust.

Two anchor modules sit beside these: `src/domains/interop/projection.ts` holds shared path-safety and fingerprint helpers (`safeName`, `tree`, `reviewFingerprint`, `digest`), and `src/domains/interop/index.ts` re-exports the public surface and binds `InteropDomainModule`, which wires the manifest and `createInteropBundle` from `src/domains/interop/extension.ts`.

## Agent registry

`INTEROP_AGENT_KINDS` in `src/domains/interop/registry.ts:110:INTEROP_AGENT_KINDS` is the ordered list of known agents (Claude Code, Codex and the others declared there). Its order is documented as load-bearing: equal-precedence skill roots break ties by this index, so a symlinked skill resolves the same way on every machine. Each entry names binaries, a user directory, project skill and prompt roots, and an optional `inventory` key. The `INVENTORIES` table in the same file maps agent ids to `InteropInventoryLayout` objects that list markdown roots (`skills`, `agents`, `commands`), declarations (`settings.json`, `.mcp.json`, `hooks/hooks.json`, and similar), plugin directories and plugin manifest names. `interopAgentUserDir` resolves an agent's home from its `homeEnv` variable when set, which is why detection passes `process.env` through.

## Detection flow

`detectInteropAgents` (`src/domains/interop/detect.ts:173:detectInteropAgents`) is called from several surfaces: `src/cli/interop.ts`, `src/cli/interop-inspect.ts`, `src/cli/configure-interop.ts`, `src/interactive/overlays/interop.ts` and `src/domains/lifecycle/doctor.ts`. The sequence inside it is:

- The binary is resolved with `resolveOnPath`. Absolute names are checked directly. Relative names are searched on `PATH` without a shell. An unreadable directory is reported as `unknown`, not `absent`.
- When `probeVersion` is true, the probe for each present binary starts first and all probes run concurrently. `probeVersion` runs the binary with `--version` in a scratch `HOME`, with a 2000 ms timeout and a 4096-byte output cap, using `runCommandVector` from `src/core/safe-exec.ts`.
- When `inventory` is true and the agent has an inventory layout, `discoverInteropInventory` supplies `skillCount` and `projectArtifacts`. Without a probe, a version is kept only if the prior record refers to the same binary.
- An agent is kept in the report when it is detected, or unconditionally when an inventory was requested and the agent has one.
- Prior `decision`, `decidedAt` and `decidedFingerprint` fields are copied from the previous report, and each record gets a fingerprint from `interopFingerprint`.

ACP adapter presence is determined without running `npx`. `adapterPresence` (`src/domains/interop/detect.ts:66:adapterPresence`) looks for a local `node_modules` copy of the recipe's npm package under the working directory, read from its `package.json` (the package name is the recipe's `npmPackage` value, and the check is at the pinned version), and otherwise returns `unknown`.

## Import flow

The library import path is `planLibraryImport` → optional `applyLibraryImport` → `releaseLibraryImport`, exposed through `src/domains/interop/import.ts`. The CLI and any later TUI use the same seam.

`planLibraryImport(input, options)` (`src/domains/interop/import.ts:95:planLibraryImport`):

- Resolves `input` either as a GitHub source (`parsePluginGithubSource`) or as a local path, and fetches it into a staging root through `fetchPluginSource` from `src/domains/plugins/catalog.ts`.
- Computes a full-tree `reviewFingerprint` of the staged root.
- Calls `prepare`, which runs `detectForeignPlugin` and then one of `preparePortablePackage`, `prepareBareSkillPackage` or `prepareForeignPackage` according to the detected format. A `none` detection throws, and the throw is caught and recorded as a blocking reason.
- Checks `unmetRequirements` for the package's declared requirements, and refuses a package whose id is already installed in the same scope.
- Returns a plan whose `action` is `install` or `blocked`, with `files`, `digest`, `destination`, `origin` and `reviewFingerprint` filled in when a package was prepared.

`applyLibraryImport(plan, approved, options)` (`src/domains/interop/import.ts:182:applyLibraryImport`) is the only path that writes:

- Without `approved`, it returns `published: false` with the diagnostic "Approval required; nothing installed."
- A plan that is not `install`, or that lacks `files` or `digest`, returns its reasons instead of installing.
- It recomputes `reviewFingerprint` over the source root. A mismatch throws "Source changed after review", which is converted to a diagnostic.
- It re-prepares the source and requires both the reviewed digest and the current digest to match the plan. Otherwise it throws "Plan changed after review".
- It writes the reviewed files into a temporary staging directory, reads the manifest with `readPluginManifest`, and calls `installInteropPackage` with `trust: "foreign"`, the `expectedId`, the `expectedDigest`, and the plan's `origin`.
- On a published result it runs `validateLibraryPackage` on the installed root and returns the validation as a separate field.
- The `finally` block removes the staging directory and always calls `releaseLibraryImport`, which invokes the plan's `cleanup`.

The `admission` field of the result reports `trust: "foreign"`, the gate name `integrations.projectResources.trustProjectImports`, and `gateEnabled` set to the caller's `trustProjectImports` value or `"unknown"`. The module documentation states that publication, validation and runtime admission are separate facts. Component availability is reported by the inventory, not by this result.

`libraryImportPlanSummary` strips `files` and `cleanup` so a plan can be serialized. `renderLibraryImportPlan` produces the human-readable review text, including `CONVERT`, `UNSUPPORTED` and `SKIP` lines for each outcome.

Focused coverage in `tests/extended/library-import.test.ts` exercises this flow. Its test "normalizes a Claude-only package, installs it with import provenance, and leaves the source untouched" calls `planLibraryImport(root, { cwd, scope: "user" })`, asserts `plan.action === "install"`, `plan.format === "claude-code"` and `plan.detection.manifestPath === ".claude-plugin/plugin.json"`, asserts that the plan summary omits `files` and `cleanup`, then calls `applyLibraryImport(plan, true, { trustProjectImports: false })` and asserts `published === true` with installed id `claude-pack`. Other cases in the same file cover a bare skill (`plan.format === "agent-skill"`), a bare skill with a `scripts/` directory that is blocked, a root plugin.json that takes precedence over a hidden manifest, and a broken portable manifest that blocks apply. Those tests were read for their assertions; they were not executed for this page.

## Format detection

`detectForeignPlugin` (`src/domains/interop/foreign.ts:42:detectForeignPlugin`) applies a fixed order, documented in its comment:

- `FOREIGN_MANIFESTS` lists `plugin.json` (portable), `.claude-plugin/plugin.json` (claude-code) and `.codex-plugin/plugin.json` (codex).
- A root `plugin.json` always wins. If it is not a regular file, a diagnostic is produced and the format remains `portable`. An explicit `--format` is ignored with a diagnostic, and hidden vendor manifests are reported as ignored.
- With no hidden manifest, a root `SKILL.md` yields `agent-skill`. Otherwise the result is `none`, with a diagnostic that lists nested skill directories when there are any.
- With one hidden manifest, its format is used. With two and no explicit format, the result is `none` and `ambiguous: true`. An explicit format selects the matching hidden manifest, or returns `none` with the names of the manifests that are present.

`projectForeignPlugin` (`src/domains/interop/foreign.ts:250:projectForeignPlugin`) converts a vendor manifest and its components into a `ForeignPluginProjection`. Each component becomes a `ForeignResourceOutcome` with `status` set to `converted` or `unsupported`, along with any omitted frontmatter fields and omitted files.

## Adoption of portable, bare-skill and foreign packages

`src/domains/interop/adopt.ts` provides the preparers used by `prepare` in `src/domains/interop/import.ts`:

- `preparePortablePackage` (`src/domains/interop/adopt.ts:62:preparePortablePackage`) reads a root `plugin.json` package and writes a normalized `plugin.json` into the result files.
- `prepareBareSkillPackage` (`src/domains/interop/adopt.ts:165:prepareBareSkillPackage`) handles a directory whose root is a `SKILL.md`.
- `prepareForeignPackage` (`src/domains/interop/adopt.ts:205:prepareForeignPackage`) handles Claude Code and Codex manifests.
- `unmetRequirements` (`src/domains/interop/adopt.ts:323:unmetRequirements`) checks each requirement against installed, loadable packages in the scope. When a vendor is given, a same-named native package does not satisfy a vendor dependency unless its install record shows import or interop provenance with the same format. Dependency cycles are reported.

`planInteropAdoption` and `applyInteropAdoption` in `src/domains/interop/adopt.ts` (`src/domains/interop/adopt.ts:371` and `src/domains/interop/adopt.ts:545`) form a second plan/apply pair for resources discovered inside an installed host agent. Their behavior is not traced in this page beyond their names and signatures, so no claims are made about their branch logic here.

`src/domains/interop/projection.ts` supplies the helpers the preparers depend on: `safeName` and `FORBIDDEN_PARTS` for path-safe names, `DATA_EXTENSIONS` for text-only data, `tree` for walking a source, `reviewFingerprint` and `digest` for the fingerprints compared at apply time, and `prose` for text handling. The fingerprint is what enforces that the reviewed bytes equal the bytes applied.

## Extension seams

- A new agent is added by appending an entry to `INTEROP_AGENT_KINDS` in `src/domains/interop/registry.ts`. If it has an inventory, add a matching key to `INVENTORIES` with its roots and declarations. Preserve the list order, because it is a tie-breaker for skill precedence.
- A new vendor manifest format is added to `FOREIGN_MANIFESTS` in `src/domains/interop/foreign.ts`, which also requires extending `ForeignPackageFormat` in `src/domains/plugins/types.ts` and the preparers in `src/domains/interop/adopt.ts`. This page did not inspect `src/domains/plugins/types.ts` in full, so the exact type change is unverified.
- Consent decisions and the interop report are persisted through `readInteropReport` and `writeInteropReport` from `src/domains/interop/state.ts`. That module was re-exported by `src/domains/interop/index.ts` but was not read for this page.

## Things to watch when editing

- Apply depends on two fingerprints. Changing how `reviewFingerprint` or `digest` covers files, modes or omitted entries changes which edits count as drift.
- `applyLibraryImport` must keep releasing the plan in its `finally` block. Its own comment states that apply always releases the plan. The caller contract depends on this.
- `detectInteropAgents` copies consent decisions from the prior report. Dropping that copy causes declined agents to be proposed again.
- Version probes run a foreign binary. The scratch `HOME` and the timeout are the only guards in `probeVersion`, so do not widen the environment passed to it.
- `unmetRequirements` treats a same-named native package as insufficient for a vendor requirement. Relaxing that check changes the trust boundary between native and imported packages.

Related pages: the plugin library that stores installed packages is documented in [Domains plugins](plugins.md), and the trust and admission gate is covered in [Domains safety](safety.md). The CLI entry points are in [Cli](../cli.md).

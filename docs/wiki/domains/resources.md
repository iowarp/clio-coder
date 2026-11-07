---
title: "Resources: skills, prompt templates and library packages"
summary: "How Clio discovers, trusts, loads and expands skills and prompt templates, and how the library catalog and its lifecycle sit beside them. Read this before changing discovery roots, trust gates, slash-command expansion or library package handling."
sources:
  - "src/domains/resources/index.ts"
  - "src/domains/resources/loader.ts"
  - "src/domains/resources/extension.ts"
  - "src/domains/resources/skills/loader.ts"
  - "src/domains/resources/skills/catalog-view.ts"
  - "src/domains/resources/prompts/loader.ts"
  - "src/domains/resources/library.ts"
  - "src/domains/resources/library-actions.ts"
  - "src/domains/resources/library-validation.ts"
  - "src/domains/resources/library-inventory.ts"
symbols:
  - "ResourcesDomainModule"
  - "createResourcesDomainModule"
  - "createResourcesBundle"
  - "createResourcesLoader"
  - "loadSkills"
  - "defaultSkillRoots"
  - "modelVisibleSkills"
  - "skillCatalogValidity"
  - "parseSkillCommand"
  - "parsePendingSkillRequests"
  - "loadPromptTemplates"
  - "parsePromptCommand"
  - "expandPromptTemplateInput"
  - "promptTemplateDisplayText"
  - "buildSkillCatalogView"
  - "discoverLibrary"
  - "planLibraryLifecycle"
  - "validateLibraryPackage"
tests:
  - "tests/extended/prompt-display-only.test.ts"
  - "tests/contracts/skills-catalog-budget.test.ts"
invariants:
  - "A skill file larger than 1 MiB is rejected at load with a warning diagnostic and produces no skill; the file is read only up to one byte past the limit."
  - "A loaded skill is model-visible through modelVisibleSkills only when it is trusted and does not set disable-model-invocation."
  - "A prompt template from a foreign (non-Clio) root, or an imported package template that is untrusted, is not expanded; expandPromptTemplateInput returns expanded: false with a refusal that carries the reason."
  - "A prompt template marked display-only (boolean true or yes under display-only, or true under displayOnly) expands to a display payload and never to a model-bound substituted body, provided it is trusted and loaded."
  - "A prompt template whose name matches a reserved built-in slash command is dropped with a collision diagnostic, in loadPromptTemplates."
  - "Skill and prompt expansion is triggered only by a leading slash command; plain text returns unchanged, and parsePendingSkillRequests returns no pending requests."
validate:
  - "pnpm run test:file -- tests/extended/prompt-display-only.test.ts"
  - "pnpm run test:file -- tests/contracts/skills-catalog-budget.test.ts"
---

# Resources: skills, prompt templates and library packages

The resources domain is the part of Clio that finds the instructions a user or a package
supplies, decides which of them the model may see or run, and expands a typed slash command
into the text that reaches a turn. A reader needs this page when changing where skills or
prompts are read from, when a skill or template does not appear or does not expand as expected,
or when touching the library catalog and its install and validation lifecycle.

## What this area does

The domain entry is `ResourcesDomainModule` and `createResourcesDomainModule`
(`src/domains/resources/index.ts`). Both attach `createResourcesBundle`
(`src/domains/resources/extension.ts:createResourcesBundle`) as the extension factory. The bundle
builds a `createResourcesLoader` (`src/domains/resources/loader.ts:createResourcesLoader`) and
exposes it through the `ResourcesContract` methods: `skills`, `skillsForDisplay`,
`skillsStillVerified`, `parsePendingSkillRequests`, `prompts`, `promptsForDisplay`,
`expandPromptTemplate` and `reload`.

The skill trust option comes from the config domain. `createResourcesBundle` reads
`integrations.projectResources.trustProjectImports` through the `config` contract and passes it
as `trustProjectCompatRoots` for both skills and prompts (`src/domains/resources/extension.ts:skillOptions`). The
same flag gates foreign roots and untrusted imported packages in both loaders.

The loader has two read modes. `skills(cwd)` and `prompts(cwd)` read with plugin tree
verification. `skillsForDisplay` and `promptsForDisplay` pass `verifyPluginTrees: false`, so the
listing comes from the committed plugin snapshot without walking installed trees
(`src/domains/resources/loader.ts:createResourcesLoader`, the `skillsForDisplay` and
`promptsForDisplay` methods).

`src/domains/resources/loader.ts` also owns the two-step expansion path for prompts. Its
`expandPromptTemplate` method first lists templates without plugin verification and returns
early when the command name is absent from that listing. It reloads with verification only when
the name is present (`loader.ts`, `expandPromptTemplate`). Plain text without a leading slash
returns before any listing.

## Skills

### Discovery and precedence

`loadSkills` (`src/domains/resources/skills/loader.ts:loadSkills`) wraps `loadSkillsInPass` in
`withPluginDiscoveryPass`, so each installed plugin tree is verified once per catalog load.
`loadSkillsInPass` uses `input.roots` when supplied, returns no roots when `disableDiscovery` is
true, and otherwise calls `defaultSkillRoots`. It then loads every root and every
`explicitSkillPaths` entry, dedupes canonical paths, resolves collisions, sorts winners by name,
and appends requirement diagnostics (`src/domains/resources/skills/loader.ts:loadSkillsInPass`).

`defaultSkillRoots` (`src/domains/resources/skills/loader.ts:defaultSkillRoots`) returns roots from lowest to highest
precedence, as its doc comment states: plugin skills; discovery-only user compatibility roots
from the interop registry; the Clio user root under the config directory; the same agents'
project roots, also discovery-only; and the Clio project root at `.clio-coder/skills`. The
precedence constants are in `SKILL_PRECEDENCE` (`src/domains/resources/skills/loader.ts`): package 10, userCompat 20,
user 30, projectCompat 40, project 50, cli 60. Interop compatibility roots are created with
`trusted: false` and `foreign: true`. The Clio project root sets `strictContainment: true`, so a
repository whose root is a symlink cannot move the containment boundary to the link target.

A source checkout adds a narrow self-development tier inside `defaultSkillRoots`. When
`detectClioCoderRepo` finds a repository and the working directory is not its root, names owned
by installed packages are excluded before the self-development skills under
`library/skills/meta` are added. The exclusion keeps a disabled or not-yet-reloaded package's
name from being taken by a source fallback.

### Trust and model visibility

Each `Skill` carries `trusted`, `disableModelInvocation`, `source`, `scope` and `precedence`
(`src/domains/resources/skills/loader.ts`, the `Skill` interface). `loadSkillFile` sets `trusted` from
`root.trusted ?? true` and `disableModelInvocation` from the frontmatter. `modelVisibleSkills`
returns only skills where `skill.trusted && !skill.disableModelInvocation`
(`src/domains/resources/skills/loader.ts:modelVisibleSkills`). For foreign roots, `projectCompatTrusted` returns true
only when the explicit `trustProjectCompatRoots` input is true. For plugin roots the trust is
`root.trust !== "foreign" || trustProject`, so a foreign plugin root is trusted only under the
same explicit flag (`src/domains/resources/skills/loader.ts:defaultSkillRoots`).

### Size gates and the activation cap

`loadSkillFile` reads through `readRegularSkillFile`, which opens the file with `O_NONBLOCK` when
the platform defines it, refuses anything that is not a regular file, and reads at most
`MAX_SKILL_BYTES + 1` bytes (`src/domains/resources/skills/loader.ts:readRegularSkillFile`). When the read exceeds
`MAX_SKILL_BYTES`, `loadSkillFile` returns no candidate and a warning that names the size and the
limit. The same function refuses content that contains a NUL byte or is not valid UTF-8 round
trip, with a warning and no candidate. A file that loads but is larger than
`SKILL_ACTIVATION_BODY_CAP_BYTES` (50 KiB) still loads, and a warning states that activation
delivers at most that many bytes. The doc comment on `SKILL_ACTIVATION_BODY_CAP_BYTES` says it
mirrors a limit in the tool substrate and is asserted equal by a contract test. this page did not
read that contract, so that equality is unverified here.

The focused test `tests/contracts/skills-catalog-budget.test.ts` calls `loadSkills({ cwd })` and
looks up an installed skill by name. this page did not read its assertions, so the size-gate
behavior above is grounded in source only.

### Validity for the catalog

`skillCatalogValidity` (`src/domains/resources/skills/loader.ts:skillCatalogValidity`) is the rule that the library
validation path applies to a loaded `SkillList`. In order it reports `load-error` for any error
diagnostic, `collision` for any collision diagnostic, `unloadable-file` for a warning whose path
did not load, and `no-skills` for an empty list; otherwise it is valid. Its doc comment says the
CLI and the GUI both use this one rule. This page did not trace those callers, so only the
function's own ordering is described here.

### Slash-command expansion

`parseSkillCommand` (`src/domains/resources/skills/loader.ts:parseSkillCommand`) recognizes only input whose trimmed
text starts with `/skill `. It returns the first whitespace-delimited token as the name and the
trailing text as `args`.

`parsePendingSkillRequests` (`src/domains/resources/skills/loader.ts:parsePendingSkillRequests`) classifies a `/skill`
name. An installed skill that is trusted, or whose source is `plugin` or `clio-coder`, yields a
pending request with `installed: true` and its file path. A name listed by
`installedSkillNames` but not loaded yields `installed: true` with no path. A name found in
`getMarketplaceSkills` yields `source: "marketplace"` and `installed: false`. Any other name yields
`installed: false` with source `slash-command`.

The `createResourcesLoader` method `parsePendingSkillRequests` (`loader.ts`) checks
`parseSkillCommand` first and returns an empty request list for plain text, so an ordinary submit
does not load the catalog. The reserved argument `SKILL_SURFACE_CLEAR_ARG` is `"off"`
(`src/domains/resources/skills/loader.ts`). Its doc comment says `/skill off` clears a session tool surface rather than
naming a skill. The code that clears the surface is not covered on this page.

### Catalog view

`buildSkillCatalogView` (`src/domains/resources/skills/catalog-view.ts:buildSkillCatalogView`)
builds the paged and optionally filtered listing. this page read only its entry and listing
constants, not the body. The doc comments say it backs `context(scope="skills")`; that caller
and the paging details are not verified here.

## Prompt templates

### Discovery

`loadPromptTemplates` (`src/domains/resources/prompts/loader.ts:loadPromptTemplates`) uses
`input.roots` when supplied and otherwise `defaultPromptTemplateRoots`. That function adds two
kinds of root. Clio's scoped roots come from `defaultScopedResourceRoots("prompts", ...)` and are
trusted when the root is trusted or `trustProjectCompatRoots` is set. Interop user and project
prompt roots from the agent registry are added with `trusted: false` and `foreign: true`
(`src/domains/resources/prompts/loader.ts:defaultPromptTemplateRoots`).

`loadPromptRoot` walks the root with an explicit stack. It refuses a root that is a symbolic link
or not a directory, ignores symbolic links inside it, and sorts entries by name. `loadPromptFile`
accepts only `.md` files. A template's name is its path relative to the root, with path
separators replaced by `:`. A file whose path escapes the root is dropped with a warning
(`src/domains/resources/prompts/loader.ts:loadPromptFile`).

A file that exists but cannot be read, or a plugin template whose package-root references do not
resolve, is kept as an `unavailable` template rather than dropped. The refusal then carries the
reason to the operator (`src/domains/resources/prompts/loader.ts:unavailableTemplate`, `resolvePackageRootReferences`).

Frontmatter is parsed by `splitOptionalFrontmatter`. Recognized keys are `description`,
`argument-hint` or `argumentHint`, `allowed-tools`, `delegated-tools`, and `display-only` or
`displayOnly`. `booleanField` returns the flag only for a JSON boolean. The display-only test
below includes a case where the value is a string, and it is treated as unset.

Duplicate names are resolved by `resolveResourceCollisions` with a rank that favors trusted
templates and then package, config or project sources. A winner whose name is in `reservedNames`
is dropped with a collision diagnostic (`src/domains/resources/prompts/loader.ts:loadPromptTemplates`). The winners are
sorted by name.

### Expansion

`parsePromptCommand` (`src/domains/resources/prompts/loader.ts:parsePromptCommand`) trims leading whitespace, requires a
leading `/`, and rejects an empty name or a name containing `/`. It returns the name and the
remainder with one delimiter stripped after the name. A CRLF pair counts as one delimiter.

`expandPromptTemplateInput` (`src/domains/resources/prompts/loader.ts:expandPromptTemplateInput`) decides the outcome
in this order:

1. No template with that name: `expanded: false` with the input untouched.
2. `unavailable` is set: `expanded: false` with a `refusal` that carries the load-time reason.
   This check runs before the trust check.
3. Not trusted: `expanded: false` with a `refusal` and a warning diagnostic. A package template
   is told to review it and enable `integrations.projectResources.trustProjectImports`. A
   template from another agent is told to import it with `interop adopt` or `library import`.
4. `displayOnly`: `expanded: false` with a `display` payload whose text is
   `promptTemplateDisplayText(template)`.
5. Otherwise `expanded: true`, with `text` produced by `substituteArgs(template.content, args,
   command.rest)`, where `args` comes from `parseCommandArgs`.

`promptTemplateDisplayText` (`src/domains/resources/prompts/loader.ts:promptTemplateDisplayText`) returns the content of
the first fenced block when one exists, and otherwise the whole trimmed body.

`createResourcesLoader.expandPromptTemplate` (`loader.ts`) calls `expandPromptTemplateInput`
after the two-step listing described above, so an unknown command never triggers a full plugin
walk.

### Focused test

`tests/extended/prompt-display-only.test.ts` builds a package root with three templates:
`help.md` with `display-only: true` and a fenced block, `status.md` with `display-only: yes`, and
`notes.md` with `displayOnly: true` and no fence. Its first test asserts that `display-only` is
read as a boolean, that `displayOnly` is accepted, and that `display-only: yes` leaves the flag
false. Its second test calls `expandPromptTemplateInput("/materio:help  extra args", templates)`
and asserts `expanded: false`, a `display.text` equal to the fenced block, `args` equal to
`["extra", "args"]`, no `refusal`, and `text` equal to the untouched input. It asserts that
`notes` displays its whole body, and that a template without the flag expands for the model with
the argument substituted. Both assertions were read. The test file also contains a
third test that exercises the TUI reference card; that test was not read in full.

Note that the test's `status.md` case uses `display-only: yes`. The loader source
only accepts a JSON boolean for `display-only`, so the flag is false for that template. The test
asserts that outcome.

## Library packages

`discoverLibrary` (`src/domains/resources/library.ts:discoverLibrary`) reads the library catalog
and returns `LibraryEntry` records. `resolveLibraryRequirements` and `planLibraryInstall` are
also defined in `src/domains/resources/library.ts`. this page did not read their bodies, so their behavior is not
described here beyond their names.

`src/domains/resources/library-actions.ts` defines the lifecycle request and plan types. `LibraryLifecycleRequest`
carries an operation, a package reference, an optional scope and flags such as `withRequirements`
(`src/domains/resources/library-actions.ts`, the `LibraryLifecycleRequest` interface). `planLibraryLifecycle`
(`src/domains/resources/library-actions.ts:planLibraryLifecycle`) is the planner for the lifecycle operations. For
`install`, it resolves the package, classifies its requirements against the discovered catalog,
and refuses before any staging in two cases. A requirement that is inactive refuses with
`library_requirement_inactive`. A missing requirement refuses with `library_requirement_missing`
unless `withRequirements` is set. A refused plan records a step with `source.staged: false` and
no expected copies, so the plan does not fetch anything. Otherwise each unsatisfied dependency
becomes an earlier install step before the requested package. `applyLibraryLifecycle` is defined
later in the same file, but this page does not read it, so the apply ordering and its verification
are not described here.

`validateLibraryPackage` (`src/domains/resources/library-validation.ts:validateLibraryPackage`)
returns per-component records and diagnostics for a package root. The `src/domains/resources/library-actions.ts`
planner and `src/domains/resources/library.ts` call it on candidate roots. `src/domains/resources/library-inventory.ts` defines
`readLibraryInventory`, which runs inside `withPluginDiscoveryPass`, and it classifies copies.
The inventory and validation bodies were not read, so their rules are not described
here beyond these call relationships.

The public surface for these modules is re-exported from `src/domains/resources/index.ts`.

## Things to watch when editing

- Trust is decided in several places. A foreign root must stay `trusted: false`. Changing that
  requires matching changes in `projectCompatTrusted`, the `trusted` expression in
  `defaultPromptTemplateRoots`, and the refusal branches of `expandPromptTemplateInput`. Those
  three locations were read.
- Plugin verification has a display variant. `skillsForDisplay` and `promptsForDisplay` pass
  `verifyPluginTrees: false`, and `defaultSkillRoots` and `defaultPromptTemplateRoots` both
  choose the committed snapshot when that flag is false.
- `SKILL_ACTIVATION_BODY_CAP_BYTES` is documented as mirroring a constant in the tool substrate.
  Confirm that contract before changing the value.
- Slash-command names are matched exactly against the listing. Changes to `parsePromptCommand` or
  `parseSkillCommand` change which input reaches the catalog at all.

## Related pages

Skill activation after a pending request, and the tool surface a skill declares, are outside
this domain. See the [tools](../tools.md) page for the tool substrate, and the
[interactive](../interactive.md) page for where display payloads render.

## Coverage notes

Behavior described above was read from `src/domains/resources/index.ts`,
`src/domains/resources/loader.ts`, `src/domains/resources/extension.ts`,
`src/domains/resources/skills/loader.ts` (the root, trust, size-gate, validity and slash-command
functions), `src/domains/resources/prompts/loader.ts` (root discovery, file loading, display and
expansion), the entry of `src/domains/resources/skills/catalog-view.ts`, the lifecycle request and
planner in `src/domains/resources/library-actions.ts`, and the type declarations of
`src/domains/resources/library.ts` and `src/domains/resources/library-validation.ts`. The bodies of
`discoverLibrary`, `resolveLibraryRequirements`, `planLibraryInstall`, `applyLibraryLifecycle`,
`validateLibraryPackage`, `readLibraryInventory`, and the catalog-view body were not read in this
pass.

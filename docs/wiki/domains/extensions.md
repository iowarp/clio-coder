---
title: "Extension domain: packages, runtimes, and authoring"
summary: "How Clio discovers, validates, installs, and runs extension packages, and how the authoring commands scaffold, validate, and test a package. Read this to find the owner of a manifest, a runtime process, a dev-folder load, or an authoring command."
sources:
  - "src/domains/extensions/index.ts"
  - "src/domains/extensions/discovery.ts"
  - "src/domains/extensions/operator-runtime.ts"
  - "src/domains/extensions/operator-runtime-v2.ts"
  - "src/domains/extensions/runtime-process-v2.ts"
  - "src/domains/extensions/runtime-schema-v2.ts"
  - "src/domains/extensions/state.ts"
  - "src/domains/extensions/dev-scope.ts"
  - "src/domains/extensions/authoring/scaffold.ts"
  - "src/domains/extensions/authoring/validate.ts"
  - "src/domains/extensions/authoring/test-runner.ts"
  - "src/domains/extensions/authoring/test-api.ts"
  - "src/cli/extensions-authoring.ts"
symbols:
  - "ExtensionsDomainModule"
  - "parseExtensionManifest"
  - "discoverExtensionPackages"
  - "OperatorExtensionRuntime"
  - "OperatorExtensionRuntimeV2"
  - "ExtensionRuntimeProcessV2"
  - "parseExtensionRuntimeV2"
  - "installExtension"
  - "ExtensionDevScope"
  - "scaffoldExtension"
  - "validateExtensionPackage"
  - "testExtensionPackage"
tests:
  - "tests/contracts/safety-gates.test.ts"
invariants:
  - "A manifest with a runtime api of 2 is parsed by parseExtensionRuntimeV2; any other runtime value is parsed as the legacy runtime shape."
  - "A replaces: prompt command without a plugin field is a manifest error, so the diagnostic is raised at parse time."
  - "scaffoldExtension refuses a target that exists as a non-directory, a symbolic link, or a non-empty directory."
  - "validateExtensionPackage runs the registration check only when discovery is valid and the manifest declares a runtimeV2 block; otherwise registration is reported as skipped."
  - "validateExtensionPackage runs startup code in a private scratch copy and disposes the child process and scratch directory in a finally block; it does not invoke activation or handlers."
  - "A dev-folder package is loaded from a private copy and waits for operator approval of its capability envelope; an envelope that grows requires fresh approval."
  - "The safety policy asks for library-confirm on clio-coder extensions test and clio-coder extensions validate, and it keeps clio-coder extensions install blocked."
validate:
  - "pnpm run test:file -- tests/contracts/safety-gates.test.ts"
  - "pnpm run typecheck"
---

# Extension domain: packages, runtimes, and authoring

This page covers the extension domain under `src/domains/extensions`: how an extension package is discovered and its manifest parsed, how the operator runtime starts and reloads extension processes, how the v2 runtime schema and process are structured, how installs and dev-folder loads are tracked, and how the `extensions init`, `validate`, and `test` commands work. A reader needs it when changing a manifest field, a runtime lifecycle, or an authoring command.

This page describes the authoring workflow and the parsing and lifecycle entry points in depth. The v2 process request protocol, the dev-scope consent state machine, and the install record format were read only at the outline and entry level; they are described here at that depth and are not traced line by line.

## What the area does

The domain exposes `ExtensionsDomainModule` from `src/domains/extensions/index.ts`, which binds `ExtensionsManifest` and `createExtensionsBundle` into the domain loader. The index file re-exports the public surface: manifest parsing and discovery, install and enable helpers, the v2 envelope and digest helpers, snapshot builders, and the hook bridge.

Discovery and manifest parsing live in `src/domains/extensions/discovery.ts`. `parseExtensionManifest` takes an untrusted value and a manifest path and returns `{ manifest?, diagnostics }`. It rejects a non-object, validates `id`, `version`, and `description`, and checks the optional `plugin` field. When `runtime.api` is `2` it calls `parseExtensionRuntimeV2`; otherwise it calls `parseExtensionRuntime`. It validates `capabilities` and `compatibility.clio` semver. If any diagnostic is an error, it returns no manifest. A manifest whose `runtimeV2` declares a `prompt` replacement without a `plugin` field is a manifest error, and a manifest whose `compatibility.clio` range is not satisfied by the running version is also an error.

`src/domains/extensions/runtime-schema-v2.ts` owns the v2 runtime declaration. `parseExtensionRuntimeV2` accepts only the keys listed in its `record` call (`api`, `entrypoint`, `commands`, `events`, `watch`, `hooks`, `tools`, `ui`, `workspaces`, `access`, `permissions`, `state`, `services`, `config`), requires `api` to equal `2`, requires `entrypoint` to end in an allowed suffix, and rejects a `watch` glob listed twice. Related exports `capabilityEnvelope`, `envelopeDigest`, `envelopeGrowth`, and `RUNTIME_V2_LIMITS` build the capability envelope that operators approve.

## Operator runtime

`OperatorExtensionRuntime` in `src/domains/extensions/operator-runtime.ts` owns the operator-side extension processes. Its header comment states it is used only for operator processes and never by native workers or model tool bootstrap. Its constructor takes `OperatorRuntimeOptions`, which supplies a `context()` snapshot provider, an `isIdle()` predicate, an optional `list` function, and callbacks `onChange`, `onReload`, and `commitHooks`. When `frozenTools` is provided, the constructor records a map from extension id to a provenance key, so tool ownership is fixed from the existing registry. `maintenanceDelayMs` returns `null` while the runtime is closed or reloading, which means no timer or filesystem work is scheduled without active runtimes or a queued reload.

`OperatorExtensionRuntimeV2` in `src/domains/extensions/operator-runtime-v2.ts` is the v2 variant. It is declared as `class OperatorExtensionRuntimeV2` with a `reload(reason)` method that delegates to `performReload`, a `spawn` method that creates an `ExtensionRuntimeProcessV2`, and an `ensure` method that starts a process on demand. The file also defines the `ExtensionHookOutcome` type and a `SESSION_CLOSE_MS` bound used when a session closes. The detailed reload ordering inside `performReload` was not traced.

`ExtensionRuntimeProcessV2` in `src/domains/extensions/runtime-process-v2.ts` is the per-extension process wrapper. Its constructor takes an extension and `RuntimeProcessV2Options`, which carries a snapshot, the resolved options, a key-value host, a store directory, and an optional `unixSockets` mode. Its public methods include `activate`, `updateSnapshot`, `command`, `observe`, `hook`, `tool`, `action`, `interview`, and `dispose`. The `staged` promise is awaited by the validation path below. `runtimePermissionArgs` builds the Node permission arguments from the declared permissions and roots. `ExtensionRequestTimeout` is the error raised when a request to the process times out. The request and reply protocol inside the class was outlined but not read line by line.

## State, installs, and dev folders

`src/domains/extensions/state.ts` owns the install record and the on-disk inventory. Its exports include `extensionBaseDir`, `readExtensionInstallRecord`, `listInstalledExtensions`, `listInstalledExtensionRecords`, `installExtension`, and `enableExtension`. `installExtension(sourcePath, options)` is the entry that copies a package into the install store and returns an `ExtensionInstallResult`. The internal copy and digest steps were not read.

`ExtensionDevScope` in `src/domains/extensions/dev-scope.ts` loads packages from `.clio-coder/dev/extensions` in the workspace (`DEV_EXTENSIONS_DIR`). The class comment states that each refresh copies a changed folder to a private directory and loads the copy, that a package loads only after the operator approves its capability envelope for the session, and that a package whose envelope grows requires fresh approval. The class comment also states that nothing here is persisted and that only the terminal constructs one. The `DevConsentRequest` and `DevExtensionStatus` types define what the host asks and reports. The implementation of the approval state machine was outlined but not traced line by line.

## Authoring commands

The authoring commands are dispatched by `runExtensionsAuthoring` in `src/cli/extensions-authoring.ts`. The command accepts `init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]`, `validate <path> [--json]`, and `test <path>`. It rejects an unknown argument, a missing positional, and a repeated flag with exit code `2` and the help text. Each subcommand then calls one authoring module.

`init` calls `scaffoldExtension` in `src/domains/extensions/authoring/scaffold.ts`. The function validates the id by passing it through `parseExtensionManifest` with a synthetic manifest, rejects an unknown template name against the fixed list `status`, `hook`, `panel`, `tool`, and `workspace`, and resolves the target directory. The default target is `.clio-coder/dev/extensions/<id>` under the working directory. It refuses a target that exists as a non-directory, a symbolic link, or a non-empty directory. It reads every file under the template directory `src/domains/extensions/authoring/templates/<template>`, replaces every `__EXTENSION_ID__` token with the id, and adds a generated `package.json` and `tsconfig.json`. The `tsconfig.json` maps `@iowarp/clio-coder/extensions` and `@iowarp/clio-coder/extensions/testing` to the installed public API and test API files. Each file is written with `safeResourceWrite`.

The template directory includes `status`, `hook`, `panel`, `tool`, and `workspace`, each with a `runtime` subdirectory holding an extension entry file and a test file. The `hook` template's entry file registers a `protect` command that stores paths in the key-value store and a `before_tool` hook that returns a `block_tool` effect for `write` and `edit` calls to a protected path. The `status` template's test, `src/domains/extensions/authoring/templates/status/runtime/extension.test.ts`, uses `createExtensionTestHost` from the testing entry point, runs the `status` command and asserts the text `__EXTENSION_ID__: 0 ticks`, then calls `tick` and `advance(10000)` and asserts the stored `ticks` value is `3` and `host.now` is `10000`.

`validate` calls `validateExtensionPackage` in `src/domains/extensions/authoring/validate.ts`. It loads the manifest with `loadManifestFromRoot`, computes a capability envelope and its digest when the manifest declares `runtimeV2`, and sets `registration.status` to `skipped` when discovery is invalid or no v2 runtime is declared. Otherwise it builds an `ExtensionRuntimeProcessV2` for a copy of the package inside a scratch directory, with `mode: "headless"` and the manifest's config defaults, and awaits `child.staged`. A success records `registration.status` as `passed` with the actions and interviews the child reported. A thrown error sets `valid` to `false` and records a `registration:` diagnostic. The `finally` block disposes the child and removes the scratch directory. The `unixSockets` option is passed from the CLI as the operator's `safety.sandboxUnixSockets` setting. The report always carries `EXECUTION_NOTICE`, which states that registration executes the package's startup code and that permissions are not a boundary against hostile code.

`test` calls `testExtensionPackage` in `src/domains/extensions/authoring/test-runner.ts`. It collects every file matching the glob `**/*.test.ts` under the package root, excluding paths that contain `node_modules` or `.git`, and fails with the message `no **/*.test.ts files in <path>` when none exist. It then runs `node` with `--experimental-strip-types`, the `src/domains/extensions/authoring/test-register.mjs` import, and `--test` over those files, through `runCommandVector` with a 120000 ms timeout and the operator's config, data, state, and cache directories. The exit code is returned to the CLI.

`src/domains/extensions/authoring/test-api.ts` is a type-only declaration of `createExtensionTestHost`, `ExtensionTestHost`, and `ExtensionTestOptions`. Its comment states that the running install supplies the implementation. `src/domains/extensions/authoring/test-clock.ts` provides `createTestClock`, which wraps `globalThis.Date` through an `AsyncLocalStorage` so that each host sees its own clock. The clock is reference-counted: the original `Date` is restored only when the last user disposes.

## Callers and dependencies

The authoring module is imported by `src/cli/extensions-authoring.ts`, and that file is the only importer of `src/domains/extensions/authoring/scaffold.ts`, `src/domains/extensions/authoring/test-runner.ts`, and `src/domains/extensions/authoring/validate.ts` found by the code map. The index module `src/domains/extensions/index.ts` is imported by a broad set of callers, including `src/cli/extensions.ts`, `src/entry/orchestrator.ts`, `src/entry/extension-runtime-hooks.ts`, and `src/interactive/interactive-application.ts`. Those are import edges; the call sites were not traced.

Downstream, the authoring path depends on `src/domains/extensions/discovery.ts` for manifest parsing, `src/domains/extensions/runtime-process-v2.ts` for the registration check, `src/domains/extensions/integrity.ts` for the content digest, `src/core/safe-resource-write.ts` for writes, and `src/core/safe-exec.ts` for the test subprocess.

## Enforced boundaries

Manifest validation is strict and happens before any runtime is constructed. The v2 schema rejects unknown keys in the runtime block, and `parseExtensionManifest` returns no manifest when any error diagnostic is raised. The validation path requires discovery to be valid before it reads the runtime declaration or starts a child.

The validation path never invokes activation or handler code; it awaits only the child's staged promise. The execution notice is always attached to the report, including on failure.

The safety policy treats the authoring commands as a confirmed action. The test `asks before a share import or package code runs, and keeps an extension install blocked` in `tests/contracts/safety-gates.test.ts` evaluates the commands `clio-coder extensions test ./draft-extension` and `clio-coder extensions validate ./draft-extension`. For each it asserts that the decision kind is `ask` with reason `library-confirm`, and that a confirmed evaluation returns `allow`. The same test asserts that `clio-coder extensions install ./draft-extension` is blocked. This test checks the policy classification only; it does not run the authoring commands.

No focused test in the repository was found that exercises `scaffoldExtension`, `validateExtensionPackage`, or `testExtensionPackage` directly. The search covered the `tests` directory for those symbol names and for the `extensions init`, `validate`, and `test` command strings. The only matches were the safety-gate assertions above and the template test files, which are shipped inside `src/domains/extensions/authoring/templates` and are not run by the repository's test glob as far as was checked.

## Extension seams

A new authoring template is added by creating a directory under `src/domains/extensions/authoring/templates/<name>/runtime` and adding the name to the `TEMPLATES` list in `src/domains/extensions/authoring/scaffold.ts`. The `init` help text in `src/cli/extensions-authoring.ts` lists the template names and would need the same update. New manifest fields are parsed in `parseExtensionManifest` in `src/domains/extensions/discovery.ts`, and new v2 runtime fields are added to the `record` key list and the parser in `src/domains/extensions/runtime-schema-v2.ts`.

## Things to watch when editing

- `parseExtensionManifest` returns the manifest only when there are no error diagnostics. A new field that produces a warning rather than an error does not block the manifest.
- The `scaffoldExtension` template files and the generated `tsconfig.json` depend on `resolvePackageRoot` to locate the installed templates and public API files. The tests of the template files run under the package's own test runner, not under the authoring test runner.
- The registration check starts package code. Changes to `validateExtensionPackage` should keep the `finally` cleanup and the notice text intact.
- Changes to the safety-gate classification of the authoring commands are checked by `tests/contracts/safety-gates.test.ts`. A change to the command names in `src/cli/extensions-authoring.ts` needs the matching change in that test, which uses the literal command strings.
- The dev-scope and runtime-process protocols were not traced. Changes to those files need a read of their full request and approval paths first; this page does not describe them in detail.

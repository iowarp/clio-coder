---
title: "Lifecycle: migrations, install detection, and update checks"
summary: "How Clio Coder's lifecycle domain applies versioned state migrations once per home, detects how the install was made, checks for and defers updates, and reports doctor findings. Read this before adding a migration or changing upgrade behavior."
sources:
  - "src/domains/lifecycle/migrations/index.ts"
  - "src/domains/lifecycle/migrations/registry-ids.ts"
  - "src/domains/lifecycle/boot-migrations.ts"
  - "src/domains/lifecycle/migrations/2026-09-01-settings-v2.ts"
  - "src/domains/lifecycle/install-method.ts"
  - "src/domains/lifecycle/update-check.ts"
  - "src/domains/lifecycle/doctor.ts"
  - "src/domains/lifecycle/index.ts"
symbols:
  - "runPending"
  - "listMigrations"
  - "readMigrationManifestResult"
  - "applyPendingMigrationsAtBoot"
  - "Migration"
  - "MigrationReport"
  - "SettingsV2CollisionError"
  - "migrateSettingsV1Document"
  - "readInstallerRecord"
  - "inspectInstallation"
  - "createUpdateCheck"
  - "UPDATE_CHECK_INTERVAL_MS"
tests:
  - "tests/extended/settings-migration.test.ts"
  - "tests/contracts/lifecycle-safety.test.ts"
invariants:
  - "A migration id recorded in the applied manifest is not run again by runPending for that state tree. Each id is written to the manifest after its up() returns, so an earlier success survives a later failure."
  - "A manifest that is over 1 MiB, not a JSON object, has a key other than applied, has a non-array or empty-id applied list, or has duplicate ids is refused: runPending throws before any up() runs and the file is not replaced."
  - "A settings v1 document whose v1 keys collide with their v2 destinations is refused with SettingsV2CollisionError, and the settings.yaml file and its .v1.bak backup are not written."
  - "The settings v2 migration returns without rewriting when settings.yaml already parses to version 2, and a second run on a migrated file leaves the bytes unchanged."
validate:
  - "pnpm run test:file -- tests/extended/settings-migration.test.ts"
  - "pnpm run test:file -- tests/contracts/lifecycle-safety.test.ts"
---

# Lifecycle: migrations, install detection, and update checks

The lifecycle domain under `src/domains/lifecycle/` handles what happens to a
Clio Coder home between versions. A reader needs this page when a change
alters on-disk state shape, when `clio-coder upgrade` or post-install behavior
is involved, or when the install method and update check affect a command.
Its main parts are the migration runner, the boot-time caller of that runner,
the settings v1 to v2 migration, the install-method detector, the update check,
and the doctor finding that reports migration state.

This page covers the parts inspected for this revision. The deferred update
wrapper (`src/domains/lifecycle/deferred-update.ts`), `src/domains/lifecycle/canonical-names.ts`,
and the other migrations under `src/domains/lifecycle/migrations/` are described
only at the level of their exported names or not at all. Their behavior is not
explained here.

## Migration runner

`src/domains/lifecycle/migrations/index.ts` owns the migration contract. A
`Migration` has an `id` and an `up(stateDir)` that returns nothing or a
`MigrationReport` with `changed` and `attention` lists. The registry is a
static, frozen array (`REGISTRY`) in that file, not discovered from the
filesystem. At module load the file throws if `REGISTRY` does not match
`REGISTERED_MIGRATION_IDS` from `src/domains/lifecycle/migrations/registry-ids.ts`
in order and length. The header comment states that registry order is
deliberately not id order: a settings repair must run before any migration
that reads settings through the strict reader. The current registry places
`settingsV2` first.

`runPending(stateDir, migrations = REGISTRY)` is the entry point. Its flow,
as read in `migrations/index.ts`:

1. It takes `withStateFileLock` on the manifest path from `migrationManifestPath()`.
2. It reads the manifest with `readManifest`, from the config-location path if
   that file exists, otherwise from the legacy state-root path. If the
   manifest is in the legacy location and the config-location file does not
   yet exist, it is written to the config location, and the legacy file is
   removed.
3. If `readManifest` returns a `problem`, `runPending` throws that problem
   and runs no migration.
4. For each migration not already in the applied set, it awaits `up()`, adds
   the id, and writes the manifest immediately. The code comment records that
   writing after each `up()` prevents a later failure from re-running earlier
   migrations.
5. A non-empty report is appended through `appendMigrationNotice`, so the
   report survives a process that drops child stdout.
6. The function writes the final manifest and returns `applied` (new ids this
   call), `allApplied`, `available` (every id in the list it was given), and
   `reports` keyed by id.

`readMigrationManifestResult(stateDir)` is the read-only variant used by
`doctor`. It reads the config-location manifest when present, otherwise the
legacy one, and it does not write or move anything. `readManifest` rejects a
file over `MIGRATION_MANIFEST_MAX_BYTES` (1 MiB), a non-object root, any key
other than `applied`, a non-array `applied`, empty ids, and duplicate ids.
Each rejection returns a `problem` string rather than throwing; only
`runPending` converts a problem into a thrown error.

Focused tests in `tests/extended/settings-migration.test.ts`:

- `moves a state-root manifest to the config root without replaying what it records`
  writes `{"applied":["recorded"]}` under the state root, calls `runPending`
  with a migration whose id is `recorded`, and asserts that `applied` is
  empty, that the migration's `up` was never called, that the legacy file is
  gone, and that the config-root manifest holds `["recorded"]`.
- `refuses a corrupt migration manifest instead of replaying user-data changes`
  writes `{"applied":["once","once"]}` and asserts that
  `readMigrationManifestResult(stateDir).problem` mentions "duplicate", that
  `runPending` rejects with a message matching `cannot be trusted.*duplicate`,
  that `up` is never called, and that the manifest file is unchanged.
- `serializes concurrent migration runners and records a migration once` runs
  two `runPending` calls concurrently against one migration whose `up` waits
  20 ms. It asserts `up` ran once, that the combined `applied` lists contain
  the id once, and that the manifest mode is `0o600` on non-Windows platforms.
- `orders migrations before strict readers and records each migration once`
  asserts the exact registry order (settings v2 first, then the retired-panes
  knob migration, then the others), and that a second `runPending` call
  returns an empty `applied` list.

## Boot-time application

`src/domains/lifecycle/boot-migrations.ts` exports `applyPendingMigrationsAtBoot`.
Its source comment says it exists because a background update installs with
`--no-post-install`, so the first launch of the new version must run pending
migrations itself. The function returns early when the config-location
manifest exists and already lists every id in `REGISTERED_MIGRATION_IDS`. If
no config-location manifest exists and no legacy manifest exists, it also
returns. Otherwise it dynamically imports `src/domains/lifecycle/migrations/index.ts` and calls
`runPending(stateDir)`. A thrown error is pushed to the module's notice list
as a message telling the operator to run `clio-coder upgrade --post-install`.
Reports from applied migrations are pushed as notices unless `interactive` is
true. `takeBootMigrationNotices` returns and clears that list.
`takePendingMigrationNotices` reads the file-based notices written by
`appendMigrationNotice`, under a state-file lock with a 50 ms timeout, and
removes the file once read.

Callers, found by search and inspected at the call line: `src/cli/clio.ts`
invokes `applyPendingMigrationsAtBoot()` with no argument, and
`src/entry/orchestrator.ts` imports it with `takeBootMigrationNotices` and
`takePendingMigrationNotices` and calls it with an `interactive` argument. The
`upgrade` command in `src/cli/upgrade.ts` calls `deps.runPending(stateDir)`
directly at line 829 of that file.

## Settings v1 to v2 migration

`src/domains/lifecycle/migrations/2026-09-01-settings-v2.ts` is the first
registered migration. Its id is `SETTINGS_V2_MIGRATION_ID`, `2026-09-01-settings-v2`.
The exported `migrateSettingsV1Document(raw)` is a pure transform. It rejects a
non-map root and any `version` other than 1 or absent, then clones the
document and moves keys with a table of `[from, to, valueTransform]` entries
using the dot-path helpers `getPath`, `setPath`, and `deletePath`. It also
drops a fixed set of keys (`identity`, `background.thinkingLevel`, `theme`,
`compaction.excludeLastTurns`, and the remaining `panes` tree), and calls
`migrateFleetNodeAliases` and `dropRetiredExternalAgentKeys`.

If any move's destination already exists, `move` records a collision and
leaves the source in place. After all moves, a non-empty `collisions` list
causes `SettingsV2CollisionError` to be thrown, with a message stating the
original `settings.yaml` was left untouched. Otherwise the function sets
`version` to 2 and runs `validateSettings` from `src/core/config.ts`; any
validation issue throws `SettingsValidationError`.

The migration's `up` method runs inside `withSettingsLock`. It returns when the
file is absent, and returns without writing when the parsed document already
has `version: 2`. Otherwise it writes the transformed YAML through
`safeResourceWrite` with a `.v1.bak` backup at `${path}.v1.bak`, then writes a
JSON report named `<migration id>.json` under `migration-reports/` in the state
directory. A parse failure throws before any write.

Focused tests in `tests/extended/settings-migration.test.ts`:

- `migrates v1 atomically, keeps the original backup, and is idempotent` writes
  a v1 file with `orchestrator`, `workers.default`, and `targets`, runs
  `settingsV2.up`, and asserts the `.v1.bak` equals the original text,
  `version` is 2, `chat` equals `{ target: "local", model: "qwen" }`, and
  `fleet.default` carries the moved `thinkingLevel`. A second `up` call leaves
  the file bytes unchanged.
- `carries only explicit v1 pane choices into v2` asserts that a v1
  `panes.enabled: auto` and `panes.yazi.enabled: true` migrate to
  `interface.panes` with `enabled` `auto` and `files.enabled` true, while an
  absent layout defaults to `off`.
- `refuses a v1/v2 collision without replacing or backing up the file` writes
  `orchestrator: { target: old }` alongside `chat: { target: new }`, expects
  `settingsV2.up` to reject with `SettingsV2CollisionError`, and asserts the
  file is unchanged and no `.v1.bak` exists.

Two other focused tests call `migrateSettingsV1Document` directly rather than
`up`: `tests/contracts/retired-settings-keys.test.ts` and
`tests/contracts/autonomy-settings.test.ts`. Their assertions were not read
for this page.

## Install-method detection

`src/domains/lifecycle/install-method.ts` decides how Clio Coder was installed,
so lifecycle verbs do not offer the wrong upgrade path. Its header comment
says a source checkout must never be offered the npm-global reinstall path.

`sourceCheckoutRoot(entryPath)` resolves `process.argv[1]` with `realpathSync`
and returns the checkout root only when the resolved entry is the built CLI
entry point under the package's `dist/cli` output directory (the source joins
the `dist`, `cli`, and `index.js` segments), the path does not include a `node_modules` segment, the `package.json` at the
root is named `@iowarp/clio-coder`, and the root has a `.git` directory or
`src/cli/index.ts`. Any failed check returns null.

`inspectInstallation(entryPath, fallbackRoot)` returns an `Installation` with
a `kind` from the union `source`, `npm`, `pnpm`, `bun`, `installer`,
`homebrew`, `winget`, `local`, or `unknown`. The order of checks is: package
name, source checkout, Homebrew `Cellar` segments, npm layout
(`lib/node_modules/@iowarp/clio-coder` under a prefix), pnpm global layout,
bun global layout, and finally a `node_modules` segment for `local`. When an
npm-layout prefix sits under `<install root>/versions/<version>` and
`readInstallerRecord` finds a manifest, the kind is `installer`, or `winget`
when the record's manager is `winget` and `CLIO_CODER_MANAGER_UNINSTALL` is not
`1`.

`readInstallerRecord(installRoot)` parses `install.json`. It accepts `schema`
1 or 2 only, requires `kind` to equal `INSTALLER_MANIFEST_KIND`
(`clio-coder-installer`), and requires that `current` lies under `versions/`
and `node` lies under `runtime/`. A `previous` value is checked the same way
when present. Any failed check returns null. `defaultInstallRoot` honors
`CLIO_CODER_INSTALL_DIR`, then `CLIO_CODER_HOME/install`, then a platform
default.

Consumers of this module include `npmInstallArgs` and `npmUpgradeInvocation`,
which refuse anything other than an identified npm installation, and
`installationCommand`, which renders the upgrade or uninstall command for a
given kind. The focused test `self-upgrade plans automatic replacement only
for a newer npm release` in `tests/contracts/lifecycle-safety.test.ts` builds
an `npm` installation and checks that the self-upgrade planner reports
`available` for a newer version and `manual` for a `pnpm` kind without a
registry call. This test was located by search and its exact assertions were
not read for this revision; the description above is from the test name and
should be treated as unverified detail.

## Update check

`src/domains/lifecycle/update-check.ts` defines the cache and notice model.
`UPDATE_CHECK_INTERVAL_MS` is 24 hours, and `UPDATE_NOTICE_INTERVAL_MS` is
seven of those intervals. The cache file is named with an `update-` prefix and the fingerprint, with a
`.json` suffix, in
`cacheDir`, where `updateFingerprint` is the first 16 hex characters of a
SHA-256 over the installer root (or install root when there is no installer
record). The cache holds `checkedAt`, `available`, `availableTag`, `track`,
the install lease fields (`updateAttemptedAt`, `updatePid`, `updateHost`,
`updateBirth`, `updateLeaseMs`), `lastUpdate`, and `deferredWait`.
`UpdateNotice.kind` is one of `available`, `replaced`, `failed`, or `updated`,
with optional `install` (start a native background install) and `defer` (hand
a package-manager install to a wrapper) flags.

`createUpdateCheck(options)` does no work at construction; its probes are
started by the interactive owner. Its cache reads and writes use atomic
rename through a temporary file, and `readCache` ignores a cache file over
16 KiB. The install lease blocks concurrent background installs. `leaseLive`
treats a lease as held only while it is younger than `updateLeaseMs` (or
`INSTALL_LEASE_MS`, the native installer timeout plus one minute) and its
holder pid is alive on this host, with birth-token comparison through
`leaseHolderAlive`. A lease held by another host is treated as live until it
expires. `settledToday` applies the day-long back-off only after a run for
the exact version has settled, so an interrupted run is retried.

`readDeferredWait` returns a deferred wait only when it names a version newer
than the running one and is less than a day old. `readLastBackgroundUpdate`
returns the newest `lastUpdate` record when it has numeric `at` and boolean
`ok`. Both are consumed by `doctor`.

The focused update tests are in `tests/contracts/update-check.test.ts`. That
file was located by search and was not read for this page, so its cases are
not described here.

## Doctor and the exported surface

`src/domains/lifecycle/doctor.ts` builds the `lifecycle migrations` finding at
about line 666. It calls `readMigrationManifestResult(dirs.state)`, lists the
registered ids with `listMigrations()`, and treats ids as satisfied without a
manifest record when the current settings are valid and the id is one of
`2026-09-01-settings-v2` or `2026-09-01-retire-panes-knobs`. The finding is
`ok` with a warning level only when there is a problem-free manifest and at
least one pending id. Its detail shows the problem text on a refused manifest,
the count of unrecorded-but-satisfied ids, or the pending ids with the
`clio-coder upgrade --post-install` hint.

The focused test `doctor distinguishes satisfied settings migrations from
pending work without writing receipts` in `tests/extended/settings-migration.test.ts`
writes a manifest that records every registered id except the two settings
ids, then sets `settings.yaml` to `version: 2`. It asserts the finding is `ok`,
with no level, and that the detail includes `already satisfy 2 unrecorded`.
It then checks that `version: 1`, `version: 2` with `panes: { agents: off }`,
and an unparseable YAML document each produce a `warn` finding whose detail
includes "pending". The test asserts that neither the manifest nor the
settings file is rewritten.

`src/domains/lifecycle/index.ts` re-exports `runDoctor`, `formatDoctorReport`,
the migration API (`listMigrations`, `runPending`, `readMigrationManifestResult`
and the `Migration`, `MigrationManifest`, `MigrationRunResult` types),
`planSelfUpgrade`, `runApprovedSelfUpgrade`, the state helpers, the upgrade
notice helper, and version info. The `src/domains/lifecycle/self-upgrade.ts`
file is re-exported but was not read for this page.

## Extension seams

To add a migration, follow the header in `migrations/index.ts`: author a file
under `src/domains/lifecycle/migrations/` named `YYYY-MM-DD-<slug>.ts` with a
default export matching the `Migration` contract, import it, insert it into
`REGISTRY` at the position its ordering requires, and add its id to
`REGISTERED_MIGRATION_IDS` in `src/domains/lifecycle/migrations/registry-ids.ts` at the same position. The
module throws at load if those two lists disagree in order or length. A
migration that writes `settings.yaml` should hold `withSettingsLock` and
land its write through `safeResourceWrite`, as the settings v2 migration does.

## Things to watch when editing

- Registry order is not id order. A migration that repairs settings must sit
  before any migration that reads settings through the strict reader. The
  header comment in `migrations/index.ts` says so, and settings v2 is first in
  `REGISTRY`.
- The manifest is written after each successful `up()`. The comment in
  `runPending` explains that this is what keeps earlier successes from
  re-running after a later failure; moving the write to the end of the loop
  changes that behavior.
- A corrupt manifest is refused, not replaced. `readManifest` returns a
  `problem`, and `runPending` throws before any `up()` runs.
- Retired migration ids (the naming migration and the runtime-id migrations)
  are not in `REGISTRY`. The header says that an id with no registered
  migration is inert in the manifest.
- `applyPendingMigrationsAtBoot` short-circuits only when every registered id is
  present in the config-location manifest. A new registered id therefore
  causes a `runPending` call on the next boot.
- The doctor's satisfied-id list is hardcoded in `src/domains/lifecycle/doctor.ts`. A new migration
  whose effect is already visible in settings must be added there by hand if
  the operator should not see it as pending.

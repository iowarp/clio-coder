import { accessSync, chmodSync, constants, type Dirent, existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDevVersion, readClioVersionLabel } from "../../core/build-info.js";
import { formatSettingsIssues, readSettings, validateSettingsFile } from "../../core/config.js";
import { initializeClioHome } from "../../core/init.js";
import { readLayeredSettings } from "../../core/settings-layers.js";
import { repairSettingsCoercions, type SettingsRepairResult } from "../../core/settings-repair.js";
import { clioDirLayoutProblems, resolveClioDirs } from "../../core/xdg.js";
import { readSessionFileEntries, type SessionJsonlWarning } from "../../engine/session.js";
import { detectInteropAgents, interopAgentKind, resolveOnPath } from "../interop/index.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../providers/auth/index.js";
import { credentialsPresent } from "../providers/credentials.js";
import { fingerprintNativeRuntime } from "../providers/probe/fingerprint.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { loadSkills, type SkillSource } from "../resources/skills/loader.js";
import { isSessionEntry, type SessionEntry } from "../session/entries.js";
import { foldPromptCacheTelemetry, hasPromptCacheTelemetry, topExpectedColdReason } from "../session/prompt-cache.js";
import { type Installation, inspectInstallation } from "./install-method.js";
import { listMigrations, readMigrationManifestResult } from "./migrations/index.js";
import { readStateInfoResult } from "./state.js";
import { getVersionInfo } from "./version.js";

/** `info` reports a fact that needs no action, such as an optional tool that is absent. */
export type DoctorLevel = "ok" | "info" | "warn" | "error";

export interface DoctorFinding {
	ok: boolean;
	name: string;
	detail: string;
	level?: DoctorLevel;
}

export interface DoctorOptions {
	fix?: boolean;
}

/** Settings and credentials are owner read/write files; any group or other bit, or an owner execute bit, is wider. */
const OWNER_ONLY_EXTRA_BITS = 0o177;

function isWiderThanOwnerOnly(mode: number): boolean {
	return (mode & OWNER_ONLY_EXTRA_BITS) !== 0;
}

/**
 * Tighten `path` to 0600 when it is wider, leaving a stricter mode such as
 * 0400 alone. Returns the mode it replaced, or null when nothing changed.
 * POSIX modes carry no meaning on Windows, so the check does not run there.
 */
function tightenToOwnerOnly(path: string): number | null {
	if (process.platform === "win32" || !existsSync(path)) return null;
	const mode = statSync(path).mode & 0o777;
	if (!isWiderThanOwnerOnly(mode)) return null;
	chmodSync(path, 0o600);
	return mode;
}

const FOREIGN_SKILL_SOURCES = new Set<SkillSource>(["agents", "claude", "codex", "copilot", "opencode"]);

function describeNodeType(stats: Stats): string {
	if (stats.isFile()) return "a regular file";
	if (stats.isSymbolicLink()) return "a symlink";
	if (stats.isFIFO()) return "a FIFO";
	if (stats.isSocket()) return "a socket";
	if (stats.isBlockDevice() || stats.isCharacterDevice()) return "a device node";
	return "not a directory";
}

/**
 * One of Clio's four roots. `existsSync` alone was reporting OK for anything at
 * the path, so `touch $CLIO_CODER_CACHE_DIR` produced a green report and exit 0 while
 * `clio-coder doctor --fix` one command later died on "Expected directory". A root
 * has to be a directory Clio can actually traverse and write, and the remedy
 * differs by failure: `--fix` creates a missing root but cannot move a file out
 * of the way or widen a mode, so the row says which one is needed.
 */
function directoryFinding(name: string, path: string): DoctorFinding {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return { ok: false, name, detail: `${path} missing (run \`clio-coder doctor --fix\`)` };
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, name, detail: `${path} cannot be inspected: ${message}` };
	}
	if (!stats.isDirectory()) {
		return {
			ok: false,
			name,
			detail: `${path} is ${describeNodeType(stats)}, not a directory (move it aside, then run \`clio-coder doctor --fix\`)`,
		};
	}
	// Named one bit at a time. A single combined access() check reported the same
	// string for a mode-555 root as for a mode-000 one, which told the operator
	// the row was unhappy without telling them what to change.
	const missing = (
		[
			["readable", constants.R_OK],
			["writable", constants.W_OK],
			["traversable", constants.X_OK],
		] as const
	)
		.filter(([, bit]) => {
			try {
				accessSync(path, bit);
				return false;
			} catch {
				return true;
			}
		})
		.map(([label]) => label);
	if (missing.length > 0) {
		return { ok: false, name, detail: `${path} is not ${missing.join(" or ")} (run \`chmod u+rwx\` on it)` };
	}
	return { ok: true, name, detail: path };
}

/** How many distinct damage messages a single row names before it summarizes the rest. */
const SESSION_STORE_DAMAGE_DETAIL_LIMIT = 3;

/** How many files a single repeated message names before it counts the rest. */
const SESSION_STORE_DAMAGE_LOCATION_LIMIT = 2;

/**
 * One clause per distinct damage message, with the files that carry it.
 *
 * The row used to hold one clause per damaged file, and the damage that
 * produces several at once produces the same damage in each: an interrupted
 * rewrite truncates every ledger it touched the same way. Three files, one
 * sentence, printed three times, 607 characters wide on a row that gets one
 * line. Grouping by the message says the same thing once and spends the width
 * on which files it happened to.
 */
function summarizeSessionDamage(warnings: ReadonlyArray<SessionJsonlWarning>): string[] {
	const byMessage = new Map<string, string[]>();
	for (const warning of warnings) {
		const locations = byMessage.get(warning.message) ?? [];
		locations.push(`${warning.path}:${warning.line}`);
		byMessage.set(warning.message, locations);
	}
	return Array.from(byMessage, ([message, locations]) => {
		const shown = locations.slice(0, SESSION_STORE_DAMAGE_LOCATION_LIMIT);
		const rest = locations.length - shown.length;
		return `${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}: ${message}`;
	});
}

/**
 * Collect every `*.jsonl` under the session store. The layout is
 * `sessions/<cwdHash>/<sessionId>/current.jsonl`, but the walk does not assume
 * a depth: a store carrying an extra ledger shape stays in scope. Symlinks are
 * not followed (`Dirent.isDirectory()` is false for them), so the walk cannot
 * loop or wander outside the state root. A directory that cannot be listed is
 * a reported problem, not a silent zero.
 */
function collectSessionLedgers(dir: string, ledgers: string[], unlistable: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		unlistable.push(`${dir} could not be listed: ${message}`);
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSessionLedgers(full, ledgers, unlistable);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".jsonl")) ledgers.push(full);
	}
}

/**
 * The store holding every recorded session, checked the way the resume path
 * reads it. Without this row `clio-coder doctor` called a deleted store healthy: the
 * state metadata row said the install was on record, nothing looked at
 * `state/sessions`, and `clio-coder resume` then reported no sessions on a machine
 * that had run hundreds. Damage inside a ledger is the same silence one level
 * down, so each file is parsed by the reader that resume uses and the lines it
 * would skip are named here instead of being dropped into a warning stream
 * nobody is watching.
 *
 * Returns null on an install that was never initialized: the state metadata row
 * above already reports that, and a second failing row about a directory
 * `initializeClioHome` creates would name no remedy of its own.
 */
function sessionStoreFinding(stateDir: string, stateMetadataPresent: boolean): DoctorFinding | null {
	const store = join(stateDir, "sessions");
	const usable = directoryFinding("session store", store);
	if (!usable.ok) {
		if (!stateMetadataPresent && !existsSync(store)) return null;
		return usable;
	}

	const ledgers: string[] = [];
	const unlistable: string[] = [];
	collectSessionLedgers(store, ledgers, unlistable);

	// One entry per damaged file, not per damaged line: a ledger truncated mid
	// rewrite can warn on every line it holds, and the row is one line wide.
	const damaged: SessionJsonlWarning[] = [];
	for (const ledger of ledgers) {
		const first: SessionJsonlWarning[] = [];
		readSessionFileEntries(ledger, {
			onWarning: (warning) => {
				if (first.length === 0) first.push(warning);
			},
		});
		const warning = first[0];
		if (warning) damaged.push(warning);
	}

	if (damaged.length === 0 && unlistable.length === 0) {
		return {
			ok: true,
			name: "session store",
			detail: ledgers.length === 0 ? `${store} (no sessions recorded)` : `${store} (${ledgers.length} readable)`,
		};
	}

	const clauses = summarizeSessionDamage(damaged);
	const shown = clauses.slice(0, SESSION_STORE_DAMAGE_DETAIL_LIMIT);
	const remainder = clauses.length - shown.length;
	const parts: string[] = [];
	if (damaged.length > 0) {
		parts.push(
			`${damaged.length} of ${ledgers.length} ledgers hold lines that cannot be read: ${shown.join("; ")}${
				remainder > 0 ? `; +${remainder} more` : ""
			}`,
		);
	}
	parts.push(...unlistable);
	return { ok: false, name: "session store", detail: parts.join("; ") };
}

interface SessionCacheCandidate {
	entries: SessionEntry[];
	ledger: string;
	sessionId: string;
	updatedAt: number;
}

/**
 * Report the latest transcript's durable cache evidence. Current ledgers are
 * selected explicitly because the session directory also holds diagnostic
 * JSONL files whose timestamps do not identify the latest conversation.
 */
function latestSessionCacheFinding(stateDir: string): DoctorFinding | null {
	const store = join(stateDir, "sessions");
	const ledgers: string[] = [];
	const unlistable: string[] = [];
	collectSessionLedgers(store, ledgers, unlistable);
	const candidates: SessionCacheCandidate[] = [];
	for (const ledger of ledgers) {
		if (basename(ledger) !== "current.jsonl") continue;
		let parsed: unknown[];
		let modifiedAt: number;
		try {
			parsed = readSessionFileEntries(ledger, { onWarning: () => {} });
			modifiedAt = statSync(ledger).mtimeMs;
		} catch {
			continue;
		}
		const entries = parsed.filter(isSessionEntry);
		const entryTimes = entries
			.map((entry) => Date.parse(entry.timestamp))
			.filter((timestamp) => Number.isFinite(timestamp));
		candidates.push({
			entries,
			ledger,
			sessionId: basename(dirname(ledger)),
			updatedAt: entryTimes.length > 0 ? Math.max(...entryTimes) : modifiedAt,
		});
	}
	const latest = candidates.sort(
		(left, right) => right.updatedAt - left.updatedAt || left.ledger.localeCompare(right.ledger),
	)[0];
	if (latest === undefined) return null;

	const telemetry = foldPromptCacheTelemetry(latest.entries);
	if (!hasPromptCacheTelemetry(telemetry)) {
		return {
			ok: true,
			level: "warn",
			name: "cache telemetry",
			detail: `last session ${latest.sessionId}: no prompt-cache telemetry recorded`,
		};
	}
	const counts = telemetry.verdictCounts;
	const topReason = topExpectedColdReason(telemetry);
	return {
		ok: true,
		name: "cache telemetry",
		detail: `last session ${latest.sessionId}: hot ${counts.hot} · partial ${counts.partial} · cold ${counts.cold} · small ${counts.small} · unknown ${counts.unknown}; top expected reason ${topReason === null ? "none" : `${topReason.reason} (${topReason.count})`}`,
	};
}

/**
 * Why the credentials store did not fully parse, read through the same
 * `openAuthStorage` the auth commands use, or null when it is clean. The row
 * used to report the file mode and nothing else, so a store this version cannot
 * parse printed `OK credentials 600` while every provider in it read back as
 * disconnected.
 */
function credentialsDamage(): string | null {
	try {
		return openAuthStorage().damageReason();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * True when none of the four roots exist and no install record does. Anything
 * short of that (one root present, a stray settings.yaml, a stale install.json)
 * is a home Clio once touched, and the per-row report is the honest one for it.
 */
export function isUninitializedHome(dirs: ReturnType<typeof resolveClioDirs> = resolveClioDirs()): boolean {
	return (
		!existsSync(dirs.config) &&
		!existsSync(dirs.data) &&
		!existsSync(dirs.state) &&
		!existsSync(dirs.cache) &&
		!existsSync(join(dirs.state, "install.json"))
	);
}

/**
 * The install method row. An installer install also names the Node it owns and
 * the prefix the launcher runs, and warns when this process is not that Node
 * (CLIO_CODER_NODE, or the package entry run by hand), since `upgrade` keeps
 * the managed runtime rather than the one running now.
 */
function installMethodFinding(installation: Installation): DoctorFinding {
	if (installation.kind === "unknown") {
		return {
			ok: true,
			level: "warn",
			name: "install method",
			detail: `unknown (${installation.root}); automatic upgrade is unavailable; use the original package manager`,
		};
	}
	const record = installation.installer;
	if (installation.kind !== "installer" || record === undefined) {
		return { ok: true, name: "install method", detail: `${installation.kind} (${installation.root})` };
	}
	const stale = record.current !== installation.prefix ? `; the launcher now runs ${record.current}` : "";
	const foreignNode = process.execPath !== record.node ? `; this process runs ${process.execPath} instead` : "";
	return {
		ok: true,
		...(stale || foreignNode ? { level: "warn" as const } : {}),
		name: "install method",
		detail: `installer (prefix ${installation.prefix ?? installation.root}; runtime Node v${record.nodeVersion} ${record.nodeBuild} at ${record.node}${stale}${foreignNode})`,
	};
}

export function runDoctor(options: DoctorOptions = {}): DoctorFinding[] {
	let repairFailure: string | null = null;
	let settingsRepair: SettingsRepairResult | null = null;
	let settingsTightenedFrom: number | null = null;
	if (options.fix) {
		// A repair that throws used to take the whole report with it, so the one
		// command that explains the damage printed nothing. Record it and carry on;
		// the rows below are what say which root is wrong.
		try {
			initializeClioHome();
			settingsRepair = repairSettingsCoercions();
			settingsTightenedFrom = tightenToOwnerOnly(join(resolveClioDirs().config, "settings.yaml"));
			const credentialsPath = join(resolveClioDirs().config, "credentials.yaml");
			if (existsSync(credentialsPath)) {
				chmodSync(credentialsPath, 0o600);
			}
		} catch (error) {
			repairFailure = error instanceof Error ? error.message : String(error);
		}
	}
	const findings: DoctorFinding[] = [];
	if (repairFailure !== null) {
		findings.push({ ok: false, name: "repair", detail: `--fix could not finish: ${repairFailure}` });
	}
	const version = getVersionInfo();
	findings.push({ ok: true, name: "Clio Coder version", detail: readClioVersionLabel() });
	const installation = inspectInstallation();
	findings.push(installMethodFinding(installation));
	findings.push({ ok: true, name: "node version", detail: version.node });
	findings.push({ ok: true, name: "platform", detail: version.platform });
	const engineReady = Boolean(version.piAgentCore && version.piAi && version.piTui);
	findings.push({
		ok: engineReady,
		name: "engine runtime",
		detail: engineReady ? "ready" : "missing required packages",
	});

	const dirs = resolveClioDirs();
	const layoutProblems = clioDirLayoutProblems(dirs);
	findings.push({
		ok: layoutProblems.length === 0,
		name: "directory layout",
		detail:
			layoutProblems.length === 0
				? "config, data, state, and cache roots are absolute, distinct, and non-nesting"
				: `${layoutProblems.join("; ")}. Set four absolute, distinct, non-nesting CLIO_CODER_*_DIR paths before reset or uninstall`,
	});
	const config = dirs.config;
	if (!options.fix && isUninitializedHome(dirs)) {
		// A home Clio has never written to is not a broken one. Seven `!!` rows
		// each pointing at `--fix` read as damage to someone who ran `doctor` as
		// their very first command after `npm install`, and the exit code said
		// the same. One row names the state and the two commands that leave it.
		findings.push({
			ok: true,
			level: "warn",
			name: "installation",
			detail:
				"not set up yet: run `clio-coder` to start the first-run wizard, or `clio-coder configure`; " +
				"`clio-coder doctor --fix` creates the directories without choosing a model",
		});
		return findings;
	}
	findings.push(directoryFinding("config dir", config));
	findings.push(directoryFinding("data dir", dirs.data));
	findings.push(directoryFinding("state dir", dirs.state));
	findings.push(directoryFinding("cache dir", dirs.cache));

	// The settings row runs the loader's own read: anything readSettings would
	// refuse to start on shows up here read-only, with the exact key paths and
	// the remedy that fits the failure. Reading it here a second time and
	// formatting it separately is what let this row call a parse error
	// `unreadable:` while the loader called the same file invalid YAML.
	let currentSettingsValid = false;
	const settings = join(config, "settings.yaml");
	if (!existsSync(settings)) {
		findings.push({
			ok: false,
			name: "settings.yaml",
			detail: "missing (run `clio-coder doctor --fix` or `clio-coder configure`)",
		});
	} else {
		const validation = validateSettingsFile();
		if (validation.issues.length === 0) {
			currentSettingsValid = true;
			findings.push({ ok: true, name: "settings.yaml", detail: settings });
		} else {
			findings.push({ ok: false, name: "settings.yaml", detail: formatSettingsIssues(validation.issues) });
		}
		const settingsMode = process.platform === "win32" ? null : statSync(settings).mode & 0o777;
		if (settingsTightenedFrom !== null) {
			findings.push({
				ok: true,
				name: "settings.yaml mode",
				detail: `tightened ${settingsTightenedFrom.toString(8)} -> 600`,
			});
		} else if (settingsMode !== null && isWiderThanOwnerOnly(settingsMode)) {
			findings.push({
				ok: true,
				level: "warn",
				name: "settings.yaml mode",
				detail: `${settingsMode.toString(8)} lets group or other users read it (run \`clio-coder doctor --fix\` to set 600)`,
			});
		}
		if (validation.coercions.length > 0) {
			// Loading works today, so this is a warning and not a failure. The file
			// keeps its booleans until `--fix` rewrites exactly those values.
			findings.push({
				ok: true,
				level: "warn",
				name: "settings.yaml booleans",
				detail: foldDetail(
					`${validation.coercions.map((entry) => `${entry.path}: ${entry.from}`).join(", ")} read as on/off strings (YAML 1.1 style); run \`clio-coder doctor --fix\` to rewrite them`,
				),
			});
		}
		const retiredValues = validation.issues.flatMap((issue) => (issue.repair !== undefined ? [issue.repair] : []));
		if (retiredValues.length > 0) {
			findings.push({
				ok: true,
				level: "warn",
				name: "settings.yaml retired values",
				detail: foldDetail(
					`doctor --fix would rewrite ${retiredValues.map((entry) => `${entry.path}: "${entry.from}" -> "${entry.to}"`).join(", ")}`,
				),
			});
		}
		if (settingsRepair !== null && settingsRepair.rewritten.length > 0) {
			findings.push({
				ok: true,
				name: "settings.yaml repair",
				detail: foldDetail(
					`rewrote ${settingsRepair.rewritten.map((entry) => `${entry.path}: ${entry.from} -> "${entry.to}"`).join(", ")}`,
				),
			});
		}
		if (settingsRepair !== null && settingsRepair.skipped.length > 0) {
			findings.push({
				ok: true,
				level: "warn",
				name: "settings.yaml repair skipped",
				detail: `could not safely rewrite ${settingsRepair.skipped.join(", ")}; replace aliases, anchors, or tags with plain scalar values and run doctor --fix again`,
			});
		}
	}

	// Single "credentials" row covers all three states (missing / wrong mode /
	// correct mode / read error) so external assertions can grep one stable
	// row name instead of branching on state.
	const creds = join(config, "credentials.yaml");
	if (!existsSync(creds)) {
		findings.push({ ok: false, name: "credentials", detail: "missing (run `clio-coder doctor --fix`)" });
	} else {
		try {
			accessSync(creds, constants.R_OK);
			const damage = credentialsDamage();
			if (process.platform === "win32") {
				// Windows reports every writable file as 666 and chmod cannot narrow
				// it, so the mode said nothing and failed doctor on every native install.
				// The profile directory's ACL is what protects the file there.
				findings.push({ ok: damage === null, name: "credentials", detail: damage ?? creds });
			} else {
				const mode = statSync(creds).mode & 0o777;
				findings.push({
					ok: mode === 0o600 && damage === null,
					name: "credentials",
					detail:
						damage === null
							? isWiderThanOwnerOnly(mode)
								? `${mode.toString(8)} (run \`clio-coder doctor --fix\` to set 600)`
								: mode.toString(8)
							: `${mode.toString(8)}; ${damage}`,
				});
			}
		} catch (err) {
			// `String(err)` put a raw `Error: EACCES...` in the row and named no
			// remedy, the one shape every other failing row avoids. `--fix` chmods
			// this file to 600, so it is the command that repairs the common case.
			const message = err instanceof Error ? err.message : String(err);
			findings.push({
				ok: false,
				name: "credentials",
				detail: foldDetail(`${creds} cannot be read: ${message} (run \`clio-coder doctor --fix\`)`),
			});
		}
	}

	const stateRead = readStateInfoResult();
	const state = stateRead.info;
	// A dev build never rewrites the recorded version (see initializeClioHome), so
	// a record from the installed release is the expected state, not a stale one.
	const devBuild = isDevVersion(version.clio);
	const stateCurrent = Boolean(state && (state.version === version.clio || devBuild));
	// Each stamp names what actually happened. A record rebuilt by `--fix` over a
	// state root whose install time was gone carries no installedAt, and the row
	// used to print the repair minute as the day Clio was installed.
	const stateStamps = state
		? [
				state.installedAt ? `installed ${state.installedAt}` : null,
				state.repairedAt ? `repaired ${state.repairedAt}` : null,
				state.upgradedAt ? `upgraded ${state.upgradedAt}${state.upgradedFrom ? ` from ${state.upgradedFrom}` : ""}` : null,
			].filter((stamp): stamp is string => stamp !== null)
		: [];
	const stateStamp = stateStamps.join(", ");
	findings.push({
		ok: stateCurrent,
		name: "state metadata",
		detail: state
			? stateCurrent
				? `${state.version} (${stateStamp})${state.version === version.clio ? "" : "; this dev build leaves the recorded version alone"}`
				: `stale ${state.version} (${stateStamp}); current ${version.clio} (run \`clio-coder doctor --fix\`)`
			: stateRead.problem !== null
				? // Present but unreadable. `--fix` cannot repair this one: it fails on
					// the same permissions, so pointing there would send the user in a
					// circle.
					stateRead.problem
				: // Every other failing row names the command that repairs it. This one
					// said only "missing", and `clio-coder doctor --fix` does write it.
					"missing (run `clio-coder doctor --fix`)",
	});

	const migrationRead = readMigrationManifestResult(dirs.state);
	const availableMigrations = listMigrations().map((migration) => migration.id);
	const appliedMigrations = new Set(migrationRead.manifest.applied);
	const satisfiedMigrations = new Set(
		currentSettingsValid ? ["2026-09-01-settings-v2", "2026-09-01-retire-panes-knobs"] : [],
	);
	const unrecordedMigrations = availableMigrations.filter((id) => !appliedMigrations.has(id));
	const pendingMigrations = unrecordedMigrations.filter((id) => !satisfiedMigrations.has(id));
	findings.push({
		ok: migrationRead.problem === null,
		...(migrationRead.problem === null && pendingMigrations.length > 0 ? { level: "warn" as const } : {}),
		name: "lifecycle migrations",
		detail:
			migrationRead.problem ??
			(pendingMigrations.length === 0
				? unrecordedMigrations.length > 0
					? `${availableMigrations.length} registered; current settings already satisfy ${unrecordedMigrations.length} unrecorded migrations`
					: `${availableMigrations.length} registered, all recorded`
				: `${pendingMigrations.length} pending: ${pendingMigrations.join(", ")} (run \`clio-coder upgrade --post-install\`)`),
	});

	const sessionStore = sessionStoreFinding(dirs.state, state !== null);
	if (sessionStore !== null) findings.push(sessionStore);
	if (sessionStore?.ok) {
		const cacheTelemetry = latestSessionCacheFinding(dirs.state);
		if (cacheTelemetry !== null) findings.push(cacheTelemetry);
	}

	return findings;
}

/**
 * One finding is one row, so a detail carrying newlines has to be folded
 * before it reaches the column layout. A YAML parse error is the case that
 * forced this: its message embeds the offending source line and a caret,
 * which pushed the rows below it out of alignment and buried them under a
 * blank stretch that read as the end of the report.
 */
function foldDetail(detail: string): string {
	return detail.replace(/\s*\n\s*/g, " ").trim();
}

export function formatDoctorReport(findings: DoctorFinding[]): string {
	const lines = findings.map((f) => {
		const level = f.level ?? (f.ok ? "ok" : "error");
		const badge = level === "ok" ? "OK" : level === "info" ? "INFO" : level === "warn" ? "WARN" : "!! ";
		return `${badge.padEnd(4)} ${f.name.padEnd(22)} ${foldDetail(f.detail)}`;
	});
	return lines.join("\n");
}

/**
 * Asynchronous doctor sweep: walks settings.targets and fingerprints any
 * protocol-compatible URL that responds as a known native server (LM Studio,
 * Ollama). Emits a WARN finding so the user knows to switch to the native
 * runtime for proper resident-model lifecycle management. Network-bound and
 * therefore not part of the synchronous `runDoctor()` core; CI calls the core,
 * the CLI optionally invokes this on top.
 */
/**
 * Fleet preflight sweep: probes every configured fleet node over its real
 * SSH channel (reachability, version-matched clio, path parity for the
 * current project root, writable remote state dir) and persists the verdicts
 * to the durable preflight store that dispatch placement consults. A failing
 * node is a WARN (ineligible for placement), never fatal.
 */
export async function runDoctorFleetChecks(
	projectRoot: string = process.cwd(),
	options: { fix?: boolean } = {},
): Promise<DoctorFinding[]> {
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		return [];
	}
	const nodes = settings.fleet?.nodes ?? [];
	if (nodes.length === 0) return [];
	const { recordFleetPreflight, runFleetNodePreflight } = await import("../dispatch/fleet-preflight.js");
	// Endpoint facts are per node. Every configured target is probed from every
	// node, because a `localhost` URL names a different machine on each one and
	// an orchestrator-side probe would describe none of them.
	const targets = (settings.targets ?? []).map((target) => ({
		id: target.id,
		runtimeId: target.runtime,
		...(target.url !== undefined ? { url: target.url } : {}),
		...(target.defaultModel !== undefined ? { wireModelId: target.defaultModel } : {}),
	}));
	const records = await Promise.all(nodes.map((node) => runFleetNodePreflight(node, projectRoot, { targets })));
	// Placement admits a node only from a stored record. Plain doctor observes;
	// --fix is the run that may write state, so it is the one that records.
	let recorded = options.fix === true;
	if (recorded) {
		try {
			recordFleetPreflight(records);
		} catch {
			recorded = false;
		}
	}
	const admission = recorded ? "recorded for dispatch" : "not recorded, run doctor --fix to admit this node";
	return records.map((record) => ({
		ok: true,
		level: record.ok ? "ok" : "warn",
		name: `fleet node ${record.nodeId}`,
		detail: record.ok
			? `eligible (${admission}): ${record.host} clio ${record.remoteVersion ?? "(custom entry)"}, path parity for ${record.projectRoot}, ${
					record.targets.filter((fact) => fact.reachable === "true").length
				}/${record.targets.length} targets reachable from the node`
			: `ineligible: ${record.detail ?? "preflight failed"}`,
	}));
}

/**
 * Interop sweep: one row per agent detection found, plus one aggregate row for
 * the foreign skill roots that resolved. This reports and never proposes, and
 * it never starts a session with a peer: reachability for a stdio peer means
 * its command resolves on PATH. Nothing here writes.
 */
export async function runDoctorInteropChecks(projectRoot: string = process.cwd()): Promise<DoctorFinding[]> {
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		return [];
	}
	const configDir = resolveClioDirs().config;
	// Extension discovery resolves through the ensuring config accessor. With no
	// config root there cannot be user Clio extensions or skills to inspect, so
	// keep the broken partial home untouched and retain the binary checks below.
	const skills = existsSync(configDir) ? loadSkills({ cwd: projectRoot, configDir }) : { items: [], diagnostics: [] };
	const foreign = skills.items.filter((skill) => FOREIGN_SKILL_SOURCES.has(skill.source));
	const report = await detectInteropAgents(
		{
			cwd: projectRoot,
			// Version probes use the shared command runner, which prepares managed Git
			// hooks before spawning. Doctor promises observation only, so PATH presence
			// is the strongest safe fact here.
			probeVersion: false,
			skillSources: skills.items.map((skill) => skill.source),
		},
		// Reading the prior report resolves through the ensuring state accessor.
		// Existing decisions are irrelevant to doctor's presence-only projection.
		[],
	);
	const configured = new Set(settings.integrations.externalAgents.entries.map((agent) => agent.id));
	const findings: DoctorFinding[] = report.agents.map((agent) => {
		const kind = interopAgentKind(agent.kind);
		const status = configured.has(agent.kind)
			? "configured"
			: kind?.acp === undefined
				? "no ACP recipe"
				: "detected, not configured";
		const head = agent.binary === undefined ? "not on PATH" : (agent.version ?? "version unknown");
		const where =
			agent.binary !== undefined
				? ` at ${agent.binary}`
				: agent.installDir !== undefined
					? `, files under ${agent.installDir}`
					: "";
		return { ok: true, level: "ok", name: `interop ${agent.kind}`, detail: `${head} (${status})${where}` };
	});
	for (const agent of settings.integrations.externalAgents.entries) {
		if (resolveOnPath([agent.command]).presence === "present") continue;
		findings.push({
			ok: true,
			level: "warn",
			name: `interop ${agent.id}`,
			detail: `configured peer command \`${agent.command}\` does not resolve on PATH; /delegate ${agent.id} will fail to spawn`,
		});
	}
	if (foreign.length > 0) {
		const roots = new Set(foreign.map((skill) => skill.sourceInfo.source ?? skill.baseDir));
		findings.push({
			ok: true,
			level: "ok",
			name: "interop skills",
			detail: `${foreign.length} skills from ${roots.size} foreign roots`,
		});
	}
	return findings;
}

export async function runDoctorRuntimeChecks(): Promise<DoctorFinding[]> {
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		return [];
	}
	const candidates = settings.targets.filter(
		(entry) => (entry.runtime === "openai-compat" || entry.runtime === "anthropic-compat") && Boolean(entry.url),
	);
	if (candidates.length === 0) return [];
	const results = await Promise.all(
		candidates.map(async (target): Promise<DoctorFinding | null> => {
			const url = target.url;
			if (!url) return null;
			const fingerprint = await fingerprintNativeRuntime(url);
			if (!fingerprint) return null;
			return {
				ok: true,
				level: "warn",
				name: `target ${target.id}`,
				detail: `${fingerprint.displayName} detected at ${url}; run \`clio-coder targets convert ${target.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle`,
			};
		}),
	);
	return results.filter((finding): finding is DoctorFinding => finding !== null);
}

/** One configured model pointer at a target, named the way settings.yaml spells it. */
interface ConfiguredModelRole {
	role: string;
	model: string;
}

function configuredModelRoles(
	settings: ReturnType<typeof readSettings>,
	target: TargetDescriptor,
): ConfiguredModelRole[] {
	const roles: ConfiguredModelRole[] = [];
	if (target.defaultModel) roles.push({ role: "defaultModel", model: target.defaultModel });
	if (settings.chat.target === target.id && settings.chat.model) {
		roles.push({ role: "chat.model", model: settings.chat.model });
	}
	if (settings.context.memory.target === target.id && settings.context.memory.model) {
		roles.push({ role: "memory.model", model: settings.context.memory.model });
	}
	if (settings.fleet.default.target === target.id && settings.fleet.default.model) {
		roles.push({ role: "fleet.default.model", model: settings.fleet.default.model });
	}
	for (const [name, profile] of Object.entries(settings.fleet.profiles)) {
		if (profile.target === target.id && profile.model)
			roles.push({ role: `fleet.profiles.${name}.model`, model: profile.model });
	}
	for (const [name, roster] of Object.entries(settings.fleet.rosters)) {
		for (const member of roster.members) {
			if (member.target === target.id && member.model)
				roles.push({ role: `fleet.rosters.${name}.${member.label}.model`, model: member.model });
		}
	}
	return roles;
}

/**
 * Total probe budget for the model sweep. A target that does not answer in
 * this time falls back to the list configure recorded, so a black-holed
 * remote costs doctor a bounded wait rather than the probe's full timeout.
 */
const DOCTOR_MODEL_PROBE_TIMEOUT_MS = 2_500;

async function doctorProbeContext(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	signal: AbortSignal,
): Promise<ProbeContext> {
	const ctx: ProbeContext = {
		credentialsPresent: credentialsPresent(),
		httpTimeoutMs: DOCTOR_MODEL_PROBE_TIMEOUT_MS,
		signal,
	};
	if (!targetRequiresAuth(target, runtime)) return ctx;
	try {
		const auth = openAuthStorage();
		const authTarget = resolveAuthTarget(target, runtime);
		const stored = auth.get(authTarget.providerId);
		// Standard doctor is read-only: resolving an expired OAuth credential
		// would refresh it and persist the new token. Let the passive probe
		// report missing auth instead, with the expiry explained in its row.
		if (
			auth.statusForTarget(authTarget, { includeFallback: false }).source === "stored-oauth" &&
			stored?.type === "oauth"
		) {
			if (stored.expires > Date.now()) ctx.authToken = stored.access;
			return ctx;
		}
		const resolution = await auth.resolveForTarget(authTarget, {
			includeFallback: false,
			signal,
		});
		if (resolution.apiKey) ctx.authToken = resolution.apiKey;
	} catch {
		// The probe reports its own missing-auth failure; the wireModels fallback covers the check.
	}
	return ctx;
}

interface DoctorProbeObservation {
	probe: ProbeResult;
	advertised: string[];
	resident: string[];
	cacheAdvisories: ReadonlyArray<string>;
}

/** Passive endpoint result and any model inventory it returned. Null means no check exists, not success. */
async function probeAdvertisedModels(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
): Promise<DoctorProbeObservation | null> {
	const passiveProbe = runtime.probe;
	const passiveTarget = { ...target };
	// llama.cpp router /props?model=<id> can load an unloaded model. Metadata
	// checks must not select weights or displace an already resident model.
	if (runtime.id.startsWith("llamacpp")) delete passiveTarget.defaultModel;
	if (runtime.kind !== "http" || typeof passiveProbe !== "function") return null;
	let probe: ProbeResult;
	try {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			probe = await Promise.race([
				(async () =>
					passiveProbe.call(runtime, passiveTarget, await doctorProbeContext(target, runtime, controller.signal)))(),
				new Promise<ProbeResult>((resolve) => {
					timer = setTimeout(() => {
						controller.abort();
						resolve({ ok: false, error: `passive check timed out after ${DOCTOR_MODEL_PROBE_TIMEOUT_MS}ms` });
					}, DOCTOR_MODEL_PROBE_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	} catch (error) {
		probe = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const advertised = probe.ok ? [...(probe.models ?? [])] : [];
	const resident: string[] = [];
	for (const [id, status] of Object.entries(probe.modelStates ?? {})) {
		if (!advertised.includes(id)) advertised.push(id);
		if (status.state === "loaded" || status.state === "loading") resident.push(id);
	}
	return { probe, advertised, resident, cacheAdvisories: probe.cacheAdvisories ?? [] };
}

/**
 * Connection/model sweep: passive HTTP metadata checks run for configured targets.
 * Active routes fail on connection or credential errors; unused targets warn. The live
 * list wins when the target answers; the `wireModels` list configure recorded
 * stands in when it does not, so an unreachable server still gets the
 * placeholder id it was saved with called out. A target with neither list is
 * a WARN, not a pass, because nothing was verified. Network-bound like the
 * runtime sweep, so it is not part of the synchronous `runDoctor()` core.
 *
 * The same probe reports server settings that defeat prefix-cache reuse. Each
 * becomes a WARN row of its own, since the models can check out while every
 * returning prompt still pays for a restore the operator can switch off.
 */
export async function runDoctorModelChecks(): Promise<DoctorFinding[]> {
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		return [];
	}
	if (settings.targets.length === 0) return [];
	// Every runtime descriptor and the model catalog sit behind these two
	// imports. They are loaded here, not at module load, so a doctor run on a
	// home with no targets (the `--fix` seed every CLI test starts from) pays
	// nothing for a sweep it has nothing to do.
	const [
		{ getRuntimeRegistry, closestRuntimeId },
		{ registerBuiltinRuntimes },
		{ loadPluginRuntimes },
		{ listKnownModelsForRuntime },
		{ readTargetModelSnapshot },
		{ runtimeListsModelsLive },
	] = await Promise.all([
		import("../providers/registry.js"),
		import("../providers/runtimes/builtins.js"),
		import("../providers/plugins.js"),
		import("../providers/support.js"),
		import("../providers/target-model-cache.js"),
		import("../providers/model-discovery.js"),
	]);
	const registry = getRuntimeRegistry();
	// doctor never loads the providers domain, so the registry is empty here
	// unless another command in this process filled it.
	if (registry.list().length === 0) {
		registerBuiltinRuntimes(registry);
		await loadPluginRuntimes(registry, settings);
	}
	const results = await Promise.all(
		settings.targets.map(async (target): Promise<DoctorFinding[]> => {
			const runtime = registry.get(target.runtime);
			if (!runtime) {
				const replacement =
					target.runtime === "lmstudio-native"
						? "lmstudio"
						: target.runtime === "ollama-native"
							? "ollama"
							: closestRuntimeId(registry, target.runtime);
				return [
					{
						ok: false,
						name: `target ${target.id}`,
						detail: `runtime '${target.runtime}' is unknown; ${replacement ? `use '${replacement}' instead` : "choose a registered runtime from `clio-coder configure --list`"} in settings.yaml`,
					},
				];
			}
			const roles = configuredModelRoles(settings, target);
			const active =
				settings.chat.target === target.id ||
				settings.context.memory.target === target.id ||
				settings.fleet.default.target === target.id ||
				Object.values(settings.fleet.profiles).some((profile) => profile.target === target.id) ||
				Object.values(settings.fleet.rosters).some((roster) =>
					roster.members.some((member) => member.target === target.id),
				);
			const requiredCredential = targetRequiresAuth(target, runtime);
			let credentialAvailable = !requiredCredential;
			let credentialDetail = requiredCredential
				? "required credential not found"
				: ["aws-sdk", "vertex-adc", "claude-cli"].includes(runtime.auth)
					? "credentials managed by the SDK or installed app; availability not checked"
					: "no credential required";
			try {
				const status = openAuthStorage().statusForTarget(resolveAuthTarget(target, runtime), {
					includeFallback: false,
				});
				credentialAvailable = !requiredCredential || status.available;
				const stored = openAuthStorage().get(status.providerId);
				if (status.source === "stored-oauth" && stored?.type === "oauth" && stored.expires <= Date.now()) {
					credentialAvailable = !requiredCredential;
					credentialDetail = "stored sign-in expired; standard doctor does not refresh credentials";
				} else if (status.available && status.source !== "not-required")
					credentialDetail = `credential available from ${status.source}`;
			} catch (error) {
				credentialAvailable = false;
				credentialDetail = `credential status unreadable: ${error instanceof Error ? error.message : String(error)}`;
			}
			const observation = await probeAdvertisedModels(target, runtime);
			const where = target.url ?? `${runtime.displayName} provider endpoint`;
			const connection: DoctorFinding =
				observation === null
					? {
							ok: credentialAvailable || !active,
							...(credentialAvailable ? { level: "info" as const } : !active ? { level: "warn" as const } : {}),
							name: `connection ${target.id}`,
							detail: `${credentialDetail}; ${
								runtime.kind !== "http" && typeof runtime.probe === "function"
									? "standard doctor does not run this runtime’s subprocess check; endpoint reachability is not verified"
									: `${runtime.id} exposes no passive endpoint check, so reachability is not verified until a request`
							}. No generation was attempted.`,
						}
					: observation.probe.ok
						? {
								ok: credentialAvailable || !active,
								...(!credentialAvailable && !active ? { level: "warn" as const } : {}),
								name: `connection ${target.id}`,
								detail: `${runtime.id === "alcf" ? "ALCF catalog reachable; configured inference URL not checked" : `${where} reachable`}${
									observation.probe.latencyMs === undefined ? "" : ` in ${observation.probe.latencyMs}ms`
								}; ${credentialDetail}; passive metadata only, no generation was attempted${
									observation.advertised.length > 0
										? `; ${observation.advertised.length} models read live`
										: "; no model list returned"
								}`,
							}
						: {
								ok: !active,
								...(!active ? { level: "warn" as const } : {}),
								name: `connection ${target.id}`,
								detail: `${where} was not verified: ${observation.probe.error ?? "no reply"}. ${credentialDetail}. This was a passive metadata check; no generation was attempted.`,
							};
			const cache = (observation?.cacheAdvisories ?? []).map(
				(detail): DoctorFinding => ({ ok: true, level: "warn", name: `cache ${target.id}`, detail }),
			);
			if (roles.length === 0) return [connection, ...cache];

			const catalog = listKnownModelsForRuntime(runtime.id);
			const live = observation?.probe.ok === true && observation.advertised.length > 0;
			const snapshot = readTargetModelSnapshot(target, { cacheDir: resolveClioDirs().cache });
			const cachedModels = snapshot?.models ?? [];
			const catalogOnly = !runtimeListsModelsLive(runtime) && catalog.length > 0;
			const advertised = live
				? observation.advertised
				: catalogOnly
					? catalog
					: cachedModels.length > 0
						? cachedModels
						: (target.wireModels ?? []).length > 0
							? (target.wireModels ?? [])
							: catalog;
			const source = live
				? `live list from ${runtime.id === "alcf" ? "the ALCF catalog (inference URL not checked)" : where}`
				: catalogOnly
					? "provider catalog, not this account's live model list"
					: cachedModels.length > 0
						? `cached list from ${snapshot?.observedAt}, not verified live now`
						: (target.wireModels ?? []).length > 0
							? "list recorded by configure, not verified live now"
							: catalog.length > 0
								? "provider catalog, not this account's live model list"
								: "";
			if (advertised.length === 0) {
				return [
					connection,
					{
						ok: true,
						level: "warn",
						name: `model ${target.id}`,
						detail: `${roles.map((entry) => `${entry.role} '${entry.model}'`).join(", ")} could not be checked: no live, cached, configured, or catalog model list is available; open Configure → Connections after the endpoint is up`,
					},
					...cache,
				];
			}
			const missing = roles.filter((entry) => !advertised.includes(entry.model));
			if (missing.length === 0) {
				return [
					connection,
					{
						ok: true,
						...(live ? {} : { level: "info" as const }),
						name: `model ${target.id}`,
						detail: `${roles.map((entry) => `${entry.role} '${entry.model}'`).join(", ")} found in ${source}`,
					},
					...cache,
				];
			}
			const resident = live
				? observation.resident.length > 0
					? observation.resident.join(", ")
					: "none reported"
				: "not checked";
			return [
				connection,
				{
					ok: !active || !live,
					...(!active || !live ? { level: "warn" as const } : {}),
					name: `model ${target.id}`,
					detail: `${missing.map((entry) => `${entry.role} '${entry.model}'`).join(", ")} not found in ${source} (${advertised.length} ids). Resident instances: ${resident}. Open Configure → Chat, Fleet, or Context & Memory and choose from the listed models.`,
				},
				...cache,
			];
		}),
	);
	const findings = results.flat();
	return [...findings, ...(await systemOneFindings(registry, findings))];
}

const MIB = 1024 * 1024;

/** The builds whose cuts cover a site, from a cut table keyed by build identity. */
function buildsWithCuts(site: string, table: Readonly<Record<string, Readonly<Record<string, number>>>>): string[] {
	return Object.entries(table)
		.filter(([, cuts]) => Object.keys(cuts).some((key) => key.startsWith(`${site}.`)))
		.map(([build]) => build);
}

/**
 * Doctor never asks a decision, so it cannot know which build will answer. It
 * states which builds a bound site's readings would be validated for: measured
 * cuts that ship, cuts the operator wrote, and everything else unvalidated.
 */
function cutStanding(
	site: string,
	measured: Readonly<Record<string, Readonly<Record<string, number>>>>,
	operator: Readonly<Record<string, Readonly<Record<string, number>>>>,
): string {
	const fitted = buildsWithCuts(site, measured);
	const written = buildsWithCuts(site, operator);
	const parts = [
		...(fitted.length > 0 ? [`measured for ${fitted.join(", ")}`] : []),
		...(written.length > 0 ? [`operator-configured for ${written.join(", ")}`] : []),
	];
	return parts.length === 0
		? "no build has cuts at this site, so every answer is unvalidated"
		: `cuts ${parts.join(", ")}; any other answering build is unvalidated and only records`;
}

/**
 * Where each System One site is bound, which bindings cannot resolve, and what
 * the decision dataset holds. System One is experimental and off by default, so
 * an install with nothing bound gets one row saying so. Built from settings and
 * the connection rows above: doctor never asks a decision, so a failing site
 * here is a broken binding or an unverified target.
 */
async function systemOneFindings(
	runtimes: { get(id: string): RuntimeDescriptor | null },
	connections: ReadonlyArray<DoctorFinding>,
): Promise<DoctorFinding[]> {
	// A session binds sites from the layered settings, so a site a trusted
	// project file binds is live there and must not read as unbound here. An
	// untrusted project layer contributes nothing, exactly as in a session.
	const settings = readLayeredSettings(process.cwd()).settings;
	const { describeBindings, formatDatasetBytes, listDatasetFiles } = await import("../system-one/recorder/index.js");
	const { FITTED_CUTS } = await import("../system-one/calibration.js");
	const bindings = describeBindings(settings, runtimes);
	const off = bindings.filter((binding) => binding.engine === null).map((binding) => binding.site);
	const rows: DoctorFinding[] = [];
	if (off.length === bindings.length) {
		rows.push({ ok: true, level: "info", name: "system one (experimental)", detail: "off; no site is bound" });
	} else if (off.length > 0) {
		rows.push({ ok: true, level: "info", name: "system one (experimental) off", detail: off.join(", ") });
	}
	for (const binding of bindings) {
		if (binding.engine === null) continue;
		const name = `system one (experimental) ${binding.site}`;
		if (binding.problem !== undefined) {
			rows.push({ ok: true, level: "warn", name, detail: `${binding.problem}; the site stays silent` });
			continue;
		}
		const connection = connections.find((finding) => finding.name === `connection ${binding.target}`);
		const unverified = connection === undefined || !connection.ok || connection.level === "warn";
		rows.push({
			ok: true,
			...(unverified ? { level: "warn" as const } : {}),
			name,
			detail:
				`${binding.engine} (${binding.kind}) → ${binding.target}/${binding.model ?? "target default"}` +
				(binding.deadlineMs === undefined ? "" : `; deadline ${binding.deadlineMs} ms`) +
				`; ${cutStanding(binding.site, FITTED_CUTS, settings.systemOne.cuts)}` +
				(unverified ? `; connection ${binding.target} is not verified, so this site may stay silent` : ""),
		});
	}
	// With nothing bound, recording off and no files, the dataset row would only repeat the off row.
	const quiet = off.length === bindings.length && !settings.systemOne.record;
	const dataset = datasetFinding(settings.systemOne, () => listDatasetFiles(), formatDatasetBytes, quiet);
	if (dataset !== null) rows.push(dataset);
	return rows;
}

function datasetFinding(
	systemOne: ReturnType<typeof readSettings>["systemOne"],
	listDatasetFiles: () => ReadonlyArray<{ day: string; bytes: number }>,
	formatBytes: (bytes: number) => string,
	quietWhenEmpty: boolean,
): DoctorFinding | null {
	const name = "system one dataset";
	const record = systemOne.record ? "record on" : "record off";
	let files: ReadonlyArray<{ day: string; bytes: number }>;
	try {
		files = listDatasetFiles();
	} catch (err) {
		return {
			ok: true,
			level: "warn",
			name,
			detail: `${record}; the dataset directory cannot be read: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const limits = `retention ${systemOne.retentionDays} days, cap ${systemOne.maxMiB} MiB`;
	if (files.length === 0)
		return quietWhenEmpty ? null : { ok: true, level: "info", name, detail: `${record}; no files; ${limits}` };
	const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
	const over = bytes > systemOne.maxMiB * MIB;
	return {
		ok: true,
		level: over ? "warn" : "info",
		name,
		detail:
			`${record}; ${files.length} day${files.length === 1 ? "" : "s"} (${files.length === 1 ? files[0]?.day : `${files[0]?.day} to ${files.at(-1)?.day}`}), ` +
			`${formatBytes(bytes)}; ${limits}` +
			(over ? "; over the cap, the next write prunes the oldest days" : ""),
	};
}

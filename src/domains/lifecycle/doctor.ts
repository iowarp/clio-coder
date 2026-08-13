import { accessSync, chmodSync, constants, type Dirent, existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { formatSettingsIssues, readSettings, validateSettingsFile } from "../../core/config.js";
import { initializeClioHome } from "../../core/init.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { readSessionFileEntries, type SessionJsonlWarning } from "../../engine/session.js";
import { openAuthStorage } from "../providers/auth/index.js";
import { fingerprintNativeRuntime } from "../providers/probe/fingerprint.js";
import { readStateInfoResult } from "./state.js";
import { getVersionInfo } from "./version.js";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
	ok: boolean;
	name: string;
	detail: string;
	level?: DoctorLevel;
}

export interface DoctorOptions {
	fix?: boolean;
}

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
 * the path, so `touch $CLIO_CACHE_DIR` produced a green report and exit 0 while
 * `clio doctor --fix` one command later died on "Expected directory". A root
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
		if (code === "ENOENT") return { ok: false, name, detail: `${path} missing (run \`clio doctor --fix\`)` };
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, name, detail: `${path} cannot be inspected: ${message}` };
	}
	if (!stats.isDirectory()) {
		return {
			ok: false,
			name,
			detail: `${path} is ${describeNodeType(stats)}, not a directory (move it aside, then run \`clio doctor --fix\`)`,
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

/** How many damaged ledgers a single row names before it summarizes the rest. */
const SESSION_STORE_DAMAGE_DETAIL_LIMIT = 3;

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
 * reads it. Without this row `clio doctor` called a deleted store healthy: the
 * state metadata row said the install was on record, nothing looked at
 * `state/sessions`, and `clio resume` then reported no sessions on a machine
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
	const damaged: string[] = [];
	for (const ledger of ledgers) {
		const first: SessionJsonlWarning[] = [];
		readSessionFileEntries(ledger, {
			onWarning: (warning) => {
				if (first.length === 0) first.push(warning);
			},
		});
		const warning = first[0];
		if (warning) damaged.push(`${warning.path}:${warning.line}: ${warning.message}`);
	}

	if (damaged.length === 0 && unlistable.length === 0) {
		return {
			ok: true,
			name: "session store",
			detail: ledgers.length === 0 ? `${store} (no sessions recorded)` : `${store} (${ledgers.length} readable)`,
		};
	}

	const shown = damaged.slice(0, SESSION_STORE_DAMAGE_DETAIL_LIMIT);
	const remainder = damaged.length - shown.length;
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

export function runDoctor(options: DoctorOptions = {}): DoctorFinding[] {
	let repairFailure: string | null = null;
	if (options.fix) {
		// A repair that throws used to take the whole report with it, so the one
		// command that explains the damage printed nothing. Record it and carry on;
		// the rows below are what say which root is wrong.
		try {
			initializeClioHome();
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
	findings.push({ ok: true, name: "Clio Coder version", detail: version.clio });
	findings.push({ ok: true, name: "node version", detail: version.node });
	findings.push({ ok: true, name: "platform", detail: version.platform });
	const engineReady = Boolean(version.piAgentCore && version.piAi && version.piTui);
	findings.push({
		ok: engineReady,
		name: "engine runtime",
		detail: engineReady ? "ready" : "missing required packages",
	});

	const dirs = resolveClioDirs();
	const config = dirs.config;
	findings.push(directoryFinding("config dir", config));
	findings.push(directoryFinding("data dir", dirs.data));
	findings.push(directoryFinding("state dir", dirs.state));
	findings.push(directoryFinding("cache dir", dirs.cache));

	// The settings row runs the loader's own read: anything readSettings would
	// refuse to start on shows up here read-only, with the exact key paths and
	// the remedy that fits the failure. Reading it here a second time and
	// formatting it separately is what let this row call a parse error
	// `unreadable:` while the loader called the same file invalid YAML.
	const settings = join(config, "settings.yaml");
	if (!existsSync(settings)) {
		findings.push({
			ok: false,
			name: "settings.yaml",
			detail: "missing (run `clio doctor --fix` or `clio configure`)",
		});
	} else {
		const validation = validateSettingsFile();
		if (validation.issues.length === 0) {
			findings.push({ ok: true, name: "settings.yaml", detail: settings });
		} else {
			findings.push({ ok: false, name: "settings.yaml", detail: formatSettingsIssues(validation.issues) });
		}
	}

	// Single "credentials" row covers all three states (missing / wrong mode /
	// correct mode / read error) so external assertions can grep one stable
	// row name instead of branching on state.
	const creds = join(config, "credentials.yaml");
	if (!existsSync(creds)) {
		findings.push({ ok: false, name: "credentials", detail: "missing (run `clio doctor --fix`)" });
	} else {
		try {
			accessSync(creds, constants.R_OK);
			const st = statSync(creds);
			const mode = st.mode & 0o777;
			const damage = credentialsDamage();
			findings.push({
				ok: mode === 0o600 && damage === null,
				name: "credentials",
				detail: damage === null ? mode.toString(8) : `${mode.toString(8)}; ${damage}`,
			});
		} catch (err) {
			// `String(err)` put a raw `Error: EACCES...` in the row and named no
			// remedy, the one shape every other failing row avoids. `--fix` chmods
			// this file to 600, so it is the command that repairs the common case.
			const message = err instanceof Error ? err.message : String(err);
			findings.push({
				ok: false,
				name: "credentials",
				detail: foldDetail(`${creds} cannot be read: ${message} (run \`clio doctor --fix\`)`),
			});
		}
	}

	const stateRead = readStateInfoResult();
	const state = stateRead.info;
	const stateCurrent = Boolean(state && state.version === version.clio);
	const stateStamp = state
		? `installed ${state.installedAt}${state.upgradedAt ? `, upgraded ${state.upgradedAt}` : ""}`
		: "";
	findings.push({
		ok: stateCurrent,
		name: "state metadata",
		detail: state
			? stateCurrent
				? `${state.version} (${stateStamp})`
				: `stale ${state.version} (${stateStamp}); current ${version.clio} (run \`clio doctor --fix\`)`
			: stateRead.problem !== null
				? // Present but unreadable. `--fix` cannot repair this one: it fails on
					// the same permissions, so pointing there would send the user in a
					// circle.
					stateRead.problem
				: // Every other failing row names the command that repairs it. This one
					// said only "missing", and `clio doctor --fix` does write it.
					"missing (run `clio doctor --fix`)",
	});

	const sessionStore = sessionStoreFinding(dirs.state, state !== null);
	if (sessionStore !== null) findings.push(sessionStore);

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
		const badge = level === "ok" ? "OK" : level === "warn" ? "WARN" : "!! ";
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
export async function runDoctorFleetChecks(projectRoot: string = process.cwd()): Promise<DoctorFinding[]> {
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
	try {
		recordFleetPreflight(records);
	} catch {
		// The findings below still tell the operator what happened; a store
		// write failure just means placement will keep denying these nodes.
	}
	return records.map((record) => ({
		ok: true,
		level: record.ok ? "ok" : "warn",
		name: `fleet node ${record.nodeId}`,
		detail: record.ok
			? `eligible: ${record.host} clio ${record.remoteVersion ?? "(custom entry)"}, path parity for ${record.projectRoot}, ${
					record.targets.filter((fact) => fact.reachable === "true").length
				}/${record.targets.length} targets reachable from the node`
			: `ineligible: ${record.detail ?? "preflight failed"}`,
	}));
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
				detail: `${fingerprint.displayName} detected at ${url}; run \`clio targets convert ${target.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle`,
			};
		}),
	);
	return results.filter((finding): finding is DoctorFinding => finding !== null);
}

import { accessSync, chmodSync, constants, type Dirent, existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { formatSettingsIssues, readSettings, validateSettingsFile } from "../../core/config.js";
import { initializeClioHome } from "../../core/init.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { readSessionFileEntries, type SessionJsonlWarning } from "../../engine/session.js";
import { detectInteropAgents, interopAgentKind, resolveOnPath } from "../interop/index.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../providers/auth/index.js";
import { credentialsPresent } from "../providers/credentials.js";
import { fingerprintNativeRuntime } from "../providers/probe/fingerprint.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { loadSkills, type SkillSource } from "../resources/skills/loader.js";
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
		findings.push({ ok: false, name: "credentials", detail: "missing (run `clio-coder doctor --fix`)" });
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
				detail: foldDetail(`${creds} cannot be read: ${message} (run \`clio-coder doctor --fix\`)`),
			});
		}
	}

	const stateRead = readStateInfoResult();
	const state = stateRead.info;
	const stateCurrent = Boolean(state && state.version === version.clio);
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
				? `${state.version} (${stateStamp})`
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
	const skills = loadSkills({ cwd: projectRoot });
	const foreign = skills.items.filter((skill) => FOREIGN_SKILL_SOURCES.has(skill.source));
	const report = await detectInteropAgents({
		cwd: projectRoot,
		probeVersion: true,
		skillSources: skills.items.map((skill) => skill.source),
	});
	const configured = new Set(settings.delegation.agents.map((agent) => agent.id));
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
	for (const agent of settings.delegation.agents) {
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
	if (settings.orchestrator.target === target.id && settings.orchestrator.model) {
		roles.push({ role: "orchestrator.model", model: settings.orchestrator.model });
	}
	if (settings.background.target === target.id && settings.background.model) {
		roles.push({ role: "background.model", model: settings.background.model });
	}
	if (settings.workers.default.target === target.id && settings.workers.default.model) {
		roles.push({ role: "workers.default.model", model: settings.workers.default.model });
	}
	return roles;
}

/**
 * Per-request budget for the model sweep. A target that does not answer in
 * this time falls back to the list configure recorded, so a black-holed
 * remote costs doctor a bounded wait rather than the probe's full timeout.
 */
const DOCTOR_MODEL_PROBE_TIMEOUT_MS = 2_500;

async function doctorProbeContext(target: TargetDescriptor, runtime: RuntimeDescriptor): Promise<ProbeContext> {
	const ctx: ProbeContext = { credentialsPresent: credentialsPresent(), httpTimeoutMs: DOCTOR_MODEL_PROBE_TIMEOUT_MS };
	if (!targetRequiresAuth(target, runtime)) return ctx;
	try {
		const resolution = await openAuthStorage().resolveForTarget(resolveAuthTarget(target, runtime), {
			includeFallback: false,
		});
		if (resolution.apiKey) ctx.authToken = resolution.apiKey;
	} catch {
		// The probe reports its own missing-auth failure; the wireModels fallback covers the check.
	}
	return ctx;
}

/** What the target advertises now, or null when it could not be asked. */
async function probeAdvertisedModels(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
): Promise<{ advertised: string[]; resident: string[] } | null> {
	if (runtime.kind !== "http" || typeof runtime.probe !== "function" || !target.url) return null;
	let probe: ProbeResult;
	try {
		probe = await runtime.probe(target, await doctorProbeContext(target, runtime));
	} catch {
		return null;
	}
	if (!probe.ok || !probe.models || probe.models.length === 0) return null;
	const advertised = [...probe.models];
	const resident: string[] = [];
	for (const [id, status] of Object.entries(probe.modelStates ?? {})) {
		if (!advertised.includes(id)) advertised.push(id);
		if (status.state === "loaded" || status.state === "loading") resident.push(id);
	}
	return { advertised, resident };
}

/**
 * Model sweep: every model pointer settings.yaml aims at a target with no
 * static catalog is checked against what that target advertises. The live
 * list wins when the target answers; the `wireModels` list configure recorded
 * stands in when it does not, so an unreachable server still gets the
 * placeholder id it was saved with called out. A target with neither list is
 * a WARN, not a pass, because nothing was verified. Network-bound like the
 * runtime sweep, so it is not part of the synchronous `runDoctor()` core.
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
	const [{ getRuntimeRegistry }, { registerBuiltinRuntimes }, { listKnownModelsForRuntime }] = await Promise.all([
		import("../providers/registry.js"),
		import("../providers/runtimes/builtins.js"),
		import("../providers/support.js"),
	]);
	const registry = getRuntimeRegistry();
	// doctor never loads the providers domain, so the registry is empty here
	// unless another command in this process filled it.
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const results = await Promise.all(
		settings.targets.map(async (target): Promise<DoctorFinding | null> => {
			const runtime = registry.get(target.runtime);
			if (!runtime) return null;
			// Cloud runtimes are validated against their catalog at configure time.
			if (listKnownModelsForRuntime(runtime.id).length > 0) return null;
			const roles = configuredModelRoles(settings, target);
			if (roles.length === 0) return null;
			const live = await probeAdvertisedModels(target, runtime);
			const recorded = target.wireModels ?? [];
			if (live === null && recorded.length === 0) {
				return {
					ok: true,
					level: "warn",
					name: `model ${target.id}`,
					detail: `${roles.map((entry) => `${entry.role} '${entry.model}'`).join(", ")} could not be verified: the target did not answer and configure recorded no model list; run \`clio-coder targets --probe\` once it is up`,
				};
			}
			const advertised = live ? live.advertised : recorded;
			const source = live ? `advertised by ${target.url ?? target.id} now` : "recorded by configure at last save";
			const missing = roles.filter((entry) => !advertised.includes(entry.model));
			if (missing.length === 0) {
				return {
					ok: true,
					name: `model ${target.id}`,
					detail: `${roles.map((entry) => `${entry.role} '${entry.model}'`).join(", ")} ${source}`,
				};
			}
			const resident = live && live.resident.length > 0 ? live.resident.join(", ") : live ? "none" : "unknown";
			return {
				ok: false,
				name: `model ${target.id}`,
				detail: `${missing.map((entry) => `${entry.role} '${entry.model}'`).join(", ")} not ${source} (${advertised.length} ids). Resident instances: ${resident}. Re-run \`clio-coder configure --id ${target.id} --model <advertised id>\`; \`clio-coder targets --probe\` lists them`,
			};
		}),
	);
	return results.filter((finding): finding is DoctorFinding => finding !== null);
}

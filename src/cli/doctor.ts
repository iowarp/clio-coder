import { type ClioSettings, readSettings } from "../core/config.js";
import {
	type DoctorFinding,
	formatDoctorReport,
	isUninitializedHome,
	runDoctor,
	runDoctorFleetChecks,
	runDoctorInteropChecks,
	runDoctorModelChecks,
	runDoctorRuntimeChecks,
} from "../domains/lifecycle/doctor.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../domains/safety/autonomy.js";
import {
	describeHostCapacity,
	observeHostCapacityFacts,
	resolveLocalConcurrency,
} from "../domains/scheduling/local-capacity.js";
import { classifyDefaultTarget, describeVerdict } from "./default-target.js";
import { hpcToolchainFindings } from "./doctor-hpc.js";
import { namingHistoryFindings } from "./doctor-naming.js";
import { panesFindings } from "./doctor-panes.js";
import { slurmMcpFindings } from "./doctor-slurm.js";
import { stateStorageFinding } from "./doctor-state-size.js";
import { taskWorktreeFindings } from "./doctor-task-worktrees.js";
import { toolchainFindings } from "./doctor-toolchain.js";
import { validationContractFinding } from "./doctor-validation-contract.js";
import { printError } from "./shared.js";

const HELP = `clio-coder doctor [--fix] [--json] [--verbose] [--deep [--tools-timeout <seconds>]]

Diagnose Clio Coder state without creating files. The first row says whether
chat can run and what to run when it cannot. On a home Clio has never
written to, doctor says so in one row and exits 0. Use --fix to repair structure:
missing directories, missing template files, and credential permissions.
--fix also repairs retired enum values and YAML 1.1 on/off booleans in settings,
preserving comments and formatting. Plain doctor reports the proposed repairs.
--fix also records the fleet preflight, which is what admits an SSH node to
dispatch for the current project root; plain doctor only reports it.
Settings are validated directly against the current schema.
Pass --json to emit a machine-readable report on stdout.
The text report folds the toolchain, interop, slurm, and naming rows into one
row per family while none of them needs attention; --verbose prints every row.
--deep adds a live tool-call probe on every configured target, which can load
a cold local model and releases it afterwards, and a dry run of the workspace
validation contract that resolves each validator command and reports whether
it would run without an approval ask at the configured autonomy. The dry run
executes nothing. --tools-timeout bounds each tool probe (default 120).
`;

export interface DoctorDeepOptions {
	/** The providers contract to probe with; the CLI loads its own when absent. */
	providers?: ProvidersContract;
	/** Tool-probe generation timeout in ms. */
	toolsTimeoutMs?: number;
	/** Autonomy the dry run judges against; the configured level when absent. */
	autonomy?: AutonomyLevel;
}

export interface DoctorCollectOptions {
	fix?: boolean;
	/** Run the deep checks as well. */
	deep?: DoctorDeepOptions | false;
	workspaceRoot?: string;
}

function configuredAutonomy(): AutonomyLevel {
	try {
		return readSettings().safety.autonomy;
	} catch {
		return DEFAULT_AUTONOMY_LEVEL;
	}
}

async function deepFindings(
	untouched: boolean,
	workspaceRoot: string,
	deep: DoctorDeepOptions,
): Promise<DoctorFinding[]> {
	// Loaded on demand, as the model sweep loads the runtimes: plain doctor
	// never pays for the providers domain or the policy engine.
	const { contractDryRunFindings, deepToolProbeFindings } = await import("./doctor-deep.js");
	const probeOptions = deep.toolsTimeoutMs !== undefined ? { toolsTimeoutMs: deep.toolsTimeoutMs } : {};
	let toolRows: DoctorFinding[] = [];
	if (deep.providers) {
		toolRows = await deepToolProbeFindings(deep.providers, probeOptions);
	} else if (!untouched) {
		// The providers domain is loaded only when there is a target to probe:
		// loading it on a home with no targets would cost a domain boot for
		// nothing, and on an untouched home there are no settings to read.
		let targetCount = 0;
		try {
			targetCount = readSettings().targets.length;
		} catch {
			// The settings row already reports an unreadable document.
		}
		if (targetCount > 0) {
			const [{ loadDomains }, { ConfigDomainModule }, { ProvidersDomainModule }] = await Promise.all([
				import("../core/domain-loader.js"),
				import("../domains/config/index.js"),
				import("../domains/providers/index.js"),
			]);
			const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
			try {
				const providers = loaded.getContract<ProvidersContract>("providers");
				if (providers) toolRows = await deepToolProbeFindings(providers, probeOptions);
			} finally {
				await loaded.stop();
			}
		}
	}
	const contractRows = contractDryRunFindings({ workspaceRoot, autonomy: deep.autonomy ?? configuredAutonomy() });
	return [...toolRows, ...contractRows];
}

const SETUP_COMMAND = "run `clio-coder configure` to choose one";

/**
 * Whether chat can run: a target, a model, and a credential where one is
 * needed. It leads the report because a fresh home read healthy from top to
 * bottom while `clio-coder run` could not answer; no row named the missing
 * target. The verdict is the one the bare launch acts on (default-target.ts),
 * so doctor and startup never disagree about what is missing. A WARN and not
 * an error: an unconfigured home is not a broken one, and `doctor --fix` on a
 * fresh home still exits 0.
 */
function chatReadinessFinding(untouched: boolean, connectionRows: ReadonlyArray<DoctorFinding>): DoctorFinding {
	const warn = (detail: string): DoctorFinding => ({ ok: true, level: "warn", name: "chat", detail });
	// No settings to read, and reading them through the ensuring accessors
	// would create the home doctor promised to leave alone.
	if (untouched) return warn(`cannot run yet: no model target is configured; ${SETUP_COMMAND}`);
	let settings: ClioSettings;
	try {
		settings = readSettings();
	} catch {
		return warn("cannot run until settings.yaml loads; the settings.yaml row says why");
	}
	const verdict = classifyDefaultTarget(settings);
	if (verdict.kind === "no-target") return warn(`cannot run yet: no model target is configured; ${SETUP_COMMAND}`);
	if (verdict.kind === "ineligible-runtime") {
		return warn(`cannot run: ${describeVerdict(verdict)} Run \`clio-coder configure\` to choose a chat target.`);
	}
	const targetId = settings.chat.target ?? "";
	const model = settings.chat.model?.trim();
	if (!model) {
		return warn(
			`cannot run yet: target '${targetId}' has no chat model; run \`clio-coder targets use ${targetId} --model <model>\``,
		);
	}
	const route = `target '${targetId}', model '${model}'`;
	if (verdict.kind === "missing-credential") {
		return warn(
			`${route}; no stored credential under '${verdict.store}'; run \`clio-coder auth login ${verdict.store}\` if the endpoint requires one`,
		);
	}
	const failing = connectionRows.filter(
		(row) =>
			(row.name === `connection ${targetId}` || row.name === `model ${targetId}`) && (!row.ok || row.level === "warn"),
	);
	if (failing.length > 0) {
		const checks = failing.map((row) => `\`${row.name}\``).join(" and ");
		return warn(`${route}; configured, but ${checks} below did not pass`);
	}
	const connection = connectionRows.find((row) => row.name === `connection ${targetId}`);
	const reachable = connection !== undefined && (connection.level === undefined || connection.level === "ok");
	return {
		ok: true,
		name: "chat",
		detail: reachable ? `${route}; endpoint reachable` : `${route}; reachability is checked on the first request`,
	};
}

/**
 * Row families the text report folds into one row each. A first run printed
 * 50 rows, most of them compilers, peer agents, and history scans a new user
 * has no reason to read. A member that needs attention (WARN or error) always
 * keeps its own row; `--verbose` and `--json` keep every row.
 */
interface FoldedFamily {
	name: string;
	/** The member's short name, or null when the row is not in this family. */
	member: (row: DoctorFinding) => string | null;
	/** How the summary labels OK members and INFO members. */
	ok: string;
	info: string;
	hint?: string;
}

const prefixed =
	(prefix: string, except: ReadonlyArray<string> = []) =>
	(row: DoctorFinding): string | null =>
		row.name.startsWith(prefix) && !except.includes(row.name) ? row.name.slice(prefix.length) : null;

const FOLDED_FAMILIES: ReadonlyArray<FoldedFamily> = [
	{
		name: "interop",
		member: prefixed("interop ", ["interop skills"]),
		ok: "on PATH",
		info: "noted",
		hint: "`clio-coder configure --interop` reviews them",
	},
	{ name: "toolchain", member: prefixed("toolchain "), ok: "found", info: "not on PATH" },
	{ name: "slurm", member: prefixed("slurm "), ok: "ready", info: "not set up" },
	{ name: "naming", member: prefixed("naming "), ok: "clean", info: "noted" },
];

/** The report's rows with each quiet family folded, and how many rows the folds absorbed. */
function foldDoctorFindings(findings: ReadonlyArray<DoctorFinding>): {
	findings: DoctorFinding[];
	folded: number;
} {
	const quiet = (row: DoctorFinding) =>
		row.ok && (row.level === undefined || row.level === "ok" || row.level === "info");
	const familyOf = new Map<DoctorFinding, FoldedFamily>();
	const members = new Map<FoldedFamily, Array<{ member: string; info: boolean }>>();
	for (const row of findings) {
		if (!quiet(row)) continue;
		for (const family of FOLDED_FAMILIES) {
			const member = family.member(row);
			if (member === null) continue;
			familyOf.set(row, family);
			members.set(family, [...(members.get(family) ?? []), { member, info: row.level === "info" }]);
			break;
		}
	}
	const out: DoctorFinding[] = [];
	let folded = 0;
	const placed = new Set<FoldedFamily>();
	for (const row of findings) {
		const family = familyOf.get(row);
		const rows = family === undefined ? [] : (members.get(family) ?? []);
		// A lone member folds into nothing shorter than itself.
		if (family === undefined || rows.length < 2) {
			out.push(row);
			continue;
		}
		if (placed.has(family)) continue;
		placed.add(family);
		folded += rows.length;
		const okNames = rows.filter((entry) => !entry.info).map((entry) => entry.member);
		const infoNames = rows.filter((entry) => entry.info).map((entry) => entry.member);
		const parts = [
			okNames.length > 0 ? `${family.ok}: ${okNames.join(", ")}` : null,
			infoNames.length > 0 ? `${family.info}: ${infoNames.join(", ")}` : null,
			family.hint ?? null,
		].filter((part): part is string => part !== null);
		out.push({
			ok: true,
			...(okNames.length === 0 ? { level: "info" as const } : {}),
			name: family.name,
			detail: parts.join("; "),
		});
	}
	return { findings: out, folded };
}

/**
 * Every doctor check in report order. The CLI prints these; the TUI's
 * `/doctor` renders the same list in-session and passes its own providers
 * contract so the deep probe runs against the session's targets.
 */
export async function collectDoctorFindings(options: DoctorCollectOptions = {}): Promise<DoctorFinding[]> {
	const fix = options.fix === true;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	// Decided before runDoctor so a --fix run, which initializes the home, still
	// gets every check on the home it just built.
	const untouched = !fix && isUninitializedHome();
	const findings = runDoctor({ fix });
	const hostFacts = observeHostCapacityFacts();
	const localCapacity: DoctorFinding = {
		ok: true,
		name: "local worker capacity",
		detail: describeHostCapacity(hostFacts, resolveLocalConcurrency("auto", hostFacts)),
	};
	let panesEnabled = false;
	let filesEnabled = false;
	try {
		const panes = readSettings().interface.panes;
		panesEnabled = panes.enabled !== "off";
		filesEnabled = panesEnabled && panes.files.enabled;
	} catch {
		// The settings finding already reports an unreadable document. Optional
		// integrations stay inactive rather than adding secondary warnings.
	}
	const storageChecks = untouched ? [] : [stateStorageFinding()];
	const runtimeChecks = await runDoctorRuntimeChecks();
	// Every model pointer is checked against what its target advertises, so a
	// placeholder id saved by configure is reported here and not on the first turn.
	const modelChecks = await runDoctorModelChecks();
	// The interop and fleet sweeps read the state and config roots through the
	// ensuring accessors, which create them, and there is no fleet or interop
	// state to inspect before Clio has ever written anything. On a home Clio has
	// never touched, doctor keeps its promise to create nothing.
	const interopChecks = untouched ? [] : await runDoctorInteropChecks();
	// Fleet preflight probes each configured node over SSH and persists the
	// per-node eligibility verdicts dispatch placement enforces.
	const fleetChecks = untouched ? [] : await runDoctorFleetChecks(workspaceRoot, { fix });
	// Resolution reads PATH and the vendor root and creates nothing, but on an
	// untouched home there is no vendor root to look at and the answer would be
	// "none" for every row regardless, so the sweep stays with the others.
	const toolChecks = untouched ? [] : toolchainFindings({ panesEnabled, filesEnabled, fix });
	// Compilers, MPI, build systems, and the scheduler. Each probe resolves PATH
	// and runs a bounded `--version` in a scratch directory, so it creates
	// nothing and runs on an untouched home too.
	const hpcChecks = await hpcToolchainFindings({ workspaceRoot });
	// Slurm through the clio-kit MCP server. PATH lookups and two bounded
	// clio-kit spawns; the mcp.yaml lookup is skipped on an untouched home.
	const sbatchFinding = hpcChecks.find((finding) => finding.name === "toolchain sbatch");
	const slurmChecks = await slurmMcpFindings({ workspaceRoot, untouched, ...(sbatchFinding ? { sbatchFinding } : {}) });
	// The pane sweep pings a socket and reads PATH; it creates nothing except the
	// journal directory it is asked about, which is inside the state root doctor
	// has already agreed not to build on an untouched home.
	const paneChecks = untouched ? [] : await panesFindings();
	const namingChecks = namingHistoryFindings();
	// The validation contract lives in the workspace, not the home, so it is
	// checked on every run: a broken contract is why rigor stayed normal.
	const contractChecks = [validationContractFinding(workspaceRoot)];
	// Task worktrees live in the workspace too. The sweep reads claims and asks
	// git; it removes nothing.
	const worktreeChecks = taskWorktreeFindings(workspaceRoot, { fix });
	const deepChecks = options.deep ? await deepFindings(untouched, workspaceRoot, options.deep) : [];
	return [
		chatReadinessFinding(untouched, modelChecks),
		...findings,
		localCapacity,
		...storageChecks,
		...runtimeChecks,
		...modelChecks,
		...interopChecks,
		...fleetChecks,
		...toolChecks,
		...hpcChecks,
		...slurmChecks,
		...paneChecks,
		...namingChecks,
		...contractChecks,
		...worktreeChecks,
		...deepChecks,
	];
}

/**
 * In-session diagnostics: structured findings for the TUI card, plus the plain
 * report for hosts without a card renderer, at the level of the worst row.
 */
export function doctorNotice(findings: ReadonlyArray<DoctorFinding>): {
	level: "success" | "warn" | "error";
	text: string;
	findings: ReadonlyArray<DoctorFinding>;
} {
	const errors = findings.filter((f) => !f.ok).length;
	const warnings = findings.filter((f) => f.ok && f.level === "warn").length;
	const level = errors > 0 ? "error" : warnings > 0 ? "warn" : "success";
	const head = `doctor: ${findings.length} checks, ${errors} error(s), ${warnings} warning(s)`;
	return { level, text: `${head}\n${formatDoctorReport([...findings])}`, findings };
}

interface DoctorArgs {
	fix: boolean;
	json: boolean;
	verbose: boolean;
	deep: boolean;
	toolsTimeoutMs?: number;
}

function parseDoctorArgs(args: ReadonlyArray<string>): DoctorArgs {
	const parsed: DoctorArgs = { fix: false, json: false, verbose: false, deep: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--fix") parsed.fix = true;
		else if (arg === "--json") parsed.json = true;
		else if (arg === "--verbose") parsed.verbose = true;
		else if (arg === "--deep") parsed.deep = true;
		else if (arg === "--tools-timeout") {
			const value = args[i + 1];
			const seconds = value === undefined ? Number.NaN : Number(value);
			if (!Number.isFinite(seconds) || seconds <= 0)
				throw new Error("--tools-timeout requires a positive number of seconds");
			parsed.toolsTimeoutMs = Math.round(seconds * 1000);
			i += 1;
		} else throw new Error(`unknown flag: ${arg}`);
	}
	if (parsed.toolsTimeoutMs !== undefined && !parsed.deep) throw new Error("--tools-timeout requires --deep");
	return parsed;
}

export async function runDoctorCommand(args: ReadonlyArray<string> = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	let parsed: DoctorArgs;
	try {
		parsed = parseDoctorArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	const { fix, json } = parsed;
	const all = await collectDoctorFindings({
		fix,
		deep: parsed.deep ? (parsed.toolsTimeoutMs !== undefined ? { toolsTimeoutMs: parsed.toolsTimeoutMs } : {}) : false,
	});
	const ok = all.every((f) => f.ok);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok, fix, deep: parsed.deep, findings: all }, null, 2)}\n`);
	} else if (parsed.verbose) {
		process.stdout.write(`${formatDoctorReport(all)}\n`);
	} else {
		const report = foldDoctorFindings(all);
		// One write: a reader such as `| head` that closes the pipe after the
		// first rows would turn a second write into an EPIPE crash.
		const trailer =
			report.folded > 0 ? `${report.folded} rows folded; \`clio-coder doctor --verbose\` prints each one\n` : "";
		process.stdout.write(`${formatDoctorReport(report.findings)}\n${trailer}`);
	}
	return ok ? 0 : 1;
}

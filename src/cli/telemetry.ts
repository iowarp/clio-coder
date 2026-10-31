import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { clioStateDir } from "../core/xdg.js";
import type { BundleContentClass } from "../domains/telemetry/bundle.js";
import { exportTelemetryBundle, importTelemetryBundle } from "../domains/telemetry/bundle.js";
import {
	grantTelemetryConsent,
	readTelemetryConsent,
	resolveConsentWorkspace,
	revokeTelemetryConsent,
	workspaceTelemetryCapture,
} from "../domains/telemetry/consent.js";
import {
	telemetryJournalPath,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "../domains/telemetry/index.js";
import { applyTelemetryPrune, DEFAULT_PRUNE_POLICY, planTelemetryPrune } from "../domains/telemetry/retention.js";
import { printError } from "./shared.js";

const HELP = `clio-coder telemetry consent [--workspace <dir>] [--revoke | --list]
clio-coder telemetry export <session-id> --out <dir> [--content-free | --structural | --research]
clio-coder telemetry import-bundle <bundle-dir> --out <dir>
clio-coder telemetry prune [--apply] [--days N] [--max-gib N] [--research-days N] [--research-max-gib N]
clio-coder telemetry verify <scope-dir> [--json]
clio-coder telemetry doctor [--json]

consent records, for this operator, that research content capture may run in a
workspace (default: the current directory) and everything under it. Capture also
needs telemetry.mode: research and telemetry.research.content: true. The record
lives in Clio's state directory, never in the workspace. --revoke deletes it;
content captured before that stays in the sessions that recorded it. --list
shows every consent.

export writes one session's telemetry as a bundle directory: bundle.json with
the capture ceiling, the content class and a sha256 and record count per file,
journal.jsonl with the journal's kept lines verbatim, each referenced run's
journal.jsonl, and the objects those records reference. --content-free, the
default, keeps only content-free records and no objects. --structural adds the
structural records and their objects, such as settings and prompt structure.
--research adds content records, content objects and the session ledger, and
needs research mode, telemetry.research.content and consent for the session's
workspace.

import-bundle verifies every hash, count, checksum, schema and the ceiling of a
bundle and writes the verified copy to --out, which is also the golden fixture
layout. Neither command overwrites an existing directory.

prune lists, oldest first, the telemetry it would remove: session call journals
and their objects past --days (90) or over --max-gib (1) in total, unreferenced
run journals by the same rule, objects no record cites, and research content
past --research-days (30) or over --research-max-gib (4). It never touches a
live or locked session or run, a fork parent a kept child reads, or a run a
kept journal references, and a session it cannot fully read keeps
its objects. Research content expires before the records that cite it, which
then read as missing.
The run ledger is not a telemetry journal and stays. Nothing
is deleted without --apply, which re-checks each owner first and prints every
file it removed.

verify checks a sealed scope directory (a session, run or process directory under
the telemetry root) with nothing but its own files: every segment and object
bundle.json lists against its size and sha256, the journal hash chain from the
first segment header, and the seal record's head, line count and file lists. It
prints verified, unsealed (live or never sealed) or failed with the first
mismatch, and exits 0 only when the scope verifies, 2 on a usage error.

doctor shows the effective capture mode for the current directory against what
settings request, the research content consent that covers it, the newest
session journal's health through the read model (records, skipped and damaged
lines, gaps, duplicates), and the seal state of every session, run and process
scope: a scope with bundle.json is verified as verify does, any other counts as
unsealed. It exits 1 when a seal fails, the consent store is unreadable or the
newest journal has damaged lines.
`;

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${bytes} B`;
}

async function runPrune(argv: ReadonlyArray<string>): Promise<number> {
	const policy = { ...DEFAULT_PRUNE_POLICY };
	const numeric: Record<string, (value: number) => void> = {
		"--days": (value) => {
			policy.days = value;
		},
		"--max-gib": (value) => {
			policy.maxBytes = value * 1024 ** 3;
		},
		"--research-days": (value) => {
			policy.researchDays = value;
		},
		"--research-max-gib": (value) => {
			policy.researchMaxBytes = value * 1024 ** 3;
		},
	};
	let apply = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		const set = numeric[arg];
		const value = Number(argv[index + 1]);
		if (arg === "--apply") apply = true;
		else if (set && Number.isFinite(value) && value > 0) {
			set(value);
			index += 1;
		} else {
			process.stderr.write(HELP);
			return 2;
		}
	}
	const stateDir = clioStateDir();
	let plan: Awaited<ReturnType<typeof planTelemetryPrune>>;
	try {
		plan = await planTelemetryPrune(stateDir, policy);
	} catch (error) {
		printError(`cannot plan telemetry prune: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	for (const hold of plan.held) process.stdout.write(`kept ${hold.path} (${hold.reason})\n`);
	const total = plan.remove.reduce((sum, action) => sum + action.bytes, 0);
	if (!apply) {
		for (const action of plan.remove)
			process.stdout.write(`would remove ${action.path} (${formatBytes(action.bytes)}, ${action.reason})\n`);
		process.stdout.write(
			`dry run: ${plan.remove.length} file(s), ${formatBytes(total)} of ${formatBytes(plan.standardBytes)} standard and ${formatBytes(plan.researchBytes)} research telemetry; nothing removed (pass --apply)\n`,
		);
		return 0;
	}
	const result = await applyTelemetryPrune(plan);
	for (const action of result.removed)
		process.stdout.write(`removed ${action.path} (${formatBytes(action.bytes)}, ${action.reason})\n`);
	for (const skipped of result.skipped) process.stdout.write(`skipped ${skipped.path} (${skipped.reason})\n`);
	const removed = result.removed.reduce((sum, action) => sum + action.bytes, 0);
	process.stdout.write(
		`removed ${result.removed.length} file(s), ${formatBytes(removed)}; skipped ${result.skipped.length}\n`,
	);
	return 0;
}

/**
 * A session's journal is keyed by its id alone; its store directory, which holds meta.json and the ledger, is
 * named by id under its workspace hash and is null when no bucket holds it (#434).
 */
function findSession(stateDir: string, sessionId: string): { store: string | null } | null {
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
	if (!existsSync(telemetryJournalPath(telemetrySessionDirectory(stateDir, sessionId)))) return null;
	let buckets: string[] = [];
	try {
		buckets = readdirSync(join(stateDir, "sessions")).sort();
	} catch {
		// No session store: the journal exports without a ledger.
	}
	for (const bucket of buckets) {
		const directory = join(stateDir, "sessions", bucket, sessionId);
		if (existsSync(join(directory, "meta.json"))) return { store: directory };
	}
	return { store: null };
}

function packageWriter(): { clioCoderVersion: string; piVersion: string } {
	const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		version: string;
		dependencies: Record<string, string>;
	};
	return { clioCoderVersion: pkg.version, piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown" };
}

function parseOut(
	argv: ReadonlyArray<string>,
	flags: ReadonlyArray<string>,
): { positional: string; out: string; flags: Set<string> } | null {
	let positional: string | undefined;
	let out: string | undefined;
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--out" && out === undefined && argv[index + 1]?.startsWith("--") === false) {
			out = argv[index + 1];
			index += 1;
		} else if (flags.includes(arg)) seen.add(arg);
		else if (!arg.startsWith("--") && positional === undefined) positional = arg;
		else return null;
	}
	return positional === undefined || out === undefined ? null : { positional, out: resolve(out), flags: seen };
}

async function runExport(argv: ReadonlyArray<string>): Promise<number> {
	const args = parseOut(argv, ["--content-free", "--structural", "--research"]);
	if (!args || args.flags.size > 1) {
		process.stderr.write(HELP);
		return 2;
	}
	const stateDir = clioStateDir();
	const session = findSession(stateDir, args.positional);
	if (!session) {
		printError(`no session ${args.positional} with a call journal under ${telemetrySessionsDirectory(stateDir)}`);
		return 1;
	}
	const contentClass: BundleContentClass = args.flags.has("--research")
		? "content-bearing"
		: args.flags.has("--structural")
			? "structural"
			: "content-free";
	if (contentClass === "content-bearing") {
		// Content leaves the journal only as the operator captured it: research mode, the flag and consent (#434, O6).
		let cwd: unknown;
		try {
			cwd =
				session.store === null
					? undefined
					: (JSON.parse(readFileSync(join(session.store, "meta.json"), "utf8")) as { cwd?: unknown }).cwd;
		} catch {
			cwd = undefined;
		}
		const allowed =
			typeof cwd === "string" &&
			workspaceTelemetryCapture(readLayeredSettings(cwd).settings.telemetry, stateDir, cwd).capture.capture.content;
		if (!allowed) {
			printError(
				"--research needs telemetry.mode: research, telemetry.research.content: true and clio-coder telemetry consent for the session's workspace",
			);
			return 1;
		}
	}
	try {
		const manifest = await exportTelemetryBundle({
			stateDir,
			sessionId: args.positional,
			sessionStore: session.store,
			out: args.out,
			contentClass,
			writer: packageWriter(),
		});
		const excluded = manifest.excluded;
		process.stdout.write(
			`exported session ${args.positional} to ${args.out}: ${manifest.files.length} file(s), ${manifest.source.runs.length} run(s), ${manifest.contentClass}, ceiling ${manifest.ceiling.mode}${manifest.ceiling.capture.content ? " with content" : ""}; left out ${excluded.contentBearing} content record(s), ${excluded.structural ?? 0} structural record(s), ${excluded.withheldObjects ?? 0} withheld object(s), ${excluded.unclassified} unclassified line(s), ${excluded.tornTailBytes} unfinished byte(s), ${excluded.missingRuns.length} missing run(s), ${excluded.missingObjects.length} missing object(s)\n`,
		);
		return 0;
	} catch (error) {
		printError(`cannot export session ${args.positional}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

async function runImportBundle(argv: ReadonlyArray<string>): Promise<number> {
	const args = parseOut(argv, []);
	if (!args) {
		process.stderr.write(HELP);
		return 2;
	}
	try {
		const imported = await importTelemetryBundle(resolve(args.positional), args.out);
		process.stdout.write(
			`verified ${imported.records} record(s), ${imported.calls} settled call(s), ${imported.runs} run journal(s) and ${imported.objects} object(s); ${imported.unreadable} record(s) this version cannot read kept verbatim; wrote ${args.out}\n`,
		);
		return 0;
	} catch (error) {
		printError(`cannot import bundle: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

function runConsent(argv: ReadonlyArray<string>): number {
	let workspaceArg: string | undefined;
	let revoke = false;
	let list = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--revoke") revoke = true;
		else if (arg === "--list") list = true;
		else if (arg === "--workspace" && workspaceArg === undefined && argv[index + 1]?.startsWith("--") === false) {
			workspaceArg = argv[index + 1];
			index += 1;
		} else {
			process.stderr.write(HELP);
			return 2;
		}
	}
	if (list && (revoke || workspaceArg !== undefined)) {
		process.stderr.write(HELP);
		return 2;
	}
	const stateDir = clioStateDir();
	if (list) {
		const read = readTelemetryConsent(stateDir);
		if (read.error) {
			printError(`telemetry consent store is unreadable: ${read.error}`);
			return 1;
		}
		if (read.entries.length === 0) process.stdout.write("no workspace has research content consent\n");
		for (const entry of read.entries)
			process.stdout.write(
				`${entry.workspace}  granted ${entry.grantedAt} by ${entry.grantedBy.user}@${entry.grantedBy.host}\n`,
			);
		return 0;
	}
	const requested = workspaceArg ?? process.cwd();
	let workspace: string;
	try {
		workspace = resolveConsentWorkspace(requested);
	} catch (error) {
		// A workspace that no longer exists can still be revoked by the path it was granted under.
		if (!revoke) {
			printError(`cannot resolve workspace ${requested}: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
		workspace = resolve(requested);
	}
	try {
		if (revoke) {
			const removed = revokeTelemetryConsent(stateDir, workspace);
			process.stdout.write(
				removed
					? `revoked research content consent for ${workspace} (granted ${removed.grantedAt} by ${removed.grantedBy.user}@${removed.grantedBy.host}); content already captured stays in the sessions that recorded it\n`
					: `no research content consent is recorded for ${workspace}\n`,
			);
			return 0;
		}
		const granted = grantTelemetryConsent(stateDir, workspace);
		process.stdout.write(
			`${granted.existed ? "research content consent already recorded" : "recorded research content consent"} for ${workspace} (${granted.entry.grantedAt}); capture runs there only with telemetry.mode: research and telemetry.research.content: true\n`,
		);
		return 0;
	} catch (error) {
		printError(`cannot update telemetry consent: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/** The read model's commands; its module, the folds and the session loader load only for them. */
const READ_COMMANDS = new Set(["inspect", "calls", "cost", "cache", "timeline", "why-stopped", "explain"]);

export async function runTelemetryCommand(argv: ReadonlyArray<string>): Promise<number> {
	if (argv[0] === "--help" || argv[0] === "-h") {
		process.stdout.write(`${(await import("./telemetry-read.js")).READ_HELP}${HELP}`);
		return 0;
	}
	if (argv[0] !== undefined && READ_COMMANDS.has(argv[0]))
		return (await import("./telemetry-read.js")).runTelemetryReadCommand(argv);
	if (argv[0] === "consent") return runConsent(argv.slice(1));
	if (argv[0] === "export") return runExport(argv.slice(1));
	if (argv[0] === "import-bundle") return runImportBundle(argv.slice(1));
	if (argv[0] === "prune") return runPrune(argv.slice(1));
	if (argv[0] === "verify") return (await import("./telemetry-verify.js")).runTelemetryVerify(argv.slice(1));
	if (argv[0] === "doctor") return (await import("./telemetry-doctor.js")).runTelemetryDoctor(argv.slice(1));
	if (argv[0] !== undefined) printError(`unknown telemetry command: ${argv[0]}`);
	process.stderr.write(HELP);
	return 2;
}

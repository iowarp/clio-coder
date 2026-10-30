import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { encodeTelemetryLine } from "../core/telemetry/segment.js";
import { clioStateDir } from "../core/xdg.js";
import { exportTelemetryBundle, importTelemetryBundle } from "../domains/observability/bundle.js";
import { callJournalHeader } from "../domains/observability/call-journal.js";
import {
	grantTelemetryConsent,
	readTelemetryConsent,
	resolveConsentWorkspace,
	revokeTelemetryConsent,
	workspaceTelemetryCapture,
} from "../domains/observability/consent.js";
import { readOutOfTurnUsageRows } from "../domains/observability/out-of-turn-usage.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { isSessionEntry } from "../domains/session/entries.js";
import { importLegacySession } from "../domains/session/legacy-import.js";
import { printError } from "./shared.js";

const HELP = `clio-coder telemetry import-legacy <session-dir> --out <file>
clio-coder telemetry consent [--workspace <dir>] [--revoke | --list]
clio-coder telemetry export <session-id> --out <dir> [--content]
clio-coder telemetry import-bundle <bundle-dir> --out <dir>

import-legacy rebuilds call facts from a session ledger written before the call
journal (#434). Each assistant message and out-of-turn row becomes one call with
the facts the ledger recorded; everything else stays unknown. The journal segment
is written to --out, never into the session directory.

consent records, for this operator, that research content capture may run in a
workspace (default: the current directory) and everything under it. Capture also
needs telemetry.mode: research and telemetry.research.content: true. The record
lives in Clio's state directory, never in the workspace. --revoke deletes it;
content captured before that stays in the sessions that recorded it. --list
shows every consent.

export writes one session's telemetry as a bundle directory: bundle.json with
the capture ceiling and a sha256 and record count per file, calls.jsonl with the
journal's lines verbatim, each referenced run's events.ndjson, and only the
objects those records reference. It is content-free unless --content, which
also needs research mode, telemetry.research.content and consent for the
session's workspace, and then includes the session ledger.

import-bundle verifies every hash, count, checksum, schema and the ceiling of a
bundle and writes the verified copy to --out, which is also the golden fixture
layout. Neither command overwrites an existing directory.
`;

/** Session directories are named by id under their workspace hash; ids never cross workspaces. */
function findSession(stateDir: string, sessionId: string): { cwdHash: string; directory: string } | null {
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
	let buckets: string[];
	try {
		buckets = readdirSync(join(stateDir, "sessions"));
	} catch {
		return null;
	}
	for (const cwdHash of buckets) {
		const directory = join(stateDir, "sessions", cwdHash, sessionId);
		if (existsSync(join(directory, "calls.jsonl"))) return { cwdHash, directory };
	}
	return null;
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
	const args = parseOut(argv, ["--content"]);
	if (!args) {
		process.stderr.write(HELP);
		return 2;
	}
	const stateDir = clioStateDir();
	const session = findSession(stateDir, args.positional);
	if (!session) {
		printError(`no session ${args.positional} with a call journal under ${join(stateDir, "sessions")}`);
		return 1;
	}
	const content = args.flags.has("--content");
	if (content) {
		// Content leaves the journal only as the operator captured it: research mode, the flag and consent (#434, O6).
		let cwd: unknown;
		try {
			cwd = (JSON.parse(readFileSync(join(session.directory, "meta.json"), "utf8")) as { cwd?: unknown }).cwd;
		} catch {
			cwd = undefined;
		}
		const allowed =
			typeof cwd === "string" &&
			workspaceTelemetryCapture(readLayeredSettings(cwd).settings.telemetry, stateDir, cwd).capture.capture.content;
		if (!allowed) {
			printError(
				"--content needs telemetry.mode: research, telemetry.research.content: true and clio-coder telemetry consent for the session's workspace",
			);
			return 1;
		}
	}
	try {
		const manifest = await exportTelemetryBundle({
			stateDir,
			cwdHash: session.cwdHash,
			sessionId: args.positional,
			out: args.out,
			content,
			writer: packageWriter(),
		});
		const excluded = manifest.excluded;
		process.stdout.write(
			`exported session ${args.positional} to ${args.out}: ${manifest.files.length} file(s), ${manifest.source.runs.length} run(s), ceiling ${manifest.ceiling.mode}${manifest.ceiling.capture.content ? " with content" : ", content-free"}; left out ${excluded.contentBearing} content record(s), ${excluded.unclassified} unclassified line(s), ${excluded.tornTailBytes} unfinished byte(s), ${excluded.missingRuns.length} missing run(s), ${excluded.missingObjects.length} missing object(s)\n`,
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

function readLedger(directory: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of readFileSync(join(directory, "current.jsonl"), "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// A torn or foreign line carries no call; the import counts what it can read.
		}
	}
	return entries;
}

export async function runTelemetryCommand(argv: ReadonlyArray<string>): Promise<number> {
	const read = await import("./telemetry-read.js");
	if (argv[0] === "--help" || argv[0] === "-h") {
		process.stdout.write(`${read.READ_HELP}${HELP}`);
		return 0;
	}
	if (argv[0] !== undefined && read.READ_COMMANDS.has(argv[0])) return read.runTelemetryReadCommand(argv);
	if (argv[0] === "consent") return runConsent(argv.slice(1));
	if (argv[0] === "export") return runExport(argv.slice(1));
	if (argv[0] === "import-bundle") return runImportBundle(argv.slice(1));
	if (argv[0] !== "import-legacy") {
		if (argv[0] !== undefined) printError(`unknown telemetry command: ${argv[0]}`);
		process.stderr.write(HELP);
		return 2;
	}
	const outIndex = argv.indexOf("--out");
	const source = argv[1];
	const out = outIndex > 0 ? argv[outIndex + 1] : undefined;
	if (source === undefined || source.startsWith("--") || out === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	const directory = resolve(source);
	const target = resolve(out);
	if (existsSync(target)) {
		printError(`refusing to overwrite ${target}`);
		return 1;
	}
	let entries: SessionEntry[];
	try {
		entries = readLedger(directory);
	} catch (error) {
		printError(`cannot read session ledger: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const outOfTurn = readOutOfTurnUsageRows(clioStateDir());
	const imported = importLegacySession(basename(directory), entries, { outOfTurn: outOfTurn.rows });
	const header = callJournalHeader(packageWriter());
	safeResourceWrite(target, Buffer.concat([header, ...imported.records].map(encodeTelemetryLine)), { mode: 0o600 });
	const calls = imported.records.filter((record) => record.k === "call.settled").length;
	process.stdout.write(
		`imported ${calls} call(s) to ${target}; ${imported.aggregates} checkpoint aggregate(s) not split into calls; ${imported.invalid} invalid record(s) skipped; ${outOfTurn.errors.length} out-of-turn usage read error(s)\n`,
	);
	return 0;
}

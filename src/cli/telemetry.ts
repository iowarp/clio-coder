import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { encodeTelemetryLine } from "../core/telemetry/segment.js";
import { clioStateDir } from "../core/xdg.js";
import { callJournalHeader } from "../domains/observability/call-journal.js";
import {
	grantTelemetryConsent,
	readTelemetryConsent,
	resolveConsentWorkspace,
	revokeTelemetryConsent,
} from "../domains/observability/consent.js";
import { readOutOfTurnUsageRows } from "../domains/observability/out-of-turn-usage.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { isSessionEntry } from "../domains/session/entries.js";
import { importLegacySession } from "../domains/session/legacy-import.js";
import { printError } from "./shared.js";

const HELP = `clio-coder telemetry import-legacy <session-dir> --out <file>
clio-coder telemetry consent [--workspace <dir>] [--revoke | --list]

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
`;

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
	const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		version: string;
		dependencies: Record<string, string>;
	};
	const header = callJournalHeader({
		clioCoderVersion: pkg.version,
		piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown",
	});
	safeResourceWrite(target, Buffer.concat([header, ...imported.records].map(encodeTelemetryLine)), { mode: 0o600 });
	const calls = imported.records.filter((record) => record.k === "call.settled").length;
	process.stdout.write(
		`imported ${calls} call(s) to ${target}; ${imported.aggregates} checkpoint aggregate(s) not split into calls; ${imported.invalid} invalid record(s) skipped; ${outOfTurn.errors.length} out-of-turn usage read error(s)\n`,
	);
	return 0;
}

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { encodeTelemetryLine } from "../core/telemetry/segment.js";
import { clioStateDir } from "../core/xdg.js";
import { callJournalHeader } from "../domains/observability/call-journal.js";
import { readOutOfTurnUsageRows } from "../domains/observability/out-of-turn-usage.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { isSessionEntry } from "../domains/session/entries.js";
import { importLegacySession } from "../domains/session/legacy-import.js";
import { printError } from "./shared.js";

const HELP = `clio-coder telemetry import-legacy <session-dir> --out <file>

Rebuild call facts from a session ledger written before the call journal (#434).
Each assistant message and out-of-turn row becomes one call with the facts the
ledger recorded; everything else stays unknown. The journal segment is written
to --out, never into the session directory.
`;

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
	if (argv[0] === "--help" || argv[0] === "-h") {
		process.stdout.write(HELP);
		return 0;
	}
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
		clioVersion: pkg.version,
		piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown",
	});
	safeResourceWrite(target, Buffer.concat([header, ...imported.records].map(encodeTelemetryLine)), { mode: 0o600 });
	const calls = imported.records.filter((record) => record.k === "call.settled").length;
	process.stdout.write(
		`imported ${calls} call(s) to ${target}; ${imported.aggregates} checkpoint aggregate(s) not split into calls; ${imported.invalid} invalid record(s) skipped\n`,
	);
	return 0;
}

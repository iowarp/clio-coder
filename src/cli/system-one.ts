import { dirname, resolve } from "node:path";
import { readLayeredSettings } from "../core/settings-layers.js";
import {
	countDatasetRows,
	datasetDir,
	describeBindings,
	exportToFile,
	formatDatasetBytes,
	isDay,
	listDatasetFiles,
	summarizeDataset,
} from "../domains/system-one/recorder/index.js";
import type { SiteId } from "../domains/system-one/types.js";
import { SITE_IDS } from "../domains/system-one/types.js";
import { formatColumns, printError, printNote } from "./shared.js";

const HELP = `clio-coder systemone status
clio-coder systemone export --out <file> [--since <YYYY-MM-DD>] [--site <site>]

System One answers typed questions about the operator's request, tool calls, tool
results and finished turns. With systemOne.record on, every call and what followed
it is kept under the state directory as a redacted local dataset.

status   whether recording is on, what the dataset holds, and where each site is bound
export   write one JSON line per decision to a local file, joined with the full text
         of its questions and every outcome recorded for it

Flags:
  --out <file>        destination of the export (required, replaced atomically)
  --since <day>       skip dataset days before this UTC day
  --site <site>       only this site: ${SITE_IDS.join(", ")}
`;

interface ParsedArgs {
	command?: string;
	out?: string;
	since?: string;
	site?: SiteId;
	help: boolean;
}

function flagValue(argv: ReadonlyArray<string>, index: number, flag: string, what: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires ${what}`);
	return value;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (out.command === undefined && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--out":
				out.out = flagValue(argv, i, arg, "a file path");
				i += 1;
				break;
			case "--since": {
				const day = flagValue(argv, i, arg, "a day as YYYY-MM-DD");
				if (!isDay(day)) throw new Error(`--since expects a day as YYYY-MM-DD, got ${day}`);
				out.since = day;
				i += 1;
				break;
			}
			case "--site": {
				const site = flagValue(argv, i, arg, `one of ${SITE_IDS.join(", ")}`);
				if (!(SITE_IDS as ReadonlyArray<string>).includes(site)) {
					throw new Error(`--site expects one of ${SITE_IDS.join(", ")}, got ${site}`);
				}
				out.site = site as SiteId;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

function runStatus(): number {
	const settings = readLayeredSettings(process.cwd()).settings;
	const { systemOne, targets } = settings;
	const summary = summarizeDataset();
	const rows: string[][] = [
		["record", systemOne.record ? "on" : "off (systemOne.record)"],
		["directory", summary.dir],
		["files", summary.files === 0 ? "none" : `${summary.files} (${summary.oldest} to ${summary.newest})`],
		["size", `${formatDatasetBytes(summary.bytes)} of ${systemOne.maxMiB} MiB, kept ${systemOne.retentionDays} days`],
	];
	if (summary.files > 0) {
		const counts = countDatasetRows(listDatasetFiles(summary.dir));
		rows.push([
			"rows",
			`decision ${counts.decision}, spec ${counts.spec}, outcome ${counts.outcome}` +
				(counts.unrecognized > 0 ? `, unrecognized ${counts.unrecognized}` : ""),
		]);
	}
	process.stdout.write(formatColumns(rows));
	process.stdout.write("\nsites\n");
	const sites = describeBindings(settings).map((binding) => {
		if (binding.engine === null) return [binding.site, "off"];
		if (binding.problem !== undefined) return [binding.site, `${binding.engine}: ${binding.problem}`];
		const deadline = binding.deadlineMs === undefined ? "" : `, deadline ${binding.deadlineMs} ms`;
		return [
			binding.site,
			`${binding.engine} (${binding.kind}) → ${binding.target}/${binding.model ?? "target default"}${deadline}`,
		];
	});
	process.stdout.write(formatColumns(sites.map((row) => ["", ...row])));
	if (targets.length === 0 && Object.keys(systemOne.sites).length > 0) {
		printNote("systemOne.sites names engines but no target is configured; run clio-coder targets add.");
	}
	return 0;
}

function runExport(parsed: ParsedArgs): number {
	if (parsed.out === undefined) {
		printError("export requires --out <file>");
		process.stderr.write(HELP);
		return 2;
	}
	const destination = resolve(parsed.out);
	if (dirname(destination) === datasetDir()) {
		printError("--out must not point into the dataset directory");
		return 2;
	}
	// The file holds redacted state, but redaction is best effort and the operator's own requests are in it.
	// Rows are streamed to the temp file, so a large dataset is never one string.
	const result = exportToFile(destination, {
		...(parsed.since !== undefined ? { since: parsed.since } : {}),
		...(parsed.site !== undefined ? { site: parsed.site } : {}),
	});
	process.stdout.write(
		`exported ${result.decisions} decision${result.decisions === 1 ? "" : "s"} from ${result.files} day file${result.files === 1 ? "" : "s"} to ${destination}\n`,
	);
	if (result.decisions === 0) printNote("no decisions matched; the file is empty.");
	if (result.missingSpecs > 0) {
		printNote(
			`${result.missingSpecs} question spec${result.missingSpecs === 1 ? "" : "s"} missing from the selected days.`,
		);
	}
	if (result.unreadableRows > 0)
		printNote(`${result.unreadableRows} unreadable row${result.unreadableRows === 1 ? "" : "s"} skipped.`);
	return 0;
}

export async function runSystemOneCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.command !== "status" && parsed.command !== "export") {
		if (parsed.command !== undefined) printError(`unknown systemone command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}
	try {
		return parsed.command === "status" ? runStatus() : runExport(parsed);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

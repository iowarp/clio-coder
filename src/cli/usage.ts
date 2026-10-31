import { resolve } from "node:path";
import { cwdHash } from "../core/cwd-hash.js";
import { clioStateDir } from "../core/xdg.js";
import { usageReport } from "../domains/telemetry/read-model.js";
import { emptyUsageDiagnostics, usageWindow } from "../domains/telemetry/usage-window.js";
import { printError } from "./shared.js";

const HELP = `clio-coder usage report [--repo <path>] [--days <n>] [--json]

Read-only telemetry report over the selected window. Tool decisions, approvals,
settled runs, tokens and spend come from the telemetry read model.

  --repo <path>   restrict the window to one repository
  --days <n>      window in days (default 30)
  --json          emit the read model's report DTO
`;
const DEFAULT_WINDOW_DAYS = 30;

interface ParsedArgs {
	command?: string;
	repo?: string;
	days: number;
	json: boolean;
	help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { days: DEFAULT_WINDOW_DAYS, json: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--repo": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--repo requires a path");
				out.repo = value;
				i += 1;
				break;
			}
			case "--days": {
				const value = argv[i + 1];
				const days = value === undefined ? Number.NaN : Number.parseInt(value, 10);
				if (!Number.isInteger(days) || days <= 0) throw new Error("--days requires a positive integer");
				out.days = days;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

export async function runUsageCommand(argv: ReadonlyArray<string>): Promise<number> {
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
	if (parsed.command !== "report") {
		if (parsed.command !== undefined) printError(`unknown usage command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}
	const now = Date.now();
	const from = now - parsed.days * 24 * 60 * 60 * 1000;
	const path = parsed.repo === undefined ? null : resolve(parsed.repo);
	const diagnostics = emptyUsageDiagnostics();
	const { repo } = await usageWindow(
		clioStateDir(),
		path === null ? null : { hash: cwdHash(path), inRepo: (cwd) => cwd === path },
		parsed.days,
		now,
		diagnostics,
	);
	const report = usageReport(repo, from, now);
	for (const note of diagnostics.notes) process.stderr.write(`clio-coder usage: ${note}\n`);
	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return 0;
	}
	const out = (text: string) => process.stdout.write(`${text}\n`);
	out(
		`usage report: ${new Date(from).toISOString()} -> ${new Date(now).toISOString()}${path === null ? "" : ` repo=${path}`}`,
	);
	out(`sessions in window: ${report.sessions.display}`);
	out(`dispatch runs in window: ${report.runs.display}`);
	out(`tool decisions: ${report.decisions.total.display} (${report.decisions.blocked.display} blocked/denied)`);
	const approvals = report.approvals;
	out(
		`permission decisions: ${approvals.requested.display} requested, ${approvals.granted.display} granted, ${approvals.denied.display} denied, ${approvals.expired.display} expired; approval rate ${approvals.rate.display}`,
	);
	out(
		`tokens: ${report.tokens.total.display} (input ${report.tokens.input.display}, output ${report.tokens.output.display})`,
	);
	for (const cost of report.cost) {
		out(`spend by ${cost.groupBy}: ${cost.total.usd.display}`);
		for (const group of cost.groups) out(`  ${group.key}: ${group.usd.display}`);
	}
	for (const tool of report.decisions.tools) out(`tool ${tool.tool}: ${tool.count.display} decisions`);
	return 0;
}

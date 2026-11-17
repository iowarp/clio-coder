import { clioStateDir } from "../core/xdg.js";
import type {
	TokenSourceInput,
	TokenSourceRow,
	TokenSourcesReportV1,
	TokenSourceTurn,
} from "../domains/session/token-sources.js";
import { loadTokenSourcesReport } from "../domains/session/token-sources.js";
import { formatColumns } from "./argv.js";
import { printError } from "./shared.js";

export const TOKENS_HELP = `clio-coder telemetry tokens --session <id> [--by-source] [--json]

tokens lists each turn of a session with its input tokens, cached and fresh, and
its output tokens. --by-source splits each turn's input by where it came from:
system prompt, skills, tool schemas, template body, extension effects (reminders
and tool-result annotations), tool results per tool, and history. Providers
report one input total per call, so the totals are measured and the split is
estimated from the session ledger and the journal's context snapshot; the
output header says so. --json emits the report verbatim.
`;

const count = (value: number | null) => (value === null ? "unknown" : String(value));

function rowCells(row: TokenSourceRow): string[] {
	return [`  ${row.label}`, count(row.cached), count(row.fresh), String(row.total)];
}

function inputCells(label: string, input: TokenSourceInput): string[] {
	return [label, count(input.cached), count(input.fresh), String(input.total)];
}

function turnHeading(turn: TokenSourceTurn): string {
	const unmeasured = turn.unmeasuredCalls > 0 ? ` · ${turn.unmeasuredCalls} unmeasured` : "";
	const cold = turn.coldReasons.length > 0 ? ` · cold: ${turn.coldReasons.join(", ")}` : "";
	return `turn ${turn.index} ${turn.at} · ${turn.calls} call(s)${unmeasured} · output ${turn.output}${cold}`;
}

export function renderTokenSources(report: TokenSourcesReportV1, bySource: boolean): string {
	const header = [
		`session ${report.sessionId} · usage from ${report.basis.usage} · system side from ${report.basis.systemSide}`,
		...(bySource ? [`note: ${report.basis.note}`] : []),
	];
	if (report.turns.length === 0) return `${header.join("\n")}\nno turns\n`;
	if (!bySource) {
		const table = formatColumns([
			["turn", "at", "calls", "cached", "fresh", "input", "output"],
			...report.turns.map((turn) => [
				String(turn.index),
				turn.at,
				String(turn.calls),
				count(turn.input.cached),
				count(turn.input.fresh),
				String(turn.input.total),
				String(turn.output),
			]),
			[
				"all",
				"",
				String(report.totals.calls),
				count(report.totals.input.cached),
				count(report.totals.input.fresh),
				String(report.totals.input.total),
				String(report.totals.output),
			],
		]);
		return `${header.join("\n")}\n\n${table}`;
	}
	const sections = report.turns.map(
		(turn) =>
			`${turnHeading(turn)}\n${formatColumns([
				["  source", "cached", "fresh", "total"],
				...turn.rows.map(rowCells),
				inputCells("  turn input", turn.input),
			]).trimEnd()}`,
	);
	const session = `session · ${report.totals.calls} call(s) · output ${report.totals.output}\n${formatColumns([
		["  source", "cached", "fresh", "total"],
		...report.totals.rows.map(rowCells),
		inputCells("  session input", report.totals.input),
	]).trimEnd()}`;
	return `${header.join("\n")}\n\n${[...sections, session].join("\n\n")}\n`;
}

export function runTelemetryTokens(argv: ReadonlyArray<string>): number {
	let session: string | undefined;
	let bySource = false;
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--by-source") bySource = true;
		else if (arg === "--json") json = true;
		else if (arg === "--session" && session === undefined && argv[index + 1]?.startsWith("--") === false) {
			session = argv[index + 1];
			index += 1;
		} else if (!arg.startsWith("--") && session === undefined) session = arg;
		else {
			printError(
				arg === "--session" ? "telemetry tokens: --session needs one id" : `telemetry tokens: unexpected argument: ${arg}`,
			);
			process.stderr.write(TOKENS_HELP);
			return 2;
		}
	}
	if (session === undefined) {
		printError("telemetry tokens needs --session <id>");
		process.stderr.write(TOKENS_HELP);
		return 2;
	}
	let report: TokenSourcesReportV1 | null;
	try {
		report = loadTokenSourcesReport(clioStateDir(), session);
	} catch (error) {
		printError(`cannot read session ${session}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (report === null) {
		printError(`no session ${session} in ${clioStateDir()}`);
		return 1;
	}
	process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderTokenSources(report, bySource));
	return 0;
}

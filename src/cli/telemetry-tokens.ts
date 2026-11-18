import { clioStateDir } from "../core/xdg.js";
import type {
	TokenSourceInput,
	TokenSourceRole,
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
output header says so. The calls column counts every invoked call and names
those the provider sent no token counts for; their tokens are in no sum, and a
turn with no measured call prints its tokens as unknown. A measured call that
sent no cache-read count has no cached/fresh split: its tokens are in the input
total only, cached and fresh sum the calls that have one, and the calls column
names the rest as without split. Fresh is uncached input plus cache write;
copilot-sdk reports the whole prompt as cache read plus cache write, so on its
calls fresh is cache write and the output says so. Calls a
side agent made for the session (compaction, memory and the like) are charged to
the turn they ran in and counted in its totals; the calls column names them by
role, and --by-source gives each role its own row. --json emits the report
verbatim.
`;

const count = (value: number | null) => (value === null ? "unknown" : String(value));

interface Coverage {
	/** Measured calls. */
	calls: number;
	unmeasuredCalls: number;
	roles: readonly TokenSourceRole[];
	input: TokenSourceInput;
}

const sideRoles = (roles: readonly TokenSourceRole[]) => roles.filter((role) => role.role !== "main");

/** Invoked calls, naming the unmeasured ones whose tokens no sum below includes and the side agents' share. */
function callsCell({ calls, unmeasuredCalls, roles, input }: Coverage): string {
	const notes = [
		...(unmeasuredCalls > 0 ? [`${unmeasuredCalls} unmeasured`] : []),
		...(input.unsplitCalls ? [`${input.unsplitCalls} without split`] : []),
		...sideRoles(roles).map((role) => `${role.role} ${role.calls + role.unmeasuredCalls}`),
	];
	return notes.length > 0 ? `${calls + unmeasuredCalls} (${notes.join(", ")})` : String(calls);
}

/** The output figure, naming what the side agents wrote within it. */
function outputCell(span: Coverage & { output: number }): string {
	const sides = sideRoles(span.roles).filter((role) => role.calls > 0);
	const share = sides.length > 0 ? ` (${sides.map((role) => `${role.role} ${role.output}`).join(", ")})` : "";
	return `${measuredCount(span, span.output)}${share}`;
}

/** A token figure over a span that invoked calls but measured none is unknown, not zero. */
function measuredCount(coverage: Coverage, value: number | null): string {
	return coverage.calls === 0 && coverage.unmeasuredCalls > 0 ? "unknown" : count(value);
}

function rowCells(row: TokenSourceRow): string[] {
	const unsplit = row.unsplitCalls ? ` (${row.unsplitCalls} call(s) without split)` : "";
	return [`  ${row.label}`, count(row.cached), count(row.fresh), `${row.total}${unsplit}`];
}

function inputCells(label: string, coverage: Coverage, input: TokenSourceInput): string[] {
	return [
		label,
		measuredCount(coverage, input.cached),
		measuredCount(coverage, input.fresh),
		measuredCount(coverage, input.total),
	];
}

function turnHeading(turn: TokenSourceTurn): string {
	const cold = turn.coldReasons.length > 0 ? ` · cold: ${turn.coldReasons.join(", ")}` : "";
	return `turn ${turn.index} ${turn.at} · ${callsCell(turn)} call(s) · output ${outputCell(turn)}${cold}`;
}

function freshNote({ basis, totals }: TokenSourcesReportV1): string[] {
	const calls = basis.freshIsCacheWriteCalls;
	if (calls === 0) return [];
	const share = calls === totals.calls ? `all ${calls}` : `${calls} of ${totals.calls}`;
	return [
		`note: ${share} measured call(s) ran on copilot-sdk, which reports no uncached input; their fresh is cache write`,
	];
}

export function renderTokenSources(report: TokenSourcesReportV1, bySource: boolean): string {
	const header = [
		`session ${report.sessionId} · usage from ${report.basis.usage} · system side from ${report.basis.systemSide}`,
		...(bySource ? [`note: ${report.basis.note}`] : []),
		...freshNote(report),
	];
	if (report.turns.length === 0) return `${header.join("\n")}\nno turns\n`;
	if (!bySource) {
		const table = formatColumns([
			["turn", "at", "calls", "cached", "fresh", "input", "output"],
			...[...report.turns, { ...report.totals, index: "all", at: "" }].map((span) => [
				String(span.index),
				span.at,
				callsCell(span),
				measuredCount(span, span.input.cached),
				measuredCount(span, span.input.fresh),
				measuredCount(span, span.input.total),
				measuredCount(span, span.output),
			]),
		]);
		return `${header.join("\n")}\n\n${table}`;
	}
	const sections = report.turns.map(
		(turn) =>
			`${turnHeading(turn)}\n${formatColumns([
				["  source", "cached", "fresh", "total"],
				...turn.rows.map(rowCells),
				inputCells("  turn input", turn, turn.input),
			]).trimEnd()}`,
	);
	const { totals } = report;
	const session = `session · ${callsCell(totals)} call(s) · output ${outputCell(totals)}\n${formatColumns([
		["  source", "cached", "fresh", "total"],
		...totals.rows.map(rowCells),
		inputCells("  session input", totals, totals.input),
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

import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
	CacheReportV1,
	CallFilter,
	CallsReportV1,
	CostReportV1,
	ExplanationV1,
	Quantity,
	RunTelemetryV1,
	SessionTelemetryV1,
	TimelineV1,
	WhyStoppedV1,
} from "../core/telemetry/dto.js";
import { parseFactRef } from "../core/telemetry/dto.js";
import { CallLabel, Disposition } from "../core/telemetry/enums.js";
import { clioStateDir } from "../core/xdg.js";
import type { SessionSource } from "../domains/observability/read-model.js";
import {
	cacheReport,
	callsReport,
	costReport,
	explain,
	runCallsReport,
	runCostReport,
	runTelemetry,
	sessionTelemetry,
	timeline,
	whyStopped,
} from "../domains/observability/read-model.js";
import { explainRepoRef, isRepoRef } from "../domains/observability/usage-window.js";
import {
	loadRunReceiptEvidence,
	loadRunTelemetrySource,
	loadSessionTelemetrySource,
} from "../domains/session/telemetry-source.js";
import { formatColumns, printError } from "./shared.js";

/**
 * `clio-coder telemetry inspect|calls|cost|cache|timeline|why-stopped|explain` (#434 §11.3). Each command reads the
 * journals through the read model and prints its DTO: `--json` emits it verbatim, the text form prints its display
 * strings. Nothing here computes a total.
 */

export const READ_HELP = `clio-coder telemetry inspect <session> [--json]
clio-coder telemetry inspect --run <run-id> [--json]
clio-coder telemetry calls <session> [--run <run-id>] [--label <l,..>] [--disposition <d,..>]
                           [--turn <id,..>] [--from <iso>] [--to <iso>] [--limit <n>] [--json]
clio-coder telemetry cost <session> | --run <run-id> [--by label|model|turn] [--json]
clio-coder telemetry cache <session> [--json]
clio-coder telemetry timeline <session> [--from <iso> --to <iso>] [--json]
clio-coder telemetry why-stopped <session> [--json]
clio-coder telemetry explain <ref> [--json]

<session> is a session id or a session directory. Session spend covers the calls
the session's journal owns on every branch, plus the worker runs it referenced;
a fork child folds its own calls, and inspect adds the lineage total. --json
emits the read-model DTO the TUI, ACP and GUI serve. explain also takes a
usage report's repo:<window> reference, refolded over that window ending now.
`;

interface Args {
	command: string;
	positional: string[];
	values: Map<string, string>;
	json: boolean;
}

const VALUE_FLAGS = new Set(["run", "label", "disposition", "turn", "from", "to", "limit", "by"]);

function parse(argv: ReadonlyArray<string>): Args | string {
	const [command = "", ...rest] = argv;
	const positional: string[] = [];
	const values = new Map<string, string>();
	let json = false;
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index] ?? "";
		if (arg === "--json") json = true;
		else if (arg.startsWith("--")) {
			const name = arg.slice(2);
			const value = rest[index + 1];
			if (!VALUE_FLAGS.has(name)) return `unknown flag ${arg}`;
			if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
			values.set(name, value);
			index += 1;
		} else positional.push(arg);
	}
	return { command, positional, values, json };
}

function list<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	flag: string,
): T[] | string | undefined {
	if (value === undefined) return undefined;
	const items = value.split(",").filter((item) => item.length > 0);
	const bad = items.find((item) => !allowed.includes(item as T));
	return bad === undefined ? (items as T[]) : `--${flag} does not accept ${bad}`;
}

function isoArg(value: string | undefined, flag: string): string | undefined | Error {
	if (value === undefined) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : new Error(`--${flag} is not a timestamp: ${value}`);
}

function loadSession(stateDir: string, target: string): SessionSource | null {
	// A path names the session directory itself; anything else is a session id.
	if (target.includes("/") && existsSync(target) && statSync(target).isDirectory()) {
		const directory = resolve(target);
		return loadSessionTelemetrySource(stateDir, basename(directory), directory);
	}
	return loadSessionTelemetrySource(stateDir, target);
}

const show = (quantity: Quantity) => quantity.display;

/** A close only the ledger recorded has no reason, so none is printed (#434 §6.1). */
function lifetimeState(lifetime: SessionTelemetryV1["lifetime"]): string {
	if (lifetime.closed)
		return `closed${lifetime.closed.reason ? ` ${lifetime.closed.reason}` : ""} at ${lifetime.closed.at}`;
	switch (lifetime.state) {
		case "open":
			return "open";
		case "ended-abnormally":
			return "ended without a close";
		case "unverifiable":
			return "open or ended on another host";
		default:
			return "no owner to check";
	}
}

function printSession(dto: SessionTelemetryV1): string {
	const journal = dto.journal;
	const lines = [
		`session ${dto.sessionId}${dto.modes.length > 0 ? ` (${dto.modes.join(" → ")} mode)` : ""}`,
		`journal   ${journal.present ? `${journal.records} records` : "none"} · ${journal.skipped} skipped · ${journal.damaged} damaged · ${journal.gapRecords} gaps (${journal.droppedRecords} dropped) · ${journal.unattributedAggregates} unattributed legacy rows`,
		`lifetime  ${dto.lifetime.firstRecordAt ?? "no records"} → ${dto.lifetime.lastRecordAt ?? "no records"} · ${lifetimeState(dto.lifetime)}`,
	];
	if (dto.lineage.parent)
		lines.push(
			`forked    from ${dto.lineage.parent.sessionId} at ${dto.lineage.parent.turnId}${
				dto.lineage.totals ? ` · lineage ${show(dto.lineage.totals.tokens)} tokens, ${show(dto.lineage.totals.usd)}` : ""
			}${dto.lineage.unreadableAncestors > 0 ? ` · ${dto.lineage.unreadableAncestors} unreadable ancestor(s)` : ""}`,
		);
	const counts = dto.own.counts;
	const tokens = dto.own.tokens;
	const priced = Object.entries(dto.own.cost.pricedBy)
		.filter(([, count]) => count > 0)
		.map(([by, count]) => `${by} ${count}`)
		.join(", ");
	lines.push(
		`calls     ${show(counts.calls)} calls · ${show(counts.attempts)} attempts · settled ${show(counts.dispositions.settled)} · sent unsettled ${show(counts.dispositions.sentUnsettled)} · no usage ${show(counts.dispositions.settledNoUsage)} · never sent ${show(counts.dispositions.neverSent)} · incomplete ${show(counts.dispositions.incomplete)}`,
		`tokens    input ${show(tokens.input)} · output ${show(tokens.output)} · cache read ${show(tokens.cacheRead)} · cache write ${show(tokens.cacheWrite)} · reasoning ${show(tokens.reasoning)} · prompt ${show(tokens.prompt)} · total ${show(tokens.total)}`,
		`cost      ${show(dto.own.cost.usd)}${priced ? ` (priced by ${priced})` : ""}`,
		`runs      ${dto.runs.count}${dto.runs.unresolved > 0 ? ` (${dto.runs.unresolved} unreadable)` : ""} · ${show(dto.runs.apiCalls)} calls · ${show(dto.runs.tokens)} tokens · ${show(dto.runs.usd)}`,
		`charged   ${show(dto.totals.tokens)} tokens · ${show(dto.totals.usd)}`,
		`main loop harness ${show(dto.overhead.harness)} · network ${show(dto.overhead.network)} · model ${show(dto.overhead.model)} · tools ${show(dto.overhead.tool)}`,
		`          bookkeeping-only rounds ${show(dto.overhead.bookkeepingRounds)} re-read ${show(dto.overhead.roundTripTax)} of ${show(dto.overhead.prompt)} prompt tokens`,
	);
	if (dto.transport)
		lines.push(
			`transport ${dto.transport.kind} · continuation ${dto.transport.continuation.display} · pinned to SSE ${dto.transport.sessionPinnedToSse.display}${
				dto.transport.pinReason ? ` (${dto.transport.pinReason})` : ""
			} · WebSocket failures ${show(dto.transport.websocketFailures)} · SSE fallbacks ${show(dto.transport.sseFallbacks)}`,
		);
	if (dto.byLabel.length > 0) {
		lines.push("", "by label");
		lines.push(
			formatColumns([
				["label", "calls", "tokens", "cost"],
				...dto.byLabel.map((row) => [row.label, show(row.calls), show(row.tokens), show(row.usd)]),
			]).trimEnd(),
		);
	}
	return `${lines.join("\n")}\n`;
}

function printRun(dto: RunTelemetryV1): string {
	const row = dto.row;
	const lines = [
		`run ${row.runId}${row.sessionId ? ` (session ${row.sessionId})` : ""} · source ${row.source}`,
		`span      ${row.firstAt ?? "no records"} → ${row.lastAt ?? "no records"}`,
		`journal   ${dto.journal.present ? `${dto.journal.records} records` : "none"} · ${dto.journal.skipped} skipped · ${dto.journal.damaged} damaged · ${dto.journal.gapRecords} gaps`,
		`calls     ${show(row.apiCalls)} API calls · ${show(dto.counts.attempts)} attempts · never sent ${show(dto.counts.dispositions.neverSent)} · usage unknown on ${show(dto.missingTokenCalls)}`,
		`tokens    input ${show(dto.tokens.input)} · output ${show(dto.tokens.output)} · cache read ${show(dto.tokens.cacheRead)} · cache write ${show(dto.tokens.cacheWrite)} · total ${show(dto.tokens.total)}`,
		`cost      ${show(row.usd)}`,
		dto.settled
			? `settled   ${dto.settled.terminalReason} at ${dto.settled.at} · exit ${dto.settled.processExitCode ?? "unknown"} · repair rounds ${show(dto.settled.repairRounds)}${dto.settled.boundKind ? ` · bound ${dto.settled.boundKind}` : ""}`
			: "settled   not yet, or not recorded",
	];
	const receipt = dto.receipt;
	if (receipt)
		lines.push(
			`receipt   ${receipt.receipt} · ${receipt.integrity.display}${receipt.integrity.detail ? ` (${receipt.integrity.detail})` : ""} · ${receipt.trust.validation}${receipt.sealed ? ` · outcome ${receipt.sealed.outcome}` : ""}`,
		);
	return `${lines.join("\n")}\n`;
}

function printCalls(dto: CallsReportV1): string {
	const rows = dto.calls.map((call) => [
		call.startedAt,
		call.label,
		call.disposition,
		`${call.target.targetId}/${call.target.requestedModel}`,
		call.usage ? show(call.usage.total) : "none",
		show(call.usd),
		show(call.timing.ttft),
		call.stop?.failure ?? "",
	]);
	const header = ["started", "label", "disposition", "target/model", "tokens", "cost", "ttft", "failure"];
	const shown =
		dto.matched > dto.calls.length ? `\n${dto.calls.length} of ${dto.matched} matching attempts shown\n` : "";
	return rows.length === 0 ? "no matching attempts\n" : `${formatColumns([header, ...rows])}${shown}`;
}

function printCost(dto: CostReportV1): string {
	const scope =
		"sessionId" in dto.scope
			? `session ${dto.scope.sessionId}`
			: "runId" in dto.scope
				? `run ${dto.scope.runId}`
				: "repo";
	return `${scope} · ${show(dto.total.calls)} calls · ${show(dto.total.tokens)} tokens · ${show(dto.total.usd)}\n\n${formatColumns(
		[
			[dto.groupBy, "calls", "tokens", "cost"],
			...dto.groups.map((group) => [group.key, show(group.calls), show(group.tokens), show(group.usd)]),
		],
	)}`;
}

function printCache(dto: CacheReportV1): string {
	const v = dto.verdicts;
	const lines = [
		`verdicts  hot ${v.hot} · partial ${v.partial} · cold ${v.cold} · small ${v.small} · unknown ${v.unknown}`,
		`tokens    cache read ${show(dto.cacheRead)} · cache write ${show(dto.cacheWrite)} · uncached prefill ${show(dto.uncachedPrefill)} · re-prefilled ${show(dto.rePrefilled)}`,
		`bill      ${show(dto.breakUsd)}`,
	];
	if (dto.breaks.length > 0)
		lines.push(
			"",
			formatColumns([
				["at", "verdict", "causes", "first divergent section", "re-prefilled", "bill"],
				...dto.breaks.map((row) => [
					row.at,
					row.verdict,
					row.expectedColdReasons.join(",") || "unattributed",
					row.firstDivergentSection.display,
					show(row.rePrefilled),
					show(row.breakUsd),
				]),
			]).trimEnd(),
		);
	if (dto.byCause.length > 0)
		lines.push(
			"",
			formatColumns([
				["cause", "breaks", "re-prefilled", "bill"],
				...dto.byCause.map((row) => [row.cause, String(row.breaks), show(row.rePrefilled), show(row.breakUsd)]),
			]).trimEnd(),
		);
	return `${lines.join("\n")}\n`;
}

function printTimeline(dto: TimelineV1): string {
	const lines = dto.entries.map((entry) => {
		switch (entry.kind) {
			case "call":
				return `${entry.at}  call     ${entry.label} ${entry.disposition}${entry.failure ? ` (${entry.failure})` : ""} · ${show(entry.tokens)} tokens · ${show(entry.usd)} · cache ${entry.cacheVerdict}`;
			case "turn":
				return `${entry.at}  turn     ${entry.stopReason}${entry.cause ? ` on ${entry.cause}` : ""}${entry.stage ? ` at ${entry.stage}` : ""} · ${entry.callIds.length} call(s), ${entry.retries} retries`;
			case "run":
				return `${entry.at}  run      ${entry.runId} ${entry.event}${entry.terminalReason ? ` (${entry.terminalReason})` : ""}`;
			case "compaction":
				return `${entry.at}  compact  ${entry.outcome} · ${entry.callIds.length} call(s)`;
			case "session":
				return `${entry.at}  session  ${entry.event}${entry.detail ? ` ${entry.detail}` : ""}`;
			case "gap":
				return `${entry.at}  gap      ${entry.sink} ${entry.reason} × ${entry.count}`;
			case "config": {
				const paths = entry.paths
					? [...entry.paths.hotReload, ...entry.paths.nextTurn, ...entry.paths.restartRequired]
					: [];
				return `${entry.at}  config   ${entry.event}${entry.source ? ` by ${entry.source}` : ""}${paths.length > 0 ? ` · ${paths.join(", ")}` : ""}`;
			}
			case "budget":
				return `${entry.at}  budget   ${entry.event} ${entry.level} · spend ${entry.spend.display} of ${entry.ceiling.display}${entry.waited ? ` · waited ${entry.waited.display}` : ""}${entry.outcome ? ` · ${entry.outcome}` : ""}${entry.raisedTo ? ` to ${entry.raisedTo.display}` : ""}${entry.raisedBy ? ` by ${entry.raisedBy}` : ""}`;
			case "tool":
				return `${entry.at}  tool     ${entry.tool} ${entry.outcome}${entry.blocked ? ` (${entry.blocked})` : ""} · ${entry.duration.display}${entry.parked ? ` · parked ${entry.parked.display}` : ""}${entry.resultBytes ? ` · ${entry.resultBytes.display} bytes` : ""}`;
			case "middleware":
				return `${entry.at}  rule     ${entry.ruleId} at ${entry.hook} · ${entry.effects.join(", ")}${entry.severity ? ` · ${entry.severity}` : ""}${entry.evidence ? ` · ${entry.evidence}` : ""}`;
			case "auth":
				return `${entry.at}  auth     ${entry.provider} ${entry.trigger} · ${entry.outcome}${entry.attempted ? "" : " without a refresh call"} · ${entry.duration.display}`;
			case "prompt":
				return `${entry.at}  prompt   layout v${entry.layoutVersion} · ${entry.sections} sections · ${entry.tokens.display} tokens`;
			case "context":
				return `${entry.at}  context  ${entry.source} · window ${entry.window.effective} (${entry.window.source})${entry.estimated ? ` · estimated ${entry.estimated.display}` : ""}${entry.reconciled ? ` · provider ${entry.reconciled.display}` : ""}`;
			case "system-one":
				return `${entry.at}  s1       ${entry.site} ${entry.outcome} · ${entry.latency.display} of ${entry.deadline.display}${entry.routes.some((route) => route.breaker) ? ` · breaker ${entry.routes.flatMap((route) => (route.breaker ? [`${route.engine} ${route.breaker}`] : [])).join(", ")}` : ""}`;
			case "worker-channel":
				return `${entry.at}  channel  ${entry.runId} ${entry.lane} ${entry.failure}${entry.frameType ? ` on ${entry.frameType}` : ""}${entry.errno ? ` (${entry.errno})` : ""}${entry.afterExit ? " after exit" : ""}`;
			default:
				return `${entry.at}  quota    ${entry.provider} ${entry.source}${entry.limitReached ? " · limit reached" : ""} · ${entry.windows.map((window) => `${window.key} ${window.usedPct.display}`).join(", ")}`;
		}
	});
	return lines.length === 0 ? "no entries\n" : `${lines.join("\n")}\n`;
}

function printWhyStopped(dto: WhyStoppedV1): string {
	return `session ${dto.sessionId}: ${dto.state}\n${dto.findings.map((line) => `  ${line}`).join("\n")}\n`;
}

function printExplanation(dto: ExplanationV1): string {
	const ids = (label: string, values: readonly string[]) =>
		values.length === 0
			? []
			: [`${label} (${values.length}): ${values.slice(0, 8).join(" ")}${values.length > 8 ? " …" : ""}`];
	return `${[
		`${dto.ref} = ${dto.value.display}`,
		`rule: ${dto.rule}`,
		`fold version ${dto.foldVersion}`,
		...ids("calls", dto.from.callIds),
		...ids("runs", dto.from.runIds),
		...(dto.from.omitted > 0 ? [`${dto.from.omitted} more contributing attempts not listed`] : []),
	].join("\n")}\n`;
}

function emit<T>(dto: T, json: boolean, text: (dto: T) => string): number {
	process.stdout.write(json ? `${JSON.stringify(dto, null, 2)}\n` : text(dto));
	return 0;
}

export async function runTelemetryReadCommand(argv: ReadonlyArray<string>): Promise<number> {
	const args = parse(argv);
	if (typeof args === "string") {
		printError(args);
		process.stderr.write(READ_HELP);
		return 2;
	}
	const stateDir = clioStateDir();
	const runId = args.values.get("run");
	const target = args.positional[0];
	try {
		if (args.command === "explain") {
			const ref = target === undefined ? null : parseFactRef(target);
			if (!ref) {
				printError(target === undefined ? "explain needs a reference" : `not a telemetry reference: ${target}`);
				return 2;
			}
			const explained =
				ref.scope === "run"
					? explain(target as string, { runId: ref.owner, run: loadRunTelemetrySource(stateDir, ref.owner) })
					: isRepoRef(ref)
						? await explainRepoRef(stateDir, target as string, ref.owner)
						: (() => {
								const session = loadSessionTelemetrySource(stateDir, ref.owner);
								return session ? explain(target as string, { session }) : null;
							})();
			if (!explained) {
				printError(`nothing in the journals resolves ${target}`);
				return 1;
			}
			return emit(explained, args.json, printExplanation);
		}
		if (
			target === undefined &&
			runId !== undefined &&
			(args.command === "inspect" || args.command === "cost" || args.command === "calls")
		) {
			const run = loadRunTelemetrySource(stateDir, runId);
			if (!run.present) {
				printError(`no run journal for ${runId}`);
				return 1;
			}
			if (args.command === "inspect")
				return emit(runTelemetry(runId, run, {}, loadRunReceiptEvidence(stateDir, runId)), args.json, printRun);
			if (args.command === "cost") {
				const by = args.values.get("by") ?? "model";
				if (by !== "label" && by !== "model" && by !== "turn") {
					printError(`--by does not accept ${by}`);
					return 2;
				}
				return emit(runCostReport(runId, run, by), args.json, printCost);
			}
		}
		if (target === undefined && args.command !== "calls") {
			printError(`${args.command} needs a session id or directory`);
			process.stderr.write(READ_HELP);
			return 2;
		}
		const filter = callFilter(args);
		if (typeof filter === "string") {
			printError(filter);
			return 2;
		}
		if (target === undefined) {
			if (runId === undefined) {
				printError("calls needs a session, or --run <run-id>");
				return 2;
			}
			const run = loadRunTelemetrySource(stateDir, runId);
			if (!run.present) {
				printError(`no run journal for ${runId}`);
				return 1;
			}
			return emit(runCallsReport(runId, run, filter), args.json, printCalls);
		}
		const session = loadSession(stateDir, target);
		if (!session) {
			printError(`no session ${target} in ${stateDir}`);
			return 1;
		}
		switch (args.command) {
			case "inspect":
				return emit(sessionTelemetry(session), args.json, printSession);
			case "calls":
				return emit(callsReport(session, filter), args.json, printCalls);
			case "cost": {
				const by = args.values.get("by") ?? "label";
				if (by !== "label" && by !== "model" && by !== "turn") {
					printError(`--by does not accept ${by}`);
					return 2;
				}
				return emit(costReport(session, by), args.json, printCost);
			}
			case "cache":
				return emit(cacheReport(session), args.json, printCache);
			case "timeline": {
				const from = isoArg(args.values.get("from"), "from");
				const to = isoArg(args.values.get("to"), "to");
				if (from instanceof Error || to instanceof Error) {
					printError((from instanceof Error ? from : (to as Error)).message);
					return 2;
				}
				if ((from === undefined) !== (to === undefined)) {
					printError("timeline takes --from and --to together");
					return 2;
				}
				return emit(timeline(session, from && to ? { from, to } : null), args.json, printTimeline);
			}
			case "why-stopped":
				return emit(whyStopped(session), args.json, printWhyStopped);
		}
		printError(`unknown telemetry command: ${args.command}`);
		return 2;
	} catch (error) {
		printError(`cannot read telemetry: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

function callFilter(args: Args): CallFilter | string {
	const labels = list(args.values.get("label"), CallLabel.enum, "label");
	const dispositions = list(args.values.get("disposition"), [...Disposition.enum, "incomplete"] as const, "disposition");
	if (typeof labels === "string") return labels;
	if (typeof dispositions === "string") return dispositions;
	const from = isoArg(args.values.get("from"), "from");
	const to = isoArg(args.values.get("to"), "to");
	if (from instanceof Error) return from.message;
	if (to instanceof Error) return to.message;
	const limitText = args.values.get("limit");
	const limit = limitText === undefined ? undefined : Number(limitText);
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return `--limit needs a positive integer`;
	const turns = args.values
		.get("turn")
		?.split(",")
		.filter((turn) => turn.length > 0);
	const filter: CallFilter = {
		...(labels ? { labels } : {}),
		...(dispositions ? { dispositions } : {}),
		...(turns ? { turnIds: turns } : {}),
		...(args.values.get("run") !== undefined && args.positional[0] !== undefined
			? { runId: args.values.get("run") as string }
			: {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
	return filter;
}

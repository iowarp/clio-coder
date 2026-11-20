import { recordedToolResultNotes } from "../../core/reminder-framing.js";
import type { AgentRole } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { ceilChars } from "../../core/token-split.js";
import { isSessionJsonlHeader, readSessionFileEntries, sessionCurrentPath } from "../../engine/session.js";
import { displayToolCall } from "../../tools/gateway-display.js";
import { collectSessionEntries } from "./compaction/session-entries.js";
import { estimateTokens } from "./compaction/tokens.js";
import type { MessageEntry, SessionEntry } from "./entries.js";
import { stripInjectedPreamble } from "./history.js";
import { contentBlocks, messageText, payloadObject, toolCallArguments, toolResultValue } from "./message-projection.js";
import { loadSessionTelemetrySource } from "./telemetry-source.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";

/**
 * Per-turn input token attribution by source (`clio-coder telemetry tokens --by-source`, WTF-P 0.8.3 C2).
 *
 * A provider reports one input total per call, never a split. Each call's total (input plus cache read plus cache
 * write) is apportioned over the segments of the request that call sent, in proportion to each segment's estimated
 * tokens: the system side from the session journal's latest context snapshot, every message from the session
 * ledger's active path as replayed since the last compaction. Prompt caching is a prefix, so the call's cache read
 * goes to the leading segments in request order and the rest is fresh. Totals are measured; the split is estimated.
 *
 * Calls a side agent made for the session (compaction, memory and the like) are charged to the turn they ran in, one
 * row per role: a compaction by the checkpoint's call ids in the ledger, any other by when the call started.
 */

/** Agents that run beside a session's own; worker and coordinator calls belong to their runs. */
export type SideRole = Exclude<AgentRole, "main" | "coordinator" | "worker">;

export type TokenSource =
	| "system-prompt"
	| "skills"
	| "tool-schemas"
	| "template"
	| "reminders"
	| "history"
	| `tool:${string}`
	| `role:${SideRole}`;

export interface TokenSourceRow {
	source: TokenSource;
	label: string;
	/**
	 * Cached and fresh sum the calls that reported a cache-read count; null when none of the row's calls did. The
	 * total is every call's, so a row with `unsplitCalls` has total above cached plus fresh (bt-42).
	 */
	cached: number | null;
	fresh: number | null;
	total: number;
	/** Calls whose share of this row has no cached/fresh split; absent when every call had one. */
	unsplitCalls?: number;
}

export interface TokenSourceInput {
	cached: number | null;
	fresh: number | null;
	total: number;
	/** Measured calls with no cache-read count: in the total, in neither cached nor fresh (bt-42). */
	unsplitCalls?: number;
}

/** One agent role's calls inside a span; the span's own figures are their sum. */
export interface TokenSourceRole {
	role: "main" | SideRole;
	calls: number;
	unmeasuredCalls: number;
	input: TokenSourceInput;
	output: number;
}

export interface TokenSourceTurn {
	index: number;
	turnId: string;
	at: string;
	/** Calls whose input total was measured and is split below. */
	calls: number;
	/** Calls in the turn with no usable input total; they contribute nothing to the rows. */
	unmeasuredCalls: number;
	input: TokenSourceInput;
	output: number;
	/** Expected-cold reasons the journal stamped on the turn's calls, as wire codes. */
	coldReasons: string[];
	rows: TokenSourceRow[];
	/** Main first, then each side role that made a call in the turn. */
	roles: TokenSourceRole[];
}

export interface TokenSourcesReportV1 {
	version: 1;
	sessionId: string;
	basis: {
		usage: "journal" | "ledger" | "mixed" | "none";
		systemSide: "context-snapshot" | "prompt-compile" | "residual" | "mixed" | "none";
		split: "estimated";
		note: string;
		/** Measured calls on a route that reports no uncached input, so their fresh share is their cache write. */
		freshIsCacheWriteCalls: number;
	};
	turns: TokenSourceTurn[];
	totals: {
		calls: number;
		unmeasuredCalls: number;
		input: TokenSourceInput;
		output: number;
		rows: TokenSourceRow[];
		roles: TokenSourceRole[];
	};
}

export const TOKEN_SOURCES_NOTE =
	"Input totals are provider-reported per call; the split by source is estimated. Each call's total is apportioned over its request's segments by estimated tokens (chars/4 over the session ledger, the journal's context snapshot for the system side), and its cache read is assigned to the leading segments in request order. Side-agent calls (compaction, memory) are not split: each role is one row of the turn it ran in.";

interface Segment {
	/** Ledger turn the segment came from; null for the system side. */
	turnId: string | null;
	source: TokenSource;
	tokens: number;
}

interface CallUsage {
	input: number;
	cacheRead: number | null;
	cacheWrite: number;
	output: number;
	from: "journal" | "ledger";
	coldReasons: readonly string[];
	api: string | null;
}

/**
 * APIs that report the whole prompt as cache read plus cache write: copilot-sdk's uncached remainder is a constant
 * few tokens, so its fresh share is its cache write.
 */
const NO_UNCACHED_INPUT_APIS: ReadonlySet<string> = new Set(["copilot-sdk"]);

const FIXED_ORDER: readonly TokenSource[] = ["tool-schemas", "system-prompt", "skills", "template", "reminders"];

function tokenSourceLabel(source: TokenSource): string {
	switch (source) {
		case "system-prompt":
			return "system prompt";
		case "skills":
			return "skills";
		case "tool-schemas":
			return "tool schemas";
		case "template":
			return "template body";
		case "reminders":
			return "extension effects (reminders/annotations)";
		case "history":
			return "history";
		default:
			return source.startsWith("role:")
				? `${source.slice("role:".length)} calls`
				: `tool results: ${source.slice("tool:".length)}`;
	}
}

const LEADING_REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/u;

/** A user message's composed text split into host reminders, skill preamble and the rest. */
function userSegments(entry: MessageEntry): Segment[] {
	const payload = payloadObject(entry.payload);
	const text = messageText(entry);
	// A synthesized continuation is a middleware request the model reads as its next prompt.
	if (payload?.synthetic === true)
		return [{ turnId: entry.turnId, source: "reminders", tokens: ceilChars(text.length) }];
	let rest = text;
	let reminderChars = 0;
	for (let match = LEADING_REMINDER.exec(rest); match; match = LEADING_REMINDER.exec(rest)) {
		reminderChars += match[0].length;
		rest = rest.slice(match[0].length);
	}
	const operator = stripInjectedPreamble(rest);
	const skillChars = rest.length - operator.length;
	// An expansion replaced the typed input: the composed words are the template's body, not the operator's.
	const body: TokenSource = typeof payload?.displayText === "string" ? "template" : "history";
	return [
		{ turnId: entry.turnId, source: "reminders", tokens: ceilChars(reminderChars) },
		{ turnId: entry.turnId, source: "skills", tokens: ceilChars(skillChars) },
		{ turnId: entry.turnId, source: body, tokens: ceilChars(operator.length) },
	].filter((segment) => segment.tokens > 0) as Segment[];
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	return contentBlocks(result)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function toolResultSegments(entry: MessageEntry, callArgs: ReadonlyMap<string, unknown>): Segment[] {
	const payload = payloadObject(entry.payload);
	if (payload === null) return [];
	const result = toolResultValue(payload);
	const text = resultText(result);
	const notes = recordedToolResultNotes(payloadObject(result)?.details).filter((note) => text.includes(note));
	const noteChars = notes.reduce((sum, note) => sum + note.length + 1, 0);
	const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
	const args = typeof payload.toolCallId === "string" ? callArgs.get(payload.toolCallId) : undefined;
	const shown = displayToolCall(toolName, args);
	// A context call that loads a skill delivers the skill's instructions, whichever tool carried them.
	const source: TokenSource =
		shown.toolName === "context" && shown.args?.scope === "skills" && typeof shown.args.name === "string"
			? "skills"
			: `tool:${shown.toolName}`;
	return [
		{ turnId: entry.turnId, source: "reminders", tokens: ceilChars(noteChars) },
		{ turnId: entry.turnId, source, tokens: ceilChars(Math.max(0, text.length - noteChars)) },
	].filter((segment) => segment.tokens > 0) as Segment[];
}

function measured(fact: Fact<number> | undefined): number | null {
	return fact !== undefined && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : null;
}

function journalUsage(record: TelemetryRecord<"call.settled">): CallUsage | null {
	const usage = record.data.usage;
	if (usage === null) return null;
	const input = measured(usage.input);
	if (input === null) return null;
	return {
		input,
		cacheRead: measured(usage.cacheRead),
		cacheWrite: measured(usage.cacheWrite) ?? 0,
		output: measured(usage.output) ?? 0,
		from: "journal",
		coldReasons: record.data.cache.expectedColdReasons,
		api: record.data.target.api,
	};
}

function ledgerUsage(payload: Record<string, unknown>): CallUsage | null {
	const usage = payloadObject(payload.usage);
	if (usage === null || typeof usage.input !== "number") return null;
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		input: usage.input,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : null,
		cacheWrite: number(usage.cacheWrite),
		output: number(usage.output),
		from: "ledger",
		coldReasons: [],
		api: typeof payload.api === "string" ? payload.api : null,
	};
}

/** Largest-remainder apportionment: integer shares of `total` in proportion to `weights`, summing to `total`. */
function apportion(total: number, weights: readonly number[]): number[] {
	const sum = weights.reduce((acc, weight) => acc + weight, 0);
	if (sum <= 0) return weights.map((_, index) => (index === 0 ? total : 0));
	const exact = weights.map((weight) => (weight * total) / sum);
	const shares = exact.map(Math.floor);
	let left = total - shares.reduce((acc, share) => acc + share, 0);
	const order = exact
		.map((value, index) => ({ index, rest: value - Math.floor(value) }))
		.sort((a, b) => b.rest - a.rest);
	for (const { index } of order) {
		if (left <= 0) break;
		shares[index] = (shares[index] ?? 0) + 1;
		left -= 1;
	}
	return shares;
}

interface SystemSide {
	segments: Segment[];
	basis: "context-snapshot" | "prompt-compile" | "residual";
}

function systemSide(
	at: string,
	snapshots: readonly TelemetryRecord<"context.snapshotted">[],
	compiles: readonly TelemetryRecord<"prompt.compiled">[],
): SystemSide {
	const latest = <R extends TelemetryRecord>(records: readonly R[]): R | undefined =>
		records.filter((record) => record.t <= at).at(-1) ?? records[0];
	const snapshot = latest(snapshots);
	if (snapshot !== undefined) {
		const c = snapshot.data.categories;
		return {
			basis: "context-snapshot",
			segments: [
				{ turnId: null, source: "tool-schemas", tokens: c.tools },
				{ turnId: null, source: "system-prompt", tokens: c.system + c.agents + c.memory + c.project },
				{ turnId: null, source: "skills", tokens: c.skills },
			],
		};
	}
	const compiled = latest(compiles);
	if (compiled !== undefined)
		return {
			basis: "prompt-compile",
			segments: [{ turnId: null, source: "system-prompt", tokens: compiled.data.tokenEstimate }],
		};
	return { basis: "residual", segments: [] };
}

interface RowAccumulator {
	cached: number;
	fresh: number;
	total: number;
	/** The part of the total from calls with no cache-read count, and how many such calls. */
	unsplit: number;
	unsplitCalls: number;
}

/** Cached and fresh over the split part; a span no call split stays unknown rather than an invented zero (bt-42). */
function splitOf(row: RowAccumulator, unsplitCalls: number): TokenSourceInput {
	const none = row.unsplit > 0 && row.unsplit === row.total;
	return {
		cached: none ? null : row.cached,
		fresh: none ? null : row.fresh,
		total: row.total,
		...(unsplitCalls > 0 ? { unsplitCalls } : {}),
	};
}

function rowsOf(accumulated: ReadonlyMap<TokenSource, RowAccumulator>): TokenSourceRow[] {
	const rank = (source: TokenSource) => {
		const fixed = FIXED_ORDER.indexOf(source);
		if (fixed >= 0) return fixed;
		if (source.startsWith("role:")) return FIXED_ORDER.length + 2;
		return source === "history" ? FIXED_ORDER.length + 1 : FIXED_ORDER.length;
	};
	return [...accumulated]
		.filter(([, row]) => row.total > 0)
		.sort(([a, left], [b, right]) => rank(a) - rank(b) || right.total - left.total || a.localeCompare(b))
		.map(([source, row]) => ({ source, label: tokenSourceLabel(source), ...splitOf(row, row.unsplitCalls) }));
}

function addRow(target: Map<TokenSource, RowAccumulator>, source: TokenSource, row: RowAccumulator): void {
	const prior = target.get(source) ?? { cached: 0, fresh: 0, total: 0, unsplit: 0, unsplitCalls: 0 };
	target.set(source, {
		cached: prior.cached + row.cached,
		fresh: prior.fresh + row.fresh,
		total: prior.total + row.total,
		unsplit: prior.unsplit + row.unsplit,
		unsplitCalls: prior.unsplitCalls + row.unsplitCalls,
	});
}

/** One measured call's share of a row: split into cached and fresh when the call reported a cache read. */
function callRow(share: number, cached: number, split: boolean): RowAccumulator {
	return split
		? { cached, fresh: share - cached, total: share, unsplit: 0, unsplitCalls: 0 }
		: { cached: 0, fresh: 0, total: share, unsplit: share, unsplitCalls: 1 };
}

interface RoleAccumulator {
	calls: number;
	unmeasuredCalls: number;
	/** Measured calls with no cache-read count; a span's own unsplit count, since one call spans many rows. */
	unsplitCalls: number;
	output: number;
}

interface TurnAccumulator extends RoleAccumulator {
	index: number;
	turnId: string;
	at: string;
	coldReasons: Set<string>;
	rows: Map<TokenSource, RowAccumulator>;
	roles: Map<TokenSourceRole["role"], RoleAccumulator>;
}

function inputOf(
	rows: ReadonlyMap<TokenSource, RowAccumulator>,
	unsplitCalls: number,
	role?: TokenSourceRole["role"],
): TokenSourceInput {
	const sum: RowAccumulator = { cached: 0, fresh: 0, total: 0, unsplit: 0, unsplitCalls: 0 };
	for (const [source, row] of rows) {
		if (role !== undefined && (role === "main" ? source.startsWith("role:") : source !== `role:${role}`)) continue;
		sum.cached += row.cached;
		sum.fresh += row.fresh;
		sum.total += row.total;
		sum.unsplit += row.unsplit;
	}
	return splitOf(sum, unsplitCalls);
}

function isSideRole(role: AgentRole): role is SideRole {
	return role !== "main" && role !== "coordinator" && role !== "worker";
}

function rolesOf(
	roles: ReadonlyMap<TokenSourceRole["role"], RoleAccumulator>,
	rows: ReadonlyMap<TokenSource, RowAccumulator>,
): TokenSourceRole[] {
	return [...roles]
		.sort(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))
		.map(([role, { calls, unmeasuredCalls, unsplitCalls, output }]) => ({
			role,
			calls,
			unmeasuredCalls,
			output,
			input: inputOf(rows, unsplitCalls, role),
		}));
}

/** A side-agent call waiting for the turn it is charged to. */
interface SideCharge {
	role: SideRole;
	usage: CallUsage | null;
	invoked: boolean;
	/** Calls the usage covers: a ledger checkpoint's usage sums its summary streams. */
	calls: number;
}

/** Fold a session's ledger entries and its own journal records into the per-turn split. */
function tokenSourcesReport(
	sessionId: string,
	entries: ReadonlyArray<SessionEntry>,
	records: ReadonlyArray<TelemetryRecord>,
): TokenSourcesReportV1 {
	const settled = new Map<string, TelemetryRecord<"call.settled">>();
	const sideCalls: TelemetryRecord<"call.settled">[] = [];
	const startedAt = new Map<string, string>();
	const snapshots: TelemetryRecord<"context.snapshotted">[] = [];
	const compiles: TelemetryRecord<"prompt.compiled">[] = [];
	for (const record of records) {
		if (record.ctx.sessionId !== undefined && record.ctx.sessionId !== null && record.ctx.sessionId !== sessionId)
			continue;
		if (record.k === "call.settled") {
			settled.set(record.data.attemptId, record);
			settled.set(record.data.callId, record);
			if (isSideRole(record.ctx.agent.role)) sideCalls.push(record);
		} else if (record.k === "call.started") startedAt.set(record.data.attemptId, record.t);
		else if (record.k === "context.snapshotted") snapshots.push(record);
		else if (record.k === "prompt.compiled") compiles.push(record);
	}
	const byTime = (a: TelemetryRecord, b: TelemetryRecord) => a.t.localeCompare(b.t);
	snapshots.sort(byTime);
	compiles.sort(byTime);

	const path = filterEntriesToActivePath(entries);
	const callArgs = new Map<string, unknown>();
	for (const entry of path) {
		if (entry.kind !== "message") continue;
		const payload = payloadObject(entry.payload);
		if (entry.role === "tool_call" && payload !== null && typeof payload.toolCallId === "string")
			callArgs.set(payload.toolCallId, toolCallArguments(payload));
		if (entry.role === "assistant")
			for (const block of contentBlocks(entry.payload))
				if (block.type === "toolCall" && typeof block.id === "string" && !callArgs.has(block.id))
					callArgs.set(block.id, block.arguments);
	}

	let context: Segment[] = [];
	let residual: number | null = null;
	const turns: TurnAccumulator[] = [];
	const usageFrom = new Set<CallUsage["from"]>();
	const systemFrom = new Set<SystemSide["basis"]>();
	let freshIsCacheWriteCalls = 0;
	const openTurn = (entry: SessionEntry): TurnAccumulator => {
		const turn: TurnAccumulator = {
			index: turns.length + 1,
			turnId: entry.turnId,
			at: entry.timestamp,
			calls: 0,
			unmeasuredCalls: 0,
			unsplitCalls: 0,
			output: 0,
			coldReasons: new Set(),
			rows: new Map(),
			roles: new Map(),
		};
		turns.push(turn);
		return turn;
	};
	const tally = (
		turn: TurnAccumulator,
		role: TokenSourceRole["role"],
		output: number | null,
		calls = 1,
		split = true,
	): void => {
		const tallies = turn.roles.get(role) ?? { calls: 0, unmeasuredCalls: 0, unsplitCalls: 0, output: 0 };
		for (const target of [turn, tallies]) {
			if (output === null) target.unmeasuredCalls += calls;
			else {
				target.calls += calls;
				target.output += output;
				if (!split) target.unsplitCalls += calls;
			}
		}
		turn.roles.set(role, tallies);
	};
	const chargeSide = (turn: TurnAccumulator, charge: SideCharge): void => {
		const { usage } = charge;
		const total = usage === null ? 0 : usage.input + (usage.cacheRead ?? 0) + usage.cacheWrite;
		if (usage === null || total <= 0) {
			if (charge.invoked) tally(turn, charge.role, null, charge.calls);
			return;
		}
		usageFrom.add(usage.from);
		if (usage.api !== null && NO_UNCACHED_INPUT_APIS.has(usage.api)) freshIsCacheWriteCalls += charge.calls;
		const split = usage.cacheRead !== null;
		tally(turn, charge.role, usage.output, charge.calls, split);
		const row = callRow(total, Math.min(total, usage.cacheRead ?? 0), split);
		addRow(turn.rows, `role:${charge.role}`, { ...row, unsplitCalls: split ? 0 : charge.calls });
	};
	const sideCharge = (record: TelemetryRecord<"call.settled">): SideCharge => ({
		role: record.ctx.agent.role as SideRole,
		usage: journalUsage(record),
		invoked: record.data.disposition !== "never_sent",
		calls: 1,
	});
	// A checkpoint's calls are charged to the turn whose prompt it ran ahead of, or to the open turn when it ran inside
	// one; the next ledger message says which. A call journaled with the turn it served goes there instead, which is how a
	// /compact between turns lands on the turn before it and a discarded compaction on its own turn rather than by time.
	let pending: SideCharge[] = [];
	const charged = new Set<TelemetryRecord<"call.settled">>();
	const userTurnIds = new Set(
		path.flatMap((entry) => (entry.kind === "message" && entry.role === "user" ? [entry.turnId] : [])),
	);
	const servedTurn = (record: TelemetryRecord<"call.settled">): string | undefined => {
		const turnId = record.ctx.turnId;
		return turnId !== undefined && userTurnIds.has(turnId) ? turnId : undefined;
	};
	const stamped: TelemetryRecord<"call.settled">[] = [];
	const flushPending = (turn: TurnAccumulator | undefined): void => {
		if (turn !== undefined) for (const charge of pending) chargeSide(turn, charge);
		pending = [];
	};

	for (const entry of path) {
		if (entry.kind === "compactionSummary") {
			const linked = sideCalls.filter(
				(record) => record.ctx.agent.role === "compaction" && entry.callIds?.includes(record.data.callId) === true,
			);
			for (const record of linked) charged.add(record);
			stamped.push(...linked.filter((record) => servedTurn(record) !== undefined));
			pending.push(...linked.filter((record) => servedTurn(record) === undefined).map(sideCharge));
			if (linked.length === 0 && entry.usage !== undefined)
				pending.push({
					role: "compaction",
					usage: {
						input: entry.usage.input,
						cacheRead: entry.usage.cacheRead,
						cacheWrite: entry.usage.cacheWrite,
						output: entry.usage.output,
						from: "ledger",
						coldReasons: [],
						api: null,
					},
					invoked: true,
					calls: Math.max(1, entry.usage.apiCalls),
				});
			const kept = context.findIndex((segment) => segment.turnId === entry.firstKeptTurnId);
			context = [
				{ turnId: entry.turnId, source: "history", tokens: estimateTokens(entry) },
				...(kept >= 0 ? context.slice(kept) : []),
			];
			continue;
		}
		if (entry.kind !== "message") {
			const tokens = estimateTokens(entry);
			if (tokens > 0)
				context.push({ turnId: entry.turnId, source: entry.kind === "skillActivation" ? "skills" : "history", tokens });
			continue;
		}
		if (entry.role === "user") {
			flushPending(openTurn(entry));
			context.push(...userSegments(entry));
			continue;
		}
		if (entry.role === "tool_result") {
			context.push(...toolResultSegments(entry, callArgs));
			continue;
		}
		if (entry.role !== "assistant") continue;
		const payload = payloadObject(entry.payload) ?? {};
		// A row Clio synthesized for a terminating tool result is no provider message and was never sent.
		if (payload.terminalToolResult === true) continue;
		const turn = turns.at(-1) ?? openTurn(entry);
		flushPending(turn);
		const journal =
			(typeof payload.attemptId === "string" ? settled.get(payload.attemptId) : undefined) ??
			(typeof payload.callId === "string" ? settled.get(payload.callId) : undefined);
		const usage = (journal ? journalUsage(journal) : null) ?? ledgerUsage(payload);
		const total = usage === null ? 0 : usage.input + (usage.cacheRead ?? 0) + usage.cacheWrite;
		if (usage === null || total <= 0) {
			if (payload.callInvoked !== false) tally(turn, "main", null);
		} else {
			usageFrom.add(usage.from);
			tally(turn, "main", usage.output, 1, usage.cacheRead !== null);
			if (usage.api !== null && NO_UNCACHED_INPUT_APIS.has(usage.api)) freshIsCacheWriteCalls += 1;
			for (const reason of usage.coldReasons) turn.coldReasons.add(reason);
			const side = systemSide(entry.timestamp, snapshots, compiles);
			systemFrom.add(side.basis);
			const messages = context.reduce((sum, segment) => sum + segment.tokens, 0);
			// With no journaled estimate, the first measured call's remainder over its messages is the system side; it does
			// not grow with history, so later calls reuse it instead of a remainder their history estimate swallows.
			residual ??= total > messages ? total - messages : null;
			const system =
				side.basis === "residual"
					? [{ turnId: null, source: "system-prompt" as const, tokens: residual ?? 0 }]
					: side.segments;
			const request = [...system, ...context];
			const shares = apportion(
				total,
				request.map((segment) => segment.tokens),
			);
			let cacheLeft = usage.cacheRead ?? 0;
			request.forEach((segment, index) => {
				const share = shares[index] ?? 0;
				if (share <= 0) return;
				const cached = Math.min(share, cacheLeft);
				cacheLeft -= cached;
				addRow(turn.rows, segment.source, callRow(share, cached, usage.cacheRead !== null));
			});
		}
		const tokens = estimateTokens(entry);
		if (tokens > 0) context.push({ turnId: entry.turnId, source: "history", tokens });
	}

	flushPending(turns.at(-1));
	const turnById = (turnId: string | undefined) =>
		turnId === undefined ? undefined : turns.find((turn) => turn.turnId === turnId);
	for (const record of stamped) {
		const turn = turnById(servedTurn(record)) ?? turns.at(-1);
		if (turn !== undefined) chargeSide(turn, sideCharge(record));
	}
	// Any other side call is charged to the turn it served, or else to the turn that was open when it started.
	for (const record of sideCalls) {
		if (charged.has(record)) continue;
		const at = startedAt.get(record.data.attemptId) ?? record.t;
		const turn = turnById(servedTurn(record)) ?? [...turns].reverse().find((candidate) => candidate.at <= at) ?? turns[0];
		if (turn !== undefined) chargeSide(turn, sideCharge(record));
	}

	const sessionRows = new Map<TokenSource, RowAccumulator>();
	const sessionRoles = new Map<TokenSourceRole["role"], RoleAccumulator>();
	let calls = 0;
	let unmeasuredCalls = 0;
	let unsplitCalls = 0;
	let output = 0;
	for (const turn of turns) {
		calls += turn.calls;
		unmeasuredCalls += turn.unmeasuredCalls;
		unsplitCalls += turn.unsplitCalls;
		output += turn.output;
		for (const [source, row] of turn.rows) addRow(sessionRows, source, row);
		for (const [role, tallies] of turn.roles) {
			const prior = sessionRoles.get(role) ?? { calls: 0, unmeasuredCalls: 0, unsplitCalls: 0, output: 0 };
			sessionRoles.set(role, {
				calls: prior.calls + tallies.calls,
				unmeasuredCalls: prior.unmeasuredCalls + tallies.unmeasuredCalls,
				unsplitCalls: prior.unsplitCalls + tallies.unsplitCalls,
				output: prior.output + tallies.output,
			});
		}
	}
	const one = <T extends string>(set: ReadonlySet<T>, none: T, mixed: T): T =>
		set.size === 0 ? none : set.size > 1 ? mixed : ([...set][0] as T);
	return {
		version: 1,
		sessionId,
		basis: {
			usage: one(usageFrom, "none" as const, "mixed" as const),
			systemSide: one(systemFrom as Set<TokenSourcesReportV1["basis"]["systemSide"]>, "none", "mixed"),
			split: "estimated",
			note: TOKEN_SOURCES_NOTE,
			freshIsCacheWriteCalls,
		},
		turns: turns.map((turn) => ({
			index: turn.index,
			turnId: turn.turnId,
			at: turn.at,
			calls: turn.calls,
			unmeasuredCalls: turn.unmeasuredCalls,
			input: inputOf(turn.rows, turn.unsplitCalls),
			output: turn.output,
			coldReasons: [...turn.coldReasons].sort(),
			rows: rowsOf(turn.rows),
			roles: rolesOf(turn.roles, turn.rows),
		})),
		totals: {
			calls,
			unmeasuredCalls,
			input: inputOf(sessionRows, unsplitCalls),
			output,
			rows: rowsOf(sessionRows),
			roles: rolesOf(sessionRoles, sessionRows),
		},
	};
}

/** Read a session's ledger and its own journal, then fold them; null when no ledger holds the id. */
export function loadTokenSourcesReport(stateDir: string, sessionId: string): TokenSourcesReportV1 | null {
	let path: string;
	try {
		path = sessionCurrentPath(sessionId);
	} catch {
		// No session directory holds the id.
		return null;
	}
	const raw = readSessionFileEntries(path).filter((entry) => !isSessionJsonlHeader(entry));
	const entries = collectSessionEntries(raw, path);
	const records = loadSessionTelemetrySource(stateDir, sessionId)?.journal.records ?? [];
	return tokenSourcesReport(sessionId, entries, records);
}

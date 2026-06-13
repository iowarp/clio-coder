import { readFileSync, statSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";
import { truncateUtf8 } from "./truncate-utf8.js";

export const DEFAULT_READ_TURN_OBSERVATION_BUDGET_BYTES = 128 * 1024;
export const READ_TURN_OBSERVATION_BUDGET_ENV = "CLIO_READ_TURN_OBSERVATION_BUDGET_BYTES";

const MIN_READ_BUDGET_SLICE_BYTES = 1024;
const READ_BUDGET_TRACK_LIMIT = 256;

interface ReadTurnBudgetState {
	usedBytes: number;
	lastSeenAt: number;
}

interface ReadTurnBudgetReservation {
	key: string;
	limitBytes: number;
	usedBeforeBytes: number;
	remainingBeforeBytes: number;
	maxBytes: number;
	limited: boolean;
	exhausted: boolean;
}

const readTurnBudgets = new Map<string, ReadTurnBudgetState>();

function outputBytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function readTurnBudgetLimit(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[READ_TURN_OBSERVATION_BUDGET_ENV];
	if (raw === undefined || raw.trim().length === 0) return DEFAULT_READ_TURN_OBSERVATION_BUDGET_BYTES;
	const parsed = Number(raw.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_READ_TURN_OBSERVATION_BUDGET_BYTES;
	return Math.max(MIN_READ_BUDGET_SLICE_BYTES, Math.floor(parsed));
}

function budgetKey(options: ToolInvokeOptions | undefined): string | null {
	const turnId = options?.turnId?.trim();
	if (!turnId) return null;
	const sessionId = options?.sessionId?.trim() || "no-session";
	return `${sessionId}:${turnId}`;
}

function pruneBudgetMap(): void {
	while (readTurnBudgets.size > READ_BUDGET_TRACK_LIMIT) {
		let oldestKey: string | null = null;
		let oldestSeen = Number.POSITIVE_INFINITY;
		for (const [key, state] of readTurnBudgets) {
			if (state.lastSeenAt >= oldestSeen) continue;
			oldestKey = key;
			oldestSeen = state.lastSeenAt;
		}
		if (oldestKey === null) break;
		readTurnBudgets.delete(oldestKey);
	}
}

function reserveTurnBudget(options: ToolInvokeOptions | undefined): ReadTurnBudgetReservation | null {
	const key = budgetKey(options);
	if (key === null) return null;
	const limitBytes = readTurnBudgetLimit();
	const state = readTurnBudgets.get(key) ?? { usedBytes: 0, lastSeenAt: Date.now() };
	state.lastSeenAt = Date.now();
	readTurnBudgets.set(key, state);
	pruneBudgetMap();
	const remainingBeforeBytes = Math.max(0, limitBytes - state.usedBytes);
	if (remainingBeforeBytes < MIN_READ_BUDGET_SLICE_BYTES) {
		return {
			key,
			limitBytes,
			usedBeforeBytes: state.usedBytes,
			remainingBeforeBytes,
			maxBytes: 0,
			limited: true,
			exhausted: true,
		};
	}
	const maxBytes = Math.min(DEFAULT_MAX_BYTES, remainingBeforeBytes);
	return {
		key,
		limitBytes,
		usedBeforeBytes: state.usedBytes,
		remainingBeforeBytes,
		maxBytes,
		limited: maxBytes < DEFAULT_MAX_BYTES,
		exhausted: false,
	};
}

function recordTurnBudget(reservation: ReadTurnBudgetReservation | null, text: string): number {
	if (reservation === null) return outputBytes(text);
	const bytes = outputBytes(text);
	const state = readTurnBudgets.get(reservation.key) ?? {
		usedBytes: reservation.usedBeforeBytes,
		lastSeenAt: Date.now(),
	};
	state.usedBytes += bytes;
	state.lastSeenAt = Date.now();
	readTurnBudgets.set(reservation.key, state);
	return bytes;
}

function budgetDetails(
	reservation: ReadTurnBudgetReservation | null,
	shownBytes: number,
): Record<string, unknown> | null {
	if (reservation === null) return null;
	return {
		turnBudgetBytes: reservation.limitBytes,
		usedBeforeBytes: reservation.usedBeforeBytes,
		remainingBeforeBytes: reservation.remainingBeforeBytes,
		shownBytes,
		limited: reservation.limited,
		exhausted: reservation.exhausted,
	};
}

function budgetNote(reservation: ReadTurnBudgetReservation | null): string {
	if (reservation === null || (!reservation.limited && !reservation.exhausted)) return "";
	return `[Per-turn read observation budget: ${formatSize(reservation.usedBeforeBytes)} already returned of ${formatSize(
		reservation.limitBytes,
	)} before this read. Use narrower offset/limit or continue in a follow-up turn for more content.]`;
}

export const readTool: ToolSpec = {
	name: ToolNames.Read,
	description: `Read a UTF-8 text file. Output is capped at ${DEFAULT_MAX_LINES} lines or ${
		DEFAULT_MAX_BYTES / 1024
	}KB per call; truncated results say how to continue with offset/limit.`,
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		offset: Type.Optional(Type.Number({ description: "1-indexed start line." })),
		limit: Type.Optional(Type.Number({ description: "Max lines to read." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "read: missing path argument" };
		const filePath = resolveReadPath(pathArg);
		const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null;
		const turnBudget = reserveTurnBudget(options);
		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) return { kind: "error", message: `read: not a file: ${filePath}` };
			if (stat.size > 20_000_000) {
				return {
					kind: "error",
					message: `read: file too large (${stat.size}B > 20MB). Use grep/find to locate the relevant section or read a smaller generated/source file; use shell access only when byte-level inspection is explicitly needed.`,
				};
			}
			const content = readFileSync(filePath, "utf8");
			const allLines = content.split("\n");
			const totalLines = allLines.length;
			const startIndex = Math.min(offset - 1, totalLines);
			if (offset > 1 && startIndex >= totalLines) {
				return { kind: "error", message: `read: offset ${offset} is beyond end of file (${totalLines} lines total)` };
			}
			if (turnBudget?.exhausted) {
				const output = `[read observation budget exhausted for this turn before reading ${pathArg}: ${formatSize(
					turnBudget.usedBeforeBytes,
				)} already returned of ${formatSize(
					turnBudget.limitBytes,
				)}. Use offset/limit in a follow-up turn or grep/find for a narrower section.]`;
				const shownBytes = recordTurnBudget(turnBudget, output);
				const observationBudget = budgetDetails(turnBudget, shownBytes);
				return {
					kind: "ok",
					output,
					...(observationBudget ? { details: { observationBudget } } : {}),
				};
			}
			const selected =
				limit !== null
					? allLines.slice(startIndex, Math.min(startIndex + limit, totalLines)).join("\n")
					: allLines.slice(startIndex).join("\n");
			const truncation = truncateHead(selected, turnBudget ? { maxBytes: turnBudget.maxBytes } : undefined);
			let output: string;
			if (truncation.firstLineExceedsLimit) {
				const maxBytes = turnBudget?.maxBytes ?? DEFAULT_MAX_BYTES;
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startIndex] ?? "", "utf8"));
				const linePrefix = truncateUtf8(allLines[startIndex] ?? "", maxBytes, "\n[line truncated]");
				output = `${linePrefix}\n\n[Line ${startIndex + 1} is ${firstLineSize}, exceeding the ${formatSize(maxBytes)} read limit. Showing the UTF-8 prefix only. Use grep with a narrower literal/regex or edit with exact surrounding text; use shell access only when byte-level inspection is required.]`;
			} else if (truncation.truncated) {
				const endDisplay = startIndex + truncation.outputLines;
				const nextOffset = endDisplay + 1;
				output = truncation.content;
				const suffix =
					truncation.truncatedBy === "lines"
						? `[Showing lines ${startIndex + 1}-${endDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
						: `[Showing lines ${startIndex + 1}-${endDisplay} of ${totalLines} (${formatSize(
								truncation.maxBytes,
							)} limit). Use offset=${nextOffset} to continue.]`;
				output += `\n\n${suffix}`;
			} else if (limit !== null && startIndex + truncation.outputLines < totalLines) {
				const nextOffset = startIndex + truncation.outputLines + 1;
				const remaining = totalLines - (startIndex + truncation.outputLines);
				output = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				output = truncation.content;
			}
			const note = budgetNote(turnBudget);
			if (note.length > 0) output += `\n\n${note}`;
			const shownBytes = recordTurnBudget(turnBudget, output);
			const observationBudget = budgetDetails(turnBudget, shownBytes);
			const details: Record<string, unknown> = {};
			if (truncation.truncated) details.truncation = truncation;
			if (observationBudget !== null) details.observationBudget = observationBudget;
			return {
				kind: "ok",
				output,
				...(Object.keys(details).length > 0 ? { details } : {}),
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				return {
					kind: "error",
					message: `read: ${msg}. File not found at ${pathArg}. The path may be wrong (e.g. wrong extension; codewiki indexes only .ts/.tsx). Try: code_nav, find, glob, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `read: ${msg}` };
		}
	},
};

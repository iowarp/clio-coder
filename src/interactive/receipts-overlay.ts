import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { isReceiptIntegrity, verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import {
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Text,
	type TUI,
	truncateToWidth,
} from "../engine/tui.js";
import { DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "./overlay-frame.js";

export const RECEIPTS_OVERLAY_WIDTH = 78;
export const RECEIPTS_OVERLAY_MAX_VISIBLE = 10;
export const RECEIPTS_OVERLAY_HINT = "[Up/Down] /receipts verify <id> [Esc]";

const SHORT_ID_LEN = 8;
const AGENT_COL_WIDTH = 10;
const ENDPOINT_COL_WIDTH = 12;
const MODEL_COL_WIDTH = 16;
const EXIT_COL_WIDTH = 5;
const TOKENS_COL_WIDTH = 12;
const RECEIPT_SUFFIX_WIDTH = 22;
const RECEIPT_GAP_WIDTH = 6;

type ReceiptColumn = "id" | "agent" | "endpoint" | "model" | "exit" | "tokens" | "cost";

interface ReceiptRowParts {
	id: string;
	agent: string;
	endpoint: string;
	model: string;
	exit: string;
	tokens: string;
	cost: string;
}

const RECEIPTS_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 48,
	maxPrimaryColumnWidth: 64,
	truncatePrimary: ({ text, maxWidth }) => truncateReceiptLabel(text, maxWidth),
};

function shortRunId(runId: string): string {
	if (!runId) return "-";
	return runId.length <= SHORT_ID_LEN ? runId : runId.slice(0, SHORT_ID_LEN);
}

function fitLeft(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function formatReceiptTokens(tokens: number, reasoningTokens?: number): string {
	const base = `${Math.max(0, Math.round(tokens)).toLocaleString("en-US")}t`;
	const reasoning =
		typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0
			? `/r${Math.round(reasoningTokens).toLocaleString("en-US")}`
			: "";
	return `${base}${reasoning}`;
}

function formatReceiptUsd(usd: number): string {
	return `$${Math.max(0, usd).toFixed(2)}`;
}

function receiptParts(env: RunEnvelope): ReceiptRowParts {
	return {
		id: shortRunId(env.id),
		agent: env.agentId || "-",
		endpoint: env.endpointId || "-",
		model: env.wireModelId || "-",
		exit: env.exitCode === null ? "e=?" : `e=${env.exitCode}`,
		tokens: formatReceiptTokens(env.tokenCount, env.reasoningTokenCount),
		cost: formatReceiptUsd(env.costUsd),
	};
}

function receiptWidths(maxWidth: number, parts: ReceiptRowParts): Record<ReceiptColumn, number> {
	const widths: Record<ReceiptColumn, number> = {
		id: SHORT_ID_LEN,
		agent: AGENT_COL_WIDTH,
		endpoint: ENDPOINT_COL_WIDTH,
		model: MODEL_COL_WIDTH,
		exit: EXIT_COL_WIDTH,
		tokens: TOKENS_COL_WIDTH,
		cost: Math.max(4, parts.cost.length),
	};
	const minimums: Record<ReceiptColumn, number> = {
		id: 4,
		agent: 3,
		endpoint: 4,
		model: 4,
		exit: 3,
		tokens: 4,
		cost: Math.max(4, Math.min(widths.cost, parts.cost.length)),
	};
	const totalWidth = (): number =>
		widths.id +
		widths.agent +
		widths.endpoint +
		widths.model +
		widths.exit +
		widths.tokens +
		widths.cost +
		RECEIPT_GAP_WIDTH;
	let overflow = totalWidth() - maxWidth;
	for (const column of ["model", "endpoint", "agent", "tokens", "id"] as const) {
		if (overflow <= 0) break;
		const shrink = Math.min(overflow, widths[column] - minimums[column]);
		widths[column] -= shrink;
		overflow -= shrink;
	}
	for (const column of ["model", "endpoint", "agent", "tokens", "id"] as const) {
		if (overflow <= 0) break;
		const shrink = Math.min(overflow, widths[column] - 1);
		widths[column] -= shrink;
		overflow -= shrink;
	}
	return widths;
}

function parseReceiptRow(text: string): ReceiptRowParts | null {
	const parts = text.trim().split(/\s+/);
	if (parts.length < 7) return null;
	const [id, agent, endpoint, model, exit, tokens, cost] = parts;
	if (!id || !agent || !endpoint || !model || !exit || !tokens || !cost) return null;
	return { id, agent, endpoint, model, exit, tokens, cost };
}

function formatReceiptParts(parts: ReceiptRowParts, maxWidth: number): string {
	const widths = receiptWidths(maxWidth, parts);
	const row = [
		fitLeft(parts.id, widths.id),
		fitLeft(parts.agent, widths.agent),
		fitLeft(parts.endpoint, widths.endpoint),
		fitLeft(parts.model, widths.model),
		fitLeft(parts.exit, widths.exit),
		formatReceiptCell(parts.tokens, widths.tokens, "right"),
		formatReceiptCell(parts.cost, widths.cost, "right"),
	].join(" ");
	return row.length > maxWidth ? truncateToWidth(row, maxWidth, "") : row;
}

function formatReceiptCell(text: string, width: number, align: "left" | "right"): string {
	const clipped = text.length > width ? text.slice(0, width) : text;
	return align === "right" ? clipped.padStart(width) : clipped.padEnd(width);
}

function truncateReceiptLabel(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const parts = parseReceiptRow(text);
	if (parts) return formatReceiptParts(parts, maxWidth);
	if (text.length <= maxWidth) return text;
	const suffixWidth = Math.min(RECEIPT_SUFFIX_WIDTH, Math.max(0, maxWidth - 4));
	const prefixWidth = maxWidth - suffixWidth - 3;
	if (prefixWidth <= 0) return truncateToWidth(text, maxWidth, "");
	return `${truncateToWidth(text, prefixWidth, "")}...${text.slice(-suffixWidth)}`;
}

function formatReceiptRow(env: RunEnvelope): string {
	return formatReceiptParts(receiptParts(env), Number.POSITIVE_INFINITY);
}

function buildReceiptItems(envelopes: ReadonlyArray<RunEnvelope>): SelectItem[] {
	return envelopes.map((env) => ({
		value: env.id,
		label: formatReceiptRow(env),
		description: env.startedAt,
	}));
}

export function formatReceiptsHeader(count: number): string {
	return count === 0 ? "─ Receipts (empty) ─" : `─ Receipts (${count}) ─`;
}

export interface OpenReceiptsOverlayOptions {
	maxVisible?: number;
	onSelect?: (runId: string) => void;
}

/**
 * Mount a read-only receipts overlay. Reads dispatch.listRuns() once and
 * renders each envelope as a compact row. Validation lives in the
 * `/receipts verify` slash command, not here.
 */
export function openReceiptsOverlay(
	tui: TUI,
	dispatch: DispatchContract,
	options?: OpenReceiptsOverlayOptions,
): OverlayHandle {
	const envelopes = dispatch.listRuns();
	const items = buildReceiptItems(envelopes);
	const selectList =
		items.length === 0
			? null
			: new SelectList(items, options?.maxVisible ?? RECEIPTS_OVERLAY_MAX_VISIBLE, DEFAULT_SELECT_THEME, RECEIPTS_LAYOUT);
	if (selectList && options?.onSelect) {
		selectList.onSelect = (item: SelectItem): void => options.onSelect?.(item.value);
	}
	const box = new FocusBox(
		[selectList ?? new Text("no dispatch runs yet", 0, 0), new Text("", 0, 0), new Text(RECEIPTS_OVERLAY_HINT, 0, 0)],
		{ inputTarget: selectList },
	);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: RECEIPTS_OVERLAY_WIDTH,
		title: formatReceiptsHeader(envelopes.length).replace(/^─\s*/, "").replace(/\s*─$/, ""),
	});
}

export type ReceiptVerifyResult = { ok: true } | { ok: false; reason: string };

const RECEIPT_REQUIRED_KEYS = [
	"runId",
	"agentId",
	"task",
	"endpointId",
	"wireModelId",
	"runtimeId",
	"runtimeKind",
	"startedAt",
	"endedAt",
	"exitCode",
	"tokenCount",
	"costUsd",
	"compiledPromptHash",
	"staticCompositionHash",
	"clioVersion",
	"piMonoVersion",
	"platform",
	"nodeVersion",
	"toolCalls",
	"toolStats",
	"sessionId",
	"integrity",
] as const;

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso8601(value: unknown): value is string {
	return typeof value === "string" && ISO_8601_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateToolStats(value: unknown): ReceiptVerifyResult {
	if (!Array.isArray(value)) {
		return { ok: false, reason: `toolStats not an array: ${String(value)}` };
	}
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return { ok: false, reason: `toolStats[${i}] not an object` };
		}
		const stat = entry as Record<string, unknown>;
		if (!isNonEmptyString(stat.tool)) {
			return { ok: false, reason: `toolStats[${i}].tool invalid: ${String(stat.tool)}` };
		}
		for (const key of ["count", "ok", "errors", "blocked"] as const) {
			if (!isNonNegativeInteger(stat[key])) {
				return { ok: false, reason: `toolStats[${i}].${key} invalid: ${String(stat[key])}` };
			}
		}
		if (!isNonNegativeFiniteNumber(stat.totalDurationMs)) {
			return { ok: false, reason: `toolStats[${i}].totalDurationMs invalid: ${String(stat.totalDurationMs)}` };
		}
	}
	return { ok: true };
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

export function receiptFilePath(dataDir: string, runId: string): string {
	return join(dataDir, "receipts", `${runId}.json`);
}

function runLedgerPath(dataDir: string): string {
	return join(dataDir, "state", "runs.json");
}

type ReadLedgerResult = { ok: true; envelope: RunEnvelope } | { ok: false; reason: string };

function readRunEnvelope(dataDir: string, runId: string): ReadLedgerResult {
	let raw: string;
	const target = runLedgerPath(dataDir);
	try {
		raw = readFileSync(target, "utf8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return { ok: false, reason: "run ledger not found" };
		return { ok: false, reason: `ledger read error: ${e.message ?? String(e)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `invalid run ledger json: ${(err as Error).message}` };
	}
	if (!Array.isArray(parsed)) {
		return { ok: false, reason: "run ledger is not an array" };
	}
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const candidate = entry as Record<string, unknown>;
		if (candidate.id === runId) {
			return { ok: true, envelope: candidate as unknown as RunEnvelope };
		}
	}
	return { ok: false, reason: "run not found in ledger" };
}

// Missing receipt files resolve to a fail result rather than throwing so
// /receipts verify stays scriptable.
export function verifyReceiptFile(dataDir: string, runId: string): ReceiptVerifyResult {
	const target = receiptFilePath(dataDir, runId);
	let raw: string;
	try {
		raw = readFileSync(target, "utf8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return { ok: false, reason: "receipt file not found" };
		return { ok: false, reason: `read error: ${e.message ?? String(e)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `invalid json: ${(err as Error).message}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "receipt is not an object" };
	}
	const r = parsed as Record<string, unknown>;
	for (const key of RECEIPT_REQUIRED_KEYS) {
		if (!(key in r)) return { ok: false, reason: `missing field: ${key}` };
	}
	if (!isNonEmptyString(r.runId)) {
		return { ok: false, reason: `runId invalid: ${String(r.runId)}` };
	}
	if (r.runId !== runId) {
		return { ok: false, reason: `runId mismatch: file has ${String(r.runId)}` };
	}
	if (!isNonEmptyString(r.agentId)) {
		return { ok: false, reason: `agentId invalid: ${String(r.agentId)}` };
	}
	if (!isNonEmptyString(r.task)) {
		return { ok: false, reason: `task invalid: ${String(r.task)}` };
	}
	if (!isNonEmptyString(r.endpointId)) {
		return { ok: false, reason: `endpointId invalid: ${String(r.endpointId)}` };
	}
	if (!isNonEmptyString(r.wireModelId)) {
		return { ok: false, reason: `wireModelId invalid: ${String(r.wireModelId)}` };
	}
	if (!isNonEmptyString(r.runtimeId)) {
		return { ok: false, reason: `runtimeId invalid: ${String(r.runtimeId)}` };
	}
	if (r.runtimeKind !== "http" && r.runtimeKind !== "subprocess" && r.runtimeKind !== "sdk") {
		return { ok: false, reason: `runtimeKind invalid: ${String(r.runtimeKind)}` };
	}
	const exitCode = r.exitCode;
	if (typeof exitCode !== "number" || !(exitCode === 0 || exitCode === 1 || exitCode === 2)) {
		return { ok: false, reason: `exitCode out of range: ${String(exitCode)}` };
	}
	const tokenCount = r.tokenCount;
	if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) {
		return { ok: false, reason: `tokenCount out of range: ${String(tokenCount)}` };
	}
	for (const key of ["inputTokenCount", "outputTokenCount", "cacheReadTokenCount", "cacheWriteTokenCount"] as const) {
		if (key in r && !isNonNegativeFiniteNumber(r[key])) {
			return { ok: false, reason: `${key} out of range: ${String(r[key])}` };
		}
	}
	const costUsd = r.costUsd;
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
		return { ok: false, reason: `costUsd out of range: ${String(costUsd)}` };
	}
	if ("reasoningTokenCount" in r && !isNonNegativeFiniteNumber(r.reasoningTokenCount)) {
		return { ok: false, reason: `reasoningTokenCount out of range: ${String(r.reasoningTokenCount)}` };
	}
	if (!isIso8601(r.startedAt)) {
		return { ok: false, reason: `startedAt not ISO-8601: ${String(r.startedAt)}` };
	}
	if (!isIso8601(r.endedAt)) {
		return { ok: false, reason: `endedAt not ISO-8601: ${String(r.endedAt)}` };
	}
	if (typeof r.clioVersion !== "string" || r.clioVersion.length === 0) {
		return { ok: false, reason: "clioVersion empty" };
	}
	if (!isNonEmptyString(r.piMonoVersion)) {
		return { ok: false, reason: `piMonoVersion invalid: ${String(r.piMonoVersion)}` };
	}
	if (!isNonEmptyString(r.platform)) {
		return { ok: false, reason: `platform invalid: ${String(r.platform)}` };
	}
	if (!isNonEmptyString(r.nodeVersion)) {
		return { ok: false, reason: `nodeVersion invalid: ${String(r.nodeVersion)}` };
	}
	if (typeof r.toolCalls !== "number" || !Number.isInteger(r.toolCalls) || r.toolCalls < 0) {
		return { ok: false, reason: `toolCalls out of range: ${String(r.toolCalls)}` };
	}
	const toolStatsCheck = validateToolStats(r.toolStats);
	if (!toolStatsCheck.ok) return toolStatsCheck;
	if (!isNullableString(r.compiledPromptHash)) {
		return { ok: false, reason: `compiledPromptHash invalid: ${String(r.compiledPromptHash)}` };
	}
	if (!isNullableString(r.staticCompositionHash)) {
		return { ok: false, reason: `staticCompositionHash invalid: ${String(r.staticCompositionHash)}` };
	}
	if (!isNullableString(r.sessionId)) {
		return { ok: false, reason: `sessionId invalid: ${String(r.sessionId)}` };
	}
	if (!isReceiptIntegrity(r.integrity)) {
		return { ok: false, reason: "integrity invalid" };
	}
	const ledger = readRunEnvelope(dataDir, runId);
	if (!ledger.ok) return ledger;
	return verifyReceiptIntegrity(r as unknown as RunReceipt, ledger.envelope);
}

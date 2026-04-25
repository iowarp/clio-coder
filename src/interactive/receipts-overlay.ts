import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { isReceiptIntegrity, verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	Text,
	type TUI,
	truncateToWidth,
} from "../engine/tui.js";

export const RECEIPTS_OVERLAY_WIDTH = 78;
export const RECEIPTS_OVERLAY_MAX_VISIBLE = 10;
export const RECEIPTS_OVERLAY_HINT = "[Up/Down] /receipts verify <id> [Esc]";

const SHORT_ID_LEN = 8;
const AGENT_COL_WIDTH = 10;
const ENDPOINT_COL_WIDTH = 12;
const MODEL_COL_WIDTH = 16;
const EXIT_COL_WIDTH = 5;
const TOKENS_COL_WIDTH = 9;
const RECEIPT_SUFFIX_WIDTH = 22;

const IDENTITY = (s: string): string => s;

const RECEIPTS_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

const RECEIPTS_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 48,
	maxPrimaryColumnWidth: 64,
	truncatePrimary: ({ text, maxWidth }) => truncateReceiptLabel(text, maxWidth),
};

export function shortRunId(runId: string): string {
	if (!runId) return "-";
	return runId.length <= SHORT_ID_LEN ? runId : runId.slice(0, SHORT_ID_LEN);
}

function fitLeft(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function formatReceiptTokens(tokens: number): string {
	return `${Math.max(0, Math.round(tokens)).toLocaleString("en-US")}t`;
}

function formatReceiptUsd(usd: number): string {
	return `$${Math.max(0, usd).toFixed(2)}`;
}

function truncateReceiptLabel(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (text.length <= maxWidth) return text;
	const suffixWidth = Math.min(RECEIPT_SUFFIX_WIDTH, Math.max(0, maxWidth - 4));
	const prefixWidth = maxWidth - suffixWidth - 3;
	if (prefixWidth <= 0) return truncateToWidth(text, maxWidth, "");
	return `${truncateToWidth(text, prefixWidth, "")}...${text.slice(-suffixWidth)}`;
}

export function formatReceiptRow(env: RunEnvelope): string {
	const id = fitLeft(shortRunId(env.id), SHORT_ID_LEN);
	const agent = fitLeft(env.agentId || "-", AGENT_COL_WIDTH);
	const endpoint = fitLeft(env.endpointId || "-", ENDPOINT_COL_WIDTH);
	const model = fitLeft(env.wireModelId || "-", MODEL_COL_WIDTH);
	const exit = fitLeft(env.exitCode === null ? "e=?" : `e=${env.exitCode}`, EXIT_COL_WIDTH);
	const tokens = formatReceiptTokens(env.tokenCount).padStart(TOKENS_COL_WIDTH);
	return `${id} ${agent} ${endpoint} ${model} ${exit} ${tokens} ${formatReceiptUsd(env.costUsd)}`;
}

export function buildReceiptItems(envelopes: ReadonlyArray<RunEnvelope>): SelectItem[] {
	return envelopes.map((env) => ({
		value: env.id,
		label: formatReceiptRow(env),
		description: env.startedAt,
	}));
}

export function formatReceiptsHeader(count: number): string {
	return count === 0 ? "─ Receipts (empty) ─" : `─ Receipts (${count}) ─`;
}

// pi-tui's Box has no input handling; forward keystrokes to the SelectList
// child so Up/Down/Enter reach it while the overlay owns focus.
class ReceiptsOverlayBox extends Box {
	constructor(private readonly selectList: SelectList | null) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.selectList?.handleInput(data);
	}
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
			: new SelectList(items, options?.maxVisible ?? RECEIPTS_OVERLAY_MAX_VISIBLE, RECEIPTS_THEME, RECEIPTS_LAYOUT);
	if (selectList && options?.onSelect) {
		selectList.onSelect = (item: SelectItem): void => options.onSelect?.(item.value);
	}
	const box = new ReceiptsOverlayBox(selectList);
	box.addChild(new Text(formatReceiptsHeader(envelopes.length), 0, 0));
	box.addChild(selectList ?? new Text("no dispatch runs yet", 0, 0));
	box.addChild(new Text("", 0, 0));
	box.addChild(new Text(RECEIPTS_OVERLAY_HINT, 0, 0));
	return tui.showOverlay(box, { anchor: "center", width: RECEIPTS_OVERLAY_WIDTH });
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
	const costUsd = r.costUsd;
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
		return { ok: false, reason: `costUsd out of range: ${String(costUsd)}` };
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

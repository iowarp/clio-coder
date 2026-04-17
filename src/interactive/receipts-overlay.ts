import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	Text,
} from "../engine/tui.js";

export const RECEIPTS_OVERLAY_WIDTH = 78;
export const RECEIPTS_OVERLAY_MAX_VISIBLE = 10;
export const RECEIPTS_OVERLAY_HINT = "[Up/Down] scroll  [/receipt verify <id>] validate  [Esc] close";

const SHORT_ID_LEN = 8;
const AGENT_COL_WIDTH = 10;
const MODEL_COL_WIDTH = 18;
const EXIT_COL_WIDTH = 5;
const TOKENS_COL_WIDTH = 7;

const IDENTITY = (s: string): string => s;

const RECEIPTS_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

export function shortRunId(runId: string): string {
	if (!runId) return "-";
	return runId.length <= SHORT_ID_LEN ? runId : runId.slice(0, SHORT_ID_LEN);
}

function fitLeft(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

export function formatReceiptRow(env: RunEnvelope): string {
	const id = fitLeft(shortRunId(env.id), SHORT_ID_LEN);
	const agent = fitLeft(env.agentId || "-", AGENT_COL_WIDTH);
	const model = fitLeft(env.modelId || "-", MODEL_COL_WIDTH);
	const exit = fitLeft(env.exitCode === null ? "e=?" : `e=${env.exitCode}`, EXIT_COL_WIDTH);
	const tokens = `${Math.max(0, Math.round(env.tokenCount))}t`.padStart(TOKENS_COL_WIDTH);
	return `${id} ${agent} ${model} ${exit} ${tokens} $${Math.max(0, env.costUsd).toFixed(4)}`;
}

export function buildReceiptItems(envelopes: ReadonlyArray<RunEnvelope>): SelectItem[] {
	// startedAt is not put into SelectList's description column; pi-tui reserves
	// that column and truncates the primary column to fit, which shaves off the
	// right-hand exit/tokens/usd cells. Keep the whole row in the primary label.
	return envelopes.map((env) => ({
		value: env.id,
		label: `${formatReceiptRow(env)}  ${env.startedAt}`,
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
 * `/receipt verify` slash command, not here.
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
			: new SelectList(items, options?.maxVisible ?? RECEIPTS_OVERLAY_MAX_VISIBLE, RECEIPTS_THEME);
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
	"providerId",
	"modelId",
	"runtime",
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
	"sessionId",
] as const;

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso8601(value: unknown): value is string {
	return typeof value === "string" && ISO_8601_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

export function receiptFilePath(dataDir: string, runId: string): string {
	return join(dataDir, "receipts", `${runId}.json`);
}

// Missing receipt files resolve to a fail result rather than throwing so
// /receipt verify stays scriptable.
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
	if (!parsed || typeof parsed !== "object") {
		return { ok: false, reason: "receipt is not an object" };
	}
	const r = parsed as Record<string, unknown>;
	for (const key of RECEIPT_REQUIRED_KEYS) {
		if (!(key in r)) return { ok: false, reason: `missing field: ${key}` };
	}
	if (r.runId !== runId) {
		return { ok: false, reason: `runId mismatch: file has ${String(r.runId)}` };
	}
	const exitCode = r.exitCode;
	if (typeof exitCode !== "number" || !(exitCode === 0 || exitCode === 1 || exitCode === 2)) {
		return { ok: false, reason: `exitCode out of range: ${String(exitCode)}` };
	}
	const tokenCount = r.tokenCount;
	if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) {
		return { ok: false, reason: `tokenCount out of range: ${String(tokenCount)}` };
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
	return { ok: true };
}

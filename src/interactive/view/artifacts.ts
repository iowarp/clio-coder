import { createReadStream, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { isReceiptIntegrity, verifyReceiptIntegrity } from "../../domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../../domains/dispatch/types.js";
import type { BashExecutionEntry, MessageEntry, SessionEntry } from "../../domains/session/entries.js";
import type { SessionMeta } from "../../domains/session/index.js";

export type ViewArtifactCategory = "receipt" | "dispatch" | "tool-output" | "compaction";
export type ViewArtifactFormat = "markdown" | "text" | "json";

export interface ViewArtifactLoadResult {
	lines: string[];
	format: ViewArtifactFormat;
}

export interface ViewArtifact {
	id: string;
	category: ViewArtifactCategory;
	title: string;
	timestamp: number;
	sizeBytes?: number | undefined;
	/** Absolute backing path when one exists. Session-entry artifacts point at current.jsonl. */
	path?: string | undefined;
	load(): Promise<ViewArtifactLoadResult>;
	verify?(): Promise<{ ok: boolean; detail: string }>;
}

export interface ArtifactProvider {
	category: ViewArtifactCategory;
	list(): Promise<ViewArtifact[]>;
}

export interface ArtifactProviderDeps {
	dataDir: string;
	dispatch?: Pick<DispatchContract, "listRuns" | "getRun"> | undefined;
	sessionMeta?: SessionMeta | null | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
}

export const VIEW_ARTIFACT_CATEGORIES: readonly ViewArtifactCategory[] = [
	"receipt",
	"dispatch",
	"tool-output",
	"compaction",
] as const;

export const VIEW_ARTIFACT_LINE_CAP = 50_000;
const JSON_PRETTY_MAX_BYTES = 10 * 1024 * 1024;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function parseTime(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function safeTitle(value: string, fallback: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function maybeSizeBytes(path: string): number | undefined {
	try {
		const info = statSync(path);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
}

function sessionCurrentPath(dataDir: string, meta: SessionMeta | null | undefined): string | undefined {
	if (!meta) return undefined;
	return join(dataDir, "sessions", meta.cwdHash, meta.id, "current.jsonl");
}

export function receiptFilePath(dataDir: string, runId: string): string {
	return join(dataDir, "receipts", `${runId}.json`);
}

export function runLedgerPath(dataDir: string): string {
	return join(dataDir, "state", "runs.json");
}

function readRunLedger(dataDir: string): RunEnvelope[] {
	try {
		const raw = readFileSync(runLedgerPath(dataDir), "utf8").trim();
		if (raw.length === 0) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed.filter(isRecord) as unknown as RunEnvelope[]) : [];
	} catch {
		return [];
	}
}

function listRunEnvelopes(deps: ArtifactProviderDeps): RunEnvelope[] {
	try {
		const runs = deps.dispatch?.listRuns();
		if (runs) return [...runs];
	} catch {
		return [];
	}
	return readRunLedger(deps.dataDir);
}

function validateToolStats(value: unknown): ReceiptVerifyResult {
	if (!Array.isArray(value)) {
		return { ok: false, reason: `toolStats not an array: ${String(value)}` };
	}
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (!isRecord(entry)) {
			return { ok: false, reason: `toolStats[${i}] not an object` };
		}
		if (!isNonEmptyString(entry.tool)) {
			return { ok: false, reason: `toolStats[${i}].tool invalid: ${String(entry.tool)}` };
		}
		for (const key of ["count", "ok", "errors", "blocked"] as const) {
			if (!isNonNegativeInteger(entry[key])) {
				return { ok: false, reason: `toolStats[${i}].${key} invalid: ${String(entry[key])}` };
			}
		}
		if (!isNonNegativeFiniteNumber(entry.totalDurationMs)) {
			return { ok: false, reason: `toolStats[${i}].totalDurationMs invalid: ${String(entry.totalDurationMs)}` };
		}
	}
	return { ok: true };
}

type ReadLedgerResult = { ok: true; envelope: RunEnvelope } | { ok: false; reason: string };

function readRunEnvelope(dataDir: string, runId: string): ReadLedgerResult {
	const runs = readRunLedger(dataDir);
	for (const entry of runs) {
		if (entry.id === runId) return { ok: true, envelope: entry };
	}
	return { ok: false, reason: runs.length === 0 ? "run ledger not found" : "run not found in ledger" };
}

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
	if (!isRecord(parsed)) {
		return { ok: false, reason: "receipt is not an object" };
	}
	const r = parsed;
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
	if (r.runtimeKind !== "http" && r.runtimeKind !== "subprocess" && r.runtimeKind !== "acp-delegation") {
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

function pushCapped(lines: string[], line: string, maxLines: number): boolean {
	if (lines.length >= maxLines) return false;
	lines.push(line);
	return lines.length < maxLines;
}

export async function readTextFileLinesCapped(
	path: string,
	maxLines = VIEW_ARTIFACT_LINE_CAP,
): Promise<{ lines: string[]; truncated: boolean }> {
	const lines: string[] = [];
	let pending = "";
	let truncated = false;
	const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
	outer: for await (const chunk of stream) {
		pending += chunk;
		for (;;) {
			const nextBreak = pending.indexOf("\n");
			if (nextBreak < 0) break;
			const line = pending.slice(0, nextBreak).replace(/\r$/, "");
			pending = pending.slice(nextBreak + 1);
			if (!pushCapped(lines, line, maxLines)) {
				truncated = true;
				stream.destroy();
				break outer;
			}
		}
	}
	if (!truncated && pending.length > 0 && !pushCapped(lines, pending.replace(/\r$/, ""), maxLines)) {
		truncated = true;
	}
	if (truncated) {
		lines.push(`[truncated, open file directly: ${path}]`);
	}
	return { lines, truncated };
}

function splitLinesCapped(text: string, path?: string, maxLines = VIEW_ARTIFACT_LINE_CAP): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines), `[truncated, open file directly${path ? `: ${path}` : ""}]`];
}

export async function loadJsonFileLines(path: string): Promise<ViewArtifactLoadResult> {
	let canPrettyPrint = false;
	try {
		const info = await stat(path);
		canPrettyPrint = info.size <= JSON_PRETTY_MAX_BYTES;
	} catch {
		return { lines: [`unable to read ${path}`], format: "text" };
	}
	if (canPrettyPrint) {
		try {
			const raw = await readFile(path, "utf8");
			const pretty = JSON.stringify(JSON.parse(raw), null, 2);
			return { lines: splitLinesCapped(pretty, path), format: "json" };
		} catch {
			return loadTextPath(path);
		}
	}
	const { lines } = await readTextFileLinesCapped(path);
	return { lines, format: "json" };
}

async function loadTextPath(path: string): Promise<ViewArtifactLoadResult> {
	try {
		const { lines } = await readTextFileLinesCapped(path);
		return { lines, format: "text" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { lines: [`unable to read ${path}: ${message}`], format: "text" };
	}
}

function receiptTitle(env: RunEnvelope): string {
	return safeTitle(`${env.agentId} · ${env.task}`, env.id);
}

export class ReceiptArtifactProvider implements ArtifactProvider {
	readonly category = "receipt" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const runs = listRunEnvelopes(this.deps);
		return runs
			.filter(
				(env) => env.receiptPath !== null || maybeSizeBytes(receiptFilePath(this.deps.dataDir, env.id)) !== undefined,
			)
			.map((env) => {
				const path = env.receiptPath ?? receiptFilePath(this.deps.dataDir, env.id);
				return {
					id: env.id,
					category: this.category,
					title: receiptTitle(env),
					timestamp: parseTime(env.endedAt ?? env.startedAt),
					sizeBytes: maybeSizeBytes(path),
					path,
					load: () => loadJsonFileLines(path),
					verify: async () => {
						const result = verifyReceiptFile(this.deps.dataDir, env.id);
						return result.ok ? { ok: true, detail: "integrity verified" } : { ok: false, detail: result.reason };
					},
				};
			});
	}
}

function resultText(result: unknown): string {
	if (!isRecord(result)) return "";
	if (result.kind === "ok" && typeof result.output === "string") return result.output;
	if (result.kind === "error" && typeof result.message === "string") return result.message;
	return "";
}

function resultDetails(result: unknown): Record<string, unknown> | null {
	return isRecord(result) && isRecord(result.details) ? result.details : null;
}

function messagePayload(entry: SessionEntry): Record<string, unknown> | null {
	if (entry.kind !== "message") return null;
	return isRecord(entry.payload) ? entry.payload : null;
}

function toolNameFor(entry: SessionEntry): string {
	const payload = messagePayload(entry);
	const name = payload?.toolName ?? payload?.name;
	return typeof name === "string" && name.length > 0 ? name : "tool";
}

function pathFromToolResult(entry: SessionEntry): string | null {
	const payload = messagePayload(entry);
	const details = payload ? resultDetails(payload.result) : null;
	if (!details) return null;
	for (const key of ["fullOutputPath", "outputPath", "artifactPath"] as const) {
		const value = details[key];
		if (typeof value === "string" && value.length > 0) return resolve(value);
	}
	return null;
}

function dispatchResultForRun(entries: ReadonlyArray<SessionEntry>, runId: string): string | null {
	for (const entry of entries) {
		const payload = messagePayload(entry);
		if (!payload) continue;
		const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
		if (toolName !== "dispatch" && toolName !== "dispatch_batch") continue;
		const details = resultDetails(payload.result);
		const detailRunId = details?.runId;
		const runIds = details?.runIds;
		const matches =
			detailRunId === runId ||
			(Array.isArray(runIds) && runIds.some((item) => item === runId)) ||
			(Array.isArray(details?.runs) && details.runs.some((item) => isRecord(item) && item.runId === runId));
		if (!matches) continue;
		const text = resultText(payload.result);
		if (text.length > 0) return text;
	}
	return null;
}

function sessionEntries(deps: ArtifactProviderDeps): ReadonlyArray<SessionEntry> {
	try {
		return deps.readSessionEntries?.() ?? [];
	} catch {
		return [];
	}
}

export class DispatchArtifactProvider implements ArtifactProvider {
	readonly category = "dispatch" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const runs = listRunEnvelopes(this.deps);
		const entries = sessionEntries(this.deps);
		const ledgerPath = runLedgerPath(this.deps.dataDir);
		return runs.map((env) => {
			const receiptPath = env.receiptPath ?? receiptFilePath(this.deps.dataDir, env.id);
			const path = maybeSizeBytes(receiptPath) !== undefined ? receiptPath : ledgerPath;
			return {
				id: env.id,
				category: this.category,
				title: receiptTitle(env),
				timestamp: parseTime(env.endedAt ?? env.startedAt),
				sizeBytes: maybeSizeBytes(path),
				path,
				load: async () => {
					const text = dispatchResultForRun(entries, env.id);
					const lines = [
						`Dispatch run ${env.id}`,
						`agent: ${env.agentId}`,
						`task: ${env.task}`,
						`status: ${env.status}`,
						`outcome: ${env.outcome ?? "unknown"}`,
						`exit: ${env.exitCode ?? "?"}`,
						`target: ${env.endpointId}`,
						`model: ${env.wireModelId}`,
						`runtime: ${env.runtimeKind}:${env.runtimeId}`,
						`started: ${env.startedAt}`,
						`ended: ${env.endedAt ?? "running"}`,
						`tokens: ${env.tokenCount}`,
						`costUsd: ${env.costUsd}`,
						`receipt: ${env.receiptPath ?? receiptFilePath(this.deps.dataDir, env.id)}`,
						"",
						"agent output:",
						...(text ? text.split(/\r?\n/) : ["(no session dispatch tool output found)"]),
					];
					return { lines: splitLinesCapped(lines.join("\n"), path), format: "text" };
				},
			};
		});
	}
}

export class ToolOutputArtifactProvider implements ArtifactProvider {
	readonly category = "tool-output" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const entries = sessionEntries(this.deps);
		const out: ViewArtifact[] = [];
		const seen = new Set<string>();
		for (const entry of entries) {
			if (entry.kind === "bashExecution" && entry.fullOutputPath) {
				const artifact = this.bashArtifact(entry);
				if (!seen.has(artifact.path ?? artifact.id)) {
					seen.add(artifact.path ?? artifact.id);
					out.push(artifact);
				}
				continue;
			}
			if (entry.kind !== "message" || entry.role !== "tool_result") continue;
			const path = pathFromToolResult(entry);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			out.push(this.toolResultArtifact(entry, path));
		}
		return out;
	}

	private bashArtifact(entry: BashExecutionEntry): ViewArtifact {
		const path = resolve(entry.fullOutputPath ?? "");
		return {
			id: `bash:${entry.turnId}`,
			category: this.category,
			title: safeTitle(`Bash · ${entry.command}`, "Bash output"),
			timestamp: parseTime(entry.timestamp),
			sizeBytes: maybeSizeBytes(path),
			path,
			load: () => loadTextPath(path),
		};
	}

	private toolResultArtifact(entry: MessageEntry, path: string): ViewArtifact {
		const toolName = toolNameFor(entry);
		return {
			id: `tool:${entry.turnId}`,
			category: this.category,
			title: safeTitle(`${toolName} · ${basename(path)}`, `${toolName} output`),
			timestamp: parseTime(entry.timestamp),
			sizeBytes: maybeSizeBytes(path),
			path,
			load: () => loadTextPath(path),
		};
	}
}

export class CompactionArtifactProvider implements ArtifactProvider {
	readonly category = "compaction" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const entries = sessionEntries(this.deps);
		const path = sessionCurrentPath(this.deps.dataDir, this.deps.sessionMeta);
		return entries
			.filter((entry) => entry.kind === "compactionSummary")
			.map((entry) => ({
				id: `compaction:${entry.turnId}`,
				category: this.category,
				title: safeTitle(`Compaction · ${entry.trigger ?? "summary"}`, "Compaction summary"),
				timestamp: parseTime(entry.timestamp),
				sizeBytes: Buffer.byteLength(entry.summary, "utf8"),
				...(path ? { path } : {}),
				load: async () => ({
					format: "markdown" as const,
					lines: [
						"# Compaction Summary",
						"",
						`- trigger: ${entry.trigger ?? "unknown"}`,
						`- tokens before: ${entry.tokensBefore}`,
						...(entry.tokensAfter !== undefined ? [`- tokens after: ${entry.tokensAfter}`] : []),
						...(entry.messagesSummarized !== undefined ? [`- messages summarized: ${entry.messagesSummarized}`] : []),
						`- continues at turn: ${entry.firstKeptTurnId}`,
						"",
						entry.summary,
					],
				}),
			}));
	}
}

export function createDefaultArtifactProviders(deps: ArtifactProviderDeps): ArtifactProvider[] {
	return [
		new ReceiptArtifactProvider(deps),
		new DispatchArtifactProvider(deps),
		new ToolOutputArtifactProvider(deps),
		new CompactionArtifactProvider(deps),
	];
}

export function sortViewArtifacts(artifacts: ReadonlyArray<ViewArtifact>): ViewArtifact[] {
	return [...artifacts].sort((a, b) => {
		const time = b.timestamp - a.timestamp;
		if (time !== 0) return time;
		const category = VIEW_ARTIFACT_CATEGORIES.indexOf(a.category) - VIEW_ARTIFACT_CATEGORIES.indexOf(b.category);
		if (category !== 0) return category;
		return a.id.localeCompare(b.id);
	});
}

export async function listViewArtifacts(providers: ReadonlyArray<ArtifactProvider>): Promise<ViewArtifact[]> {
	const groups = await Promise.all(
		providers.map(async (provider) => {
			try {
				return await provider.list();
			} catch {
				return [];
			}
		}),
	);
	return sortViewArtifacts(groups.flat());
}

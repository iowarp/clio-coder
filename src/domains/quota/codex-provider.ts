/**
 * Quota adapter for the OpenAI Codex subscription.
 *
 * Codex CLI stores its own OAuth record in `auth.json`, honoring
 * `CODEX_HOME` when set the same way the `codex` command does. This
 * adapter reads that file and never writes it, then reads current usage
 * from the ChatGPT backend's usage endpoint.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatPlan, type QuotaProvider, type UsageCredits, type UsageSnapshot, type UsageWindow } from "./types.js";

export const CODEX_QUOTA_PROVIDER_ID = "codex";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const DISPLAY_NAME = "Codex";
const REQUEST_TIMEOUT_MS = 15_000;
const WINDOW_ORDER: Record<string, number> = { session: 0, weekly: 1 };
const WEEKLY_THRESHOLD_SECONDS = 86_400;

/** The subset of Codex's stored OAuth record this adapter needs. */
export interface CodexCredentials {
	accessToken: string;
	accountId: string | null;
}

export interface CodexQuotaOptions {
	/** Override the credential file location; defaults to `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. */
	credentialsPath?: string;
	/** Replace credential reading entirely, which is how tests supply a token. */
	readCredentials?: () => Promise<CodexCredentials | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}

/** Codex's default credential file path. */
function defaultCodexCredentialsPath(): string {
	const codexHome = process.env.CODEX_HOME;
	return codexHome ? join(codexHome, "auth.json") : join(homedir(), ".codex", "auth.json");
}

/** Extract the access token and account id from a parsed credential document. */
function parseCodexCredentials(raw: unknown): CodexCredentials | null {
	if (!isRecord(raw)) return null;
	const tokens = raw.tokens;
	if (!isRecord(tokens)) return null;
	const accessToken = tokens.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) return null;
	const accountId = tokens.account_id;
	return {
		accessToken,
		accountId: typeof accountId === "string" ? accountId : null,
	};
}

async function readCredentialsFile(path: string): Promise<CodexCredentials | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		return parseCodexCredentials(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Build the read-only `codex` quota adapter. */
export function createCodexQuotaProvider(options: CodexQuotaOptions = {}): QuotaProvider {
	const credentialsPath = options.credentialsPath ?? defaultCodexCredentialsPath();
	const readCredentials = options.readCredentials ?? (() => readCredentialsFile(credentialsPath));
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	const snapshot = (
		status: UsageSnapshot["status"],
		message: string | null,
		extra: Partial<UsageSnapshot> = {},
	): UsageSnapshot => ({
		providerId: CODEX_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,
		status,
		windows: [],
		message,
		fetchedAt: now().toISOString(),
		...extra,
	});

	return {
		id: CODEX_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,

		async detect(): Promise<boolean> {
			return (await readCredentials()) !== null;
		},

		async fetch(): Promise<UsageSnapshot> {
			const credentials = await readCredentials();
			if (credentials === null) {
				return snapshot("no_credentials", "No Codex credentials found");
			}

			const headers: Record<string, string> = {
				Authorization: `Bearer ${credentials.accessToken}`,
				"User-Agent": "codex-cli",
			};
			if (credentials.accountId !== null) {
				headers["ChatGPT-Account-Id"] = credentials.accountId;
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let response: Response;
			try {
				response = await doFetch(CODEX_USAGE_URL, {
					method: "GET",
					headers,
					signal: controller.signal,
				});
			} catch (error) {
				return snapshot("error", describeError(error, timeoutMs));
			} finally {
				clearTimeout(timer);
			}

			if (response.status === 401 || response.status === 403) {
				await discardBody(response);
				return snapshot("expired", "Sign in with Codex again");
			}
			if (response.status !== 200) {
				await discardBody(response);
				return snapshot("error", `HTTP ${response.status}`);
			}

			let body: unknown;
			try {
				body = await response.json();
			} catch {
				return snapshot("error", "Unexpected usage response");
			}
			if (!isRecord(body)) {
				return snapshot("error", "Unexpected usage response");
			}

			const planType = typeof body.plan_type === "string" ? body.plan_type : null;
			return snapshot("ok", null, {
				windows: usageWindows(body.rate_limit),
				credits: usageCredits(body.credits),
				plan: formatPlan(planType),
			});
		},
	};
}

/** Windows from the `rate_limit.primary_window` and `.secondary_window` slots. */
function usageWindows(raw: unknown): UsageWindow[] {
	if (!isRecord(raw)) return [];
	const windows: UsageWindow[] = [];
	const primary = buildWindow(raw.primary_window, "session");
	if (primary !== null) windows.push(primary);
	const secondary = buildWindow(raw.secondary_window, "weekly");
	if (secondary !== null) windows.push(secondary);
	return windows.sort((left, right) => {
		const order = (WINDOW_ORDER[left.key] ?? 2) - (WINDOW_ORDER[right.key] ?? 2);
		return order !== 0 ? order : left.label.localeCompare(right.label);
	});
}

/** One `rate_limit` window slot, with the key defaulting when `limit_window_seconds` is absent. */
function buildWindow(raw: unknown, defaultKey: "session" | "weekly"): UsageWindow | null {
	if (!isRecord(raw)) return null;
	const usedPct = asNumber(raw.used_percent);
	if (usedPct === null) return null;
	const key = windowKey(raw.limit_window_seconds, defaultKey);
	const label = key === "weekly" ? "Weekly" : "5h";
	const short = key === "weekly" ? "wk" : "5h";
	return { key, label, short, usedPct, resetsAt: epochSecondsToIso(raw.reset_at) };
}

function windowKey(limitWindowSeconds: unknown, defaultKey: "session" | "weekly"): "session" | "weekly" {
	const seconds = asNumber(limitWindowSeconds);
	if (seconds === null) return defaultKey;
	return seconds >= WEEKLY_THRESHOLD_SECONDS ? "weekly" : "session";
}

/** Credit balance from the `credits` block, present only for credit-billed plans. */
function usageCredits(raw: unknown): UsageCredits | null {
	if (!isRecord(raw)) return null;
	if (raw.unlimited === true) return { display: "Unlimited", usedPct: null };
	if (raw.has_credits === true && typeof raw.balance === "string" && raw.balance.length > 0) {
		return { display: raw.balance, usedPct: null };
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** Convert a UNIX epoch seconds value into an ISO 8601 instant. */
function epochSecondsToIso(value: unknown): string | null {
	const seconds = asNumber(value);
	if (seconds === null) return null;
	const date = new Date(seconds * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function describeError(error: unknown, timeoutMs: number): string {
	if (error instanceof Error) {
		return error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message;
	}
	return String(error);
}

async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		return;
	}
}

/**
 * Shared reader for the ChatGPT backend's Codex usage endpoint.
 *
 * Two runtimes spend a ChatGPT subscription: `openai-codex` with the OAuth
 * credential Clio itself holds, and `codex-cli` with the Codex CLI's own
 * login. The account surface is the same endpoint and response shape, so
 * only the token source and the client identity differ. This module owns
 * the request and the parsing; each adapter owns its credential (#434).
 */

import type { UsageCredits, UsageSnapshot, UsageWindow } from "./types.js";
import { formatPlan } from "./types.js";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const WINDOW_ORDER: Record<string, number> = { session: 0, weekly: 1 };
const WEEKLY_THRESHOLD_SECONDS = 86_400;

/** The token and account a usage read sends. */
export interface CodexAccountToken {
	accessToken: string;
	accountId: string | null;
}

/** What one usage read produced, before an adapter stamps its own identity on it. */
export interface CodexUsageOutcome {
	status: UsageSnapshot["status"];
	message: string | null;
	windows: UsageWindow[];
	credits: UsageCredits | null;
	plan: string | null;
}

export interface CodexUsageDependencies {
	fetch: typeof globalThis.fetch;
	timeoutMs: number;
	/** The client identity headers of the program whose credential this is. */
	identity: Record<string, string>;
}

function outcome(
	status: UsageSnapshot["status"],
	message: string | null,
	extra: Partial<CodexUsageOutcome> = {},
): CodexUsageOutcome {
	return { status, message, windows: [], credits: null, plan: null, ...extra };
}

/** Read current Codex usage for one account, reporting failure as a status. */
export async function fetchCodexUsage(
	token: CodexAccountToken,
	dependencies: CodexUsageDependencies,
): Promise<CodexUsageOutcome> {
	const headers: Record<string, string> = {
		...dependencies.identity,
		Authorization: `Bearer ${token.accessToken}`,
	};
	if (token.accountId !== null) headers["ChatGPT-Account-Id"] = token.accountId;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs);
	let response: Response;
	try {
		response = await dependencies.fetch(CODEX_USAGE_URL, { method: "GET", headers, signal: controller.signal });
	} catch (error) {
		return outcome("error", describeError(error, dependencies.timeoutMs));
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 401 || response.status === 403) {
		await discardBody(response);
		return outcome("expired", null);
	}
	if (response.status !== 200) {
		await discardBody(response);
		return outcome("error", `HTTP ${response.status}`);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return outcome("error", "Unexpected usage response");
	}
	if (!isRecord(body)) {
		return outcome("error", "Unexpected usage response");
	}

	return outcome("ok", null, {
		windows: usageWindows(body.rate_limit),
		credits: usageCredits(body.credits),
		plan: formatPlan(typeof body.plan_type === "string" ? body.plan_type : null),
	});
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNumber(value: unknown): number | null {
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

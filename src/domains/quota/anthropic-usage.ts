/**
 * Shared reader for Anthropic's OAuth usage endpoint.
 *
 * Two runtimes spend an Anthropic subscription: the `claude-code` CLI with
 * its own stored login, and `anthropic-max` with the OAuth credential Clio
 * itself holds. The account surface is the same endpoint and the same two
 * response shapes, so only the token source differs. This module owns the
 * request and the parsing; each adapter owns its credential.
 *
 * The endpoint has shipped both a `limits[]` array and flat
 * `five_hour`/`seven_day` buckets, and has been observed serving both at
 * once. The array wins when present because only it carries severity,
 * the active flag, and per-model scope.
 */

import { parseRetryAfterSeconds, type UsageCredits, type UsageSnapshot, type UsageWindow } from "./types.js";

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

const WINDOW_ORDER: Record<string, number> = { session: 0, weekly: 1 };

/** What one usage read produced, before an adapter stamps its own identity on it. */
export interface AnthropicUsageOutcome {
	status: UsageSnapshot["status"];
	message: string | null;
	windows: UsageWindow[];
	credits: UsageCredits | null;
	retryAfterSeconds: number | null;
}

export interface AnthropicUsageDependencies {
	fetch: typeof globalThis.fetch;
	timeoutMs: number;
}

function outcome(
	status: UsageSnapshot["status"],
	message: string | null,
	extra: Partial<AnthropicUsageOutcome> = {},
): AnthropicUsageOutcome {
	return { status, message, windows: [], credits: null, retryAfterSeconds: null, ...extra };
}

/** Read current Anthropic usage with a bearer token, reporting failure as a status. */
export async function fetchAnthropicUsage(
	token: string,
	dependencies: AnthropicUsageDependencies,
): Promise<AnthropicUsageOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs);
	let response: Response;
	try {
		response = await dependencies.fetch(ANTHROPIC_USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": ANTHROPIC_OAUTH_BETA,
			},
			signal: controller.signal,
		});
	} catch (error) {
		return outcome("error", describeError(error, dependencies.timeoutMs));
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 401 || response.status === 403) {
		await discardBody(response);
		return outcome("expired", null);
	}
	if (response.status === 429) {
		await discardBody(response);
		return outcome("error", "HTTP 429", {
			retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("Retry-After")),
		});
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

	return outcome("ok", null, { windows: usageWindows(body), credits: usageCredits(body.spend) });
}

/** Windows from `limits[]` when the endpoint sends it, otherwise the flat buckets. */
function usageWindows(body: Record<string, unknown>): UsageWindow[] {
	const fromLimits = windowsFromLimits(body.limits);
	const windows = fromLimits.length > 0 ? fromLimits : windowsFromFlat(body);
	return windows.sort((left, right) => {
		const order = (WINDOW_ORDER[left.key] ?? 2) - (WINDOW_ORDER[right.key] ?? 2);
		return order !== 0 ? order : left.label.localeCompare(right.label);
	});
}

function windowsFromLimits(raw: unknown): UsageWindow[] {
	if (!Array.isArray(raw)) return [];
	const windows: UsageWindow[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const percent = asNumber(entry.percent);
		if (percent === null) continue;
		const common: Pick<UsageWindow, "usedPct" | "resetsAt" | "severity" | "active"> = {
			usedPct: percent,
			resetsAt: asIsoString(entry.resets_at),
		};
		if (typeof entry.severity === "string") common.severity = entry.severity;
		if (entry.is_active === true) common.active = true;
		if (entry.kind === "session") {
			windows.push({ key: "session", label: "5h", short: "5h", ...common });
		} else if (entry.kind === "weekly_all") {
			windows.push({ key: "weekly", label: "Weekly", short: "wk", ...common });
		} else if (entry.kind === "weekly_scoped") {
			const name = scopeName(entry.scope);
			if (name === null) continue;
			windows.push({ key: `weekly_scoped.${slug(name)}`, label: name, scope: name, ...common });
		}
	}
	return windows;
}

function windowsFromFlat(body: Record<string, unknown>): UsageWindow[] {
	const windows: UsageWindow[] = [];
	const fiveHour = bucketWindow(body.five_hour, "session", "5h", "5h");
	if (fiveHour !== null) windows.push(fiveHour);
	const sevenDay = bucketWindow(body.seven_day, "weekly", "Weekly", "wk");
	if (sevenDay !== null) windows.push(sevenDay);
	return windows;
}

function bucketWindow(raw: unknown, key: string, label: string, short: string): UsageWindow | null {
	if (!isRecord(raw)) return null;
	const usedPct = asNumber(raw.utilization);
	if (usedPct === null) return null;
	return { key, label, short, usedPct, resetsAt: asIsoString(raw.resets_at) };
}

function scopeName(raw: unknown): string | null {
	if (!isRecord(raw)) return null;
	const model = raw.model;
	if (!isRecord(model)) return null;
	const name = typeof model.display_name === "string" ? model.display_name.trim() : "";
	if (name.length === 0) return null;
	return slug(name) === "all-models" || slug(name) === "all" ? null : name;
}

/** Credit balance from the `spend` block, present only for credit-billed plans. */
function usageCredits(raw: unknown): UsageCredits | null {
	if (!isRecord(raw) || raw.enabled !== true) return null;
	const percent = asNumber(raw.percent);
	const limit = majorAmount(raw.limit);
	if (limit === null) {
		return percent === null ? null : { display: `${percent.toFixed(0)}% used`, usedPct: percent };
	}
	const used = majorAmount(raw.used);
	if (used === null) return null;
	const currency = isRecord(raw.limit) && typeof raw.limit.currency === "string" ? raw.limit.currency : "USD";
	const symbol = currency === "USD" ? "$" : "";
	const usedPct = percent ?? (limit > 0 ? (used / limit) * 100 : null);
	return { display: `${symbol}${used.toFixed(2)} / ${symbol}${limit.toFixed(2)}`, usedPct };
}

function majorAmount(raw: unknown): number | null {
	if (!isRecord(raw)) return null;
	const minor = asNumber(raw.amount_minor);
	if (minor === null) return null;
	const exponent = asNumber(raw.exponent) ?? 0;
	return minor / 10 ** exponent;
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

function asIsoString(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
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

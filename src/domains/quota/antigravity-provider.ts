/**
 * Quota adapter for the Antigravity CLI used as a delegation target.
 *
 * Antigravity stores its own OAuth record; on Linux that is a plain file
 * under the agy CLI's state directory rather than an OS credential store.
 * This adapter reads it and never writes it.
 *
 * Deliberately narrower than QuotaBubble's provider: there is no token
 * refresh here. Refreshing would mean POSTing another product's refresh
 * token to Google with client credentials scraped out of the agy binary,
 * which is a new auth flow against someone else's account. When the stored
 * token has expired the adapter says so and leaves renewal to the operator.
 *
 * The quota surface has two shapes. A project-scoped quota summary is
 * preferred; the available-models response is the fallback when a summary
 * carries no usable bucket.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatPlan, type QuotaProvider, type UsageSnapshot, type UsageWindow } from "./types.js";

export const ANTIGRAVITY_QUOTA_PROVIDER_ID = "antigravity";

const DISPLAY_NAME = "Antigravity";
const USER_AGENT = "antigravity";
const REQUEST_TIMEOUT_MS = 20_000;
const EXPIRY_SKEW_MS = 60_000;
const WINDOW_ORDER: Record<string, number> = { session: 0, weekly: 1 };
const MODEL_PREFIXES = ["gemini", "claude", "gpt", "image", "imagen"];

const ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];

/** The subset of Antigravity's stored OAuth record this adapter needs. */
export interface AntigravityCredentials {
	accessToken: string;
	refreshToken: string | null;
	/** Epoch milliseconds the access token expires, or null when unparseable. */
	expiryMs: number | null;
}

export interface AntigravityQuotaOptions {
	/** Override the credential file location; defaults to the agy CLI's token file. */
	credentialsPath?: string;
	readCredentials?: () => Promise<AntigravityCredentials | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}

function defaultCredentialsPath(): string {
	return join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function parseCredentials(raw: unknown): AntigravityCredentials | null {
	if (!isRecord(raw)) return null;
	const token = raw.token;
	if (!isRecord(token)) return null;
	const accessToken = token.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) return null;
	const refreshToken = token.refresh_token;
	return {
		accessToken,
		refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
		expiryMs: asEpochMs(token.expiry),
	};
}

async function readCredentialsFile(path: string): Promise<AntigravityCredentials | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		return parseCredentials(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Outcome of one endpoint round trip, keeping auth failure distinct from transport failure. */
type PostResult = { kind: "ok"; data: Record<string, unknown> } | { kind: "auth" } | { kind: "error"; message: string };

type CollectResult =
	| { kind: "ok"; windows: UsageWindow[]; plan: string | null }
	| { kind: "auth" }
	| { kind: "error"; message: string };

/** Build the read-only Antigravity quota adapter. */
export function createAntigravityQuotaProvider(options: AntigravityQuotaOptions = {}): QuotaProvider {
	const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
	const readCredentials = options.readCredentials ?? (() => readCredentialsFile(credentialsPath));
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	const snapshot = (
		status: UsageSnapshot["status"],
		message: string | null,
		extra: Partial<UsageSnapshot> = {},
	): UsageSnapshot => ({
		providerId: ANTIGRAVITY_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,
		status,
		windows: [],
		message,
		fetchedAt: now().toISOString(),
		...extra,
	});

	const post = async (url: string, token: string, body: unknown): Promise<PostResult> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		try {
			response = await doFetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			return { kind: "error", message: describeError(error, timeoutMs) };
		} finally {
			clearTimeout(timer);
		}

		if (response.status === 401 || response.status === 403) {
			await discardBody(response);
			return { kind: "auth" };
		}
		if (response.status !== 200) {
			await discardBody(response);
			return { kind: "error", message: `HTTP ${response.status}` };
		}
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			return { kind: "error", message: "Unexpected usage response" };
		}
		return isRecord(data) ? { kind: "ok", data } : { kind: "error", message: "Unexpected usage response" };
	};

	const collect = async (base: string, token: string): Promise<CollectResult> => {
		const load = await post(`${base}/v1internal:loadCodeAssist`, token, { metadata: { ideType: "ANTIGRAVITY" } });
		if (load.kind !== "ok") return load;

		const project = typeof load.data.cloudaicompanionProject === "string" ? load.data.cloudaicompanionProject : null;
		const plan = tierPlan(load.data.currentTier);

		if (project !== null) {
			const summary = await post(`${base}/v1internal:retrieveUserQuotaSummary`, token, { project });
			if (summary.kind === "auth") return summary;
			if (summary.kind === "ok") {
				const windows = windowsFromSummary(summary.data);
				if (windows.length > 0) return { kind: "ok", windows, plan };
			}
		}

		const models = await post(`${base}/v1internal:fetchAvailableModels`, token, project === null ? {} : { project });
		if (models.kind !== "ok") return models;
		return { kind: "ok", windows: modelWindows(models.data), plan };
	};

	return {
		id: ANTIGRAVITY_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,

		async detect(): Promise<boolean> {
			return (await readCredentials()) !== null;
		},

		async fetch(): Promise<UsageSnapshot> {
			const credentials = await readCredentials();
			if (credentials === null) {
				return snapshot("no_credentials", "No Antigravity credentials found");
			}
			if (credentials.expiryMs !== null && credentials.expiryMs <= now().getTime() + EXPIRY_SKEW_MS) {
				return snapshot("expired", "Antigravity's stored token expired; run the agy command once to refresh it");
			}

			let sawAuthFailure = false;
			let lastError: string | null = null;
			for (const base of ENDPOINTS) {
				const result = await collect(base, credentials.accessToken);
				if (result.kind === "auth") {
					sawAuthFailure = true;
					continue;
				}
				if (result.kind === "error") {
					lastError = result.message;
					continue;
				}
				if (result.windows.length > 0) {
					return snapshot("ok", null, { windows: result.windows, plan: result.plan });
				}
			}

			if (sawAuthFailure) return snapshot("expired", "Sign in with Antigravity again");
			if (lastError !== null) return snapshot("error", lastError);
			return snapshot("error", "Antigravity returned no quota");
		},
	};
}

function tierPlan(raw: unknown): string | null {
	if (!isRecord(raw)) return null;
	const plan = formatPlan(typeof raw.name === "string" ? raw.name : null);
	if (plan === null) return null;
	return plan.toLowerCase() === DISPLAY_NAME.toLowerCase() ? null : plan;
}

/** Preserve every reported group; Gemini stays first for the compact summary. */
function windowsFromSummary(data: Record<string, unknown>): UsageWindow[] {
	if (!Array.isArray(data.groups)) return [];
	const groups = data.groups.filter(isRecord).sort((a, b) => Number(isGeminiGroup(b)) - Number(isGeminiGroup(a)));
	return groups.flatMap((group, index) => {
		const scope =
			typeof group.displayName === "string" && group.displayName.trim()
				? group.displayName.trim()
				: `Model group ${index + 1}`;
		return windowsFromGroup(group).map((window) => ({
			...window,
			key: index === 0 ? window.key : `group.${index}.${window.key}`,
			scope,
		}));
	});
}

function windowsFromGroup(group: Record<string, unknown>): UsageWindow[] {
	if (!Array.isArray(group.buckets)) return [];
	const windows: UsageWindow[] = [];
	for (const bucket of group.buckets) {
		if (!isRecord(bucket)) continue;
		const window = typeof bucket.window === "string" ? bucket.window.toLowerCase() : null;
		const usedPct = usedFromRemaining(bucket.remainingFraction);
		if (usedPct === null) continue;
		if (window === "5h") {
			windows.push({ key: "session", label: "5h", short: "5h", usedPct, resetsAt: asIsoString(bucket.resetTime) });
		} else if (window === "weekly") {
			windows.push({ key: "weekly", label: "Weekly", short: "wk", usedPct, resetsAt: asIsoString(bucket.resetTime) });
		}
	}
	return windows.sort((left, right) => (WINDOW_ORDER[left.key] ?? 2) - (WINDOW_ORDER[right.key] ?? 2));
}

function isGeminiGroup(group: Record<string, unknown>): boolean {
	if (mentionsGemini(group.displayName) || mentionsGemini(group.description)) return true;
	if (!Array.isArray(group.buckets)) return false;
	return group.buckets.some((bucket) => {
		if (!isRecord(bucket)) return false;
		const id = typeof bucket.bucketId === "string" ? bucket.bucketId.toLowerCase() : "";
		return id.startsWith("gemini-") || mentionsGemini(bucket.displayName);
	});
}

function mentionsGemini(value: unknown): boolean {
	return typeof value === "string" && value.toLowerCase().includes("gemini");
}

/** The fallback reports model quotas without declaring a window duration. */
function modelWindows(data: Record<string, unknown>): UsageWindow[] {
	if (!isRecord(data.models)) return [];
	const windows: UsageWindow[] = [];
	for (const [name, info] of Object.entries(data.models)) {
		if (!isRecord(info) || !isRecord(info.quotaInfo)) continue;
		if (!MODEL_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))) continue;
		const usedPct = usedFromRemaining(info.quotaInfo.remainingFraction);
		if (usedPct === null) continue;
		windows.push({
			key: `model.${name}`,
			label: "Model quota",
			short: name,
			scope: name,
			usedPct,
			resetsAt: asIsoString(info.quotaInfo.resetTime),
		});
	}
	return windows;
}

function usedFromRemaining(raw: unknown): number | null {
	const remaining = asNumber(raw);
	if (remaining === null) return null;
	return (1 - Math.min(1, Math.max(0, remaining))) * 100;
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

function asEpochMs(value: unknown): number | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
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

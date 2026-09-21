/**
 * Quota adapter for the `anthropic-max` runtime, the account Clio itself
 * spends when it runs a native turn.
 *
 * Unlike `claude-code`, this credential belongs to Clio: it is the OAuth
 * record her own auth storage persists under the `anthropic` provider id.
 * The adapter reads the stored credential without triggering a refresh,
 * because a quota read must never mutate an authentication record.
 *
 * Both adapters can point at the same Anthropic account. That is a display
 * concern rather than a correctness one: each reports what its own
 * credential sees, and a consumer that shows both should say which
 * credential produced which row.
 */

import { openAuthStorage } from "../providers/auth/index.js";
import { fetchAnthropicUsage } from "./anthropic-usage.js";
import type { QuotaProvider, UsageSnapshot } from "./types.js";

export const ANTHROPIC_MAX_QUOTA_PROVIDER_ID = "anthropic-max";

/** The provider id Clio's auth storage files an Anthropic OAuth credential under. */
const AUTH_PROVIDER_ID = "anthropic";
const DISPLAY_NAME = "Anthropic Max";
const REQUEST_TIMEOUT_MS = 15_000;

/** The subset of Clio's stored OAuth credential this adapter needs. */
export interface AnthropicMaxCredentials {
	accessToken: string;
	/** Epoch milliseconds the access token expires, or null when the record omits it. */
	expiresAtMs: number | null;
	hasRefreshToken: boolean;
}

export interface AnthropicMaxQuotaOptions {
	readCredentials?: () => Promise<AnthropicMaxCredentials | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}

/** Shape a stored auth credential into the fields a usage read needs. */
export function parseStoredAnthropicCredential(raw: unknown): AnthropicMaxCredentials | null {
	if (!isRecord(raw) || raw.type !== "oauth") return null;
	const access = raw.access;
	if (typeof access !== "string" || access.length === 0) return null;
	const refresh = raw.refresh;
	return {
		accessToken: access,
		expiresAtMs: asNumber(raw.expires),
		hasRefreshToken: typeof refresh === "string" && refresh.length > 0,
	};
}

/**
 * Read Clio's stored Anthropic credential.
 *
 * `AuthStorage.get` is the accessor that does no refresh, unlike
 * `resolveApiKey`, which renews an expiring credential as a side effect.
 */
async function readStoredCredential(): Promise<AnthropicMaxCredentials | null> {
	try {
		return parseStoredAnthropicCredential(openAuthStorage().get(AUTH_PROVIDER_ID));
	} catch {
		return null;
	}
}

/** Build the read-only `anthropic-max` quota adapter. */
export function createAnthropicMaxQuotaProvider(options: AnthropicMaxQuotaOptions = {}): QuotaProvider {
	const readCredentials = options.readCredentials ?? readStoredCredential;
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	const snapshot = (
		status: UsageSnapshot["status"],
		message: string | null,
		extra: Partial<UsageSnapshot> = {},
	): UsageSnapshot => ({
		providerId: ANTHROPIC_MAX_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,
		status,
		windows: [],
		message,
		fetchedAt: now().toISOString(),
		...extra,
	});

	return {
		id: ANTHROPIC_MAX_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,

		async detect(): Promise<boolean> {
			return (await readCredentials()) !== null;
		},

		async fetch(): Promise<UsageSnapshot> {
			const credentials = await readCredentials();
			if (credentials === null) {
				return snapshot("no_credentials", "Clio holds no Anthropic OAuth credential");
			}
			if (credentials.expiresAtMs !== null && credentials.expiresAtMs <= now().getTime()) {
				return snapshot(
					"expired",
					credentials.hasRefreshToken
						? "Clio's Anthropic token expired; the next turn refreshes it"
						: "Run clio-coder auth login anthropic again",
				);
			}

			const usage = await fetchAnthropicUsage(credentials.accessToken, { fetch: doFetch, timeoutMs });
			if (usage.status !== "ok") {
				return snapshot(usage.status, usage.message ?? "Run clio-coder auth login anthropic again", {
					retryAfterSeconds: usage.retryAfterSeconds,
				});
			}
			return snapshot("ok", null, { windows: usage.windows, credits: usage.credits });
		},
	};
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

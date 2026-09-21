/**
 * Quota adapter for the `claude-code` runtime.
 *
 * Clio does not store Claude Code credentials of its own: the runtime
 * delegates authentication to the installed `claude` command, as
 * `src/domains/providers/runtimes/claude/common.ts` states. This adapter
 * therefore reads Claude Code's own OAuth token file and never writes it.
 *
 * The request and response parsing live in `anthropic-usage.ts`, shared
 * with the `anthropic-max` adapter, because both spend the same kind of
 * Anthropic subscription through the same endpoint.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchAnthropicUsage } from "./anthropic-usage.js";
import { formatPlan, type QuotaProvider, type UsageSnapshot } from "./types.js";

export const CLAUDE_CODE_QUOTA_PROVIDER_ID = "claude-code";

const DISPLAY_NAME = "Claude Code";
const REQUEST_TIMEOUT_MS = 15_000;

/** The subset of Claude Code's stored OAuth record this adapter needs. */
export interface ClaudeCodeCredentials {
	accessToken: string;
	subscriptionType: string | null;
	/** Epoch milliseconds the access token expires, or null when the record omits it. */
	expiresAtMs: number | null;
	/** Epoch milliseconds the refresh token expires, or null when the record omits it. */
	refreshTokenExpiresAtMs: number | null;
	/** True when a refresh token is present, meaning the `claude` command can renew itself. */
	hasRefreshToken: boolean;
}

export interface ClaudeCodeQuotaOptions {
	/** Override the credential file location; defaults to `~/.claude/.credentials.json`. */
	credentialsPath?: string;
	/** Replace credential reading entirely, which is how tests supply a token. */
	readCredentials?: () => Promise<ClaudeCodeCredentials | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}

function defaultClaudeCredentialsPath(): string {
	return join(homedir(), ".claude", ".credentials.json");
}

/** Extract the OAuth access token from a parsed credential document. */
export function parseClaudeCredentials(raw: unknown): ClaudeCodeCredentials | null {
	if (!isRecord(raw)) return null;
	const oauth = raw.claudeAiOauth;
	if (!isRecord(oauth)) return null;
	const token = oauth.accessToken;
	if (typeof token !== "string" || token.length === 0) return null;
	const subscription = oauth.subscriptionType;
	const refreshToken = oauth.refreshToken;
	return {
		accessToken: token,
		subscriptionType: typeof subscription === "string" ? subscription : null,
		expiresAtMs: asNumber(oauth.expiresAt),
		refreshTokenExpiresAtMs: asNumber(oauth.refreshTokenExpiresAt),
		hasRefreshToken: typeof refreshToken === "string" && refreshToken.length > 0,
	};
}

/**
 * Why a stored token cannot be used, read from the record alone.
 *
 * Claude Code rewrites this file when its own command refreshes, so a stale
 * `expiresAt` means the command has not run lately rather than that the
 * subscription lapsed. The two cases need different advice, and neither
 * needs a network call to detect.
 */
function expiryMessage(credentials: ClaudeCodeCredentials, nowMs: number): string | null {
	const { expiresAtMs, refreshTokenExpiresAtMs, hasRefreshToken } = credentials;
	if (expiresAtMs === null || expiresAtMs > nowMs) return null;
	const refreshUsable = hasRefreshToken && (refreshTokenExpiresAtMs === null || refreshTokenExpiresAtMs > nowMs);
	return refreshUsable
		? "Claude Code's stored token expired; run the claude command once to refresh it"
		: "Sign in with Claude Code again";
}

async function readCredentialsFile(path: string): Promise<ClaudeCodeCredentials | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		return parseClaudeCredentials(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Build the read-only `claude-code` quota adapter. */
export function createClaudeCodeQuotaProvider(options: ClaudeCodeQuotaOptions = {}): QuotaProvider {
	const credentialsPath = options.credentialsPath ?? defaultClaudeCredentialsPath();
	const readCredentials = options.readCredentials ?? (() => readCredentialsFile(credentialsPath));
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	const snapshot = (
		status: UsageSnapshot["status"],
		message: string | null,
		extra: Partial<UsageSnapshot> = {},
	): UsageSnapshot => ({
		providerId: CLAUDE_CODE_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,
		status,
		windows: [],
		message,
		fetchedAt: now().toISOString(),
		...extra,
	});

	return {
		id: CLAUDE_CODE_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,

		async detect(): Promise<boolean> {
			return (await readCredentials()) !== null;
		},

		async fetch(): Promise<UsageSnapshot> {
			const credentials = await readCredentials();
			if (credentials === null) {
				return snapshot("no_credentials", "No Claude Code credentials found");
			}

			// A token the record already declares expired cannot be spent, so skip the request.
			const expired = expiryMessage(credentials, now().getTime());
			if (expired !== null) {
				return snapshot("expired", expired);
			}

			const usage = await fetchAnthropicUsage(credentials.accessToken, { fetch: doFetch, timeoutMs });
			if (usage.status !== "ok") {
				return snapshot(usage.status, usage.message ?? "Sign in with Claude Code again", {
					retryAfterSeconds: usage.retryAfterSeconds,
				});
			}
			return snapshot("ok", null, {
				windows: usage.windows,
				credits: usage.credits,
				plan: formatPlan(credentials.subscriptionType),
			});
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

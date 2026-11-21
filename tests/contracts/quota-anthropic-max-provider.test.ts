import assert from "node:assert/strict";
import { it } from "node:test";

import type { AnthropicMaxCredentials } from "../../src/domains/quota/anthropic-max-provider.js";
import {
	createAnthropicMaxQuotaProvider,
	parseStoredAnthropicCredential,
} from "../../src/domains/quota/anthropic-max-provider.js";
import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_USAGE_URL } from "../../src/domains/quota/anthropic-usage.js";
import { createQuotaCache } from "../../src/domains/quota/cache.js";
import { createClaudeCodeQuotaProvider } from "../../src/domains/quota/claude-code-provider.js";
import { createQuotaService } from "../../src/domains/quota/service.js";
import type { QuotaProvider, UsageSnapshot } from "../../src/domains/quota/types.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const CREDENTIALS: AnthropicMaxCredentials = {
	accessToken: "sk-ant-oat-stored",
	expiresAtMs: NOW.getTime() + 3_600_000,
	hasRefreshToken: true,
};

interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

function stubFetch(respond: () => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
		return respond();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function provider(fetch: typeof globalThis.fetch, credentials: AnthropicMaxCredentials | null = CREDENTIALS) {
	return createAnthropicMaxQuotaProvider({ readCredentials: async () => credentials, fetch, now: () => NOW });
}

it("reads Clio's own Anthropic credential and reports its windows", async () => {
	const { fetch, calls } = stubFetch(() =>
		jsonResponse({
			five_hour: { utilization: 21, resets_at: "2026-01-01T04:00:00Z" },
			seven_day: { utilization: 44 },
		}),
	);

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.providerId, "anthropic-max");
	assert.equal(snapshot.displayName, "Anthropic Max");
	assert.deepEqual(
		snapshot.windows.map((window) => [window.key, window.usedPct]),
		[
			["session", 21],
			["weekly", 44],
		],
	);
	assert.equal(calls[0]?.url, ANTHROPIC_USAGE_URL);
	assert.equal(calls[0]?.headers.authorization, `Bearer ${CREDENTIALS.accessToken}`);
	assert.equal(calls[0]?.headers["anthropic-beta"], ANTHROPIC_OAUTH_BETA);
});

it("shares the limits[] parsing with the claude-code adapter", async () => {
	const { fetch } = stubFetch(() =>
		jsonResponse({
			limits: [
				{ kind: "weekly_all", percent: 33, severity: "normal" },
				{ kind: "session", percent: 7, is_active: true },
			],
			five_hour: { utilization: 99 },
		}),
	);

	const snapshot = await provider(fetch).fetch();

	assert.deepEqual(
		snapshot.windows.map((window) => [window.key, window.usedPct]),
		[
			["session", 7],
			["weekly", 33],
		],
	);
	assert.equal(snapshot.windows[0]?.active, true);
});

it("does not call the endpoint when the stored credential has expired", async () => {
	const { fetch, calls } = stubFetch(() => jsonResponse({}));
	const stale = provider(fetch, { ...CREDENTIALS, expiresAtMs: NOW.getTime() - 1 });

	const snapshot = await stale.fetch();

	assert.equal(snapshot.status, "expired");
	assert.equal(snapshot.message, "Clio's Anthropic token expired; the next turn refreshes it");
	assert.equal(calls.length, 0);
});

it("tells the operator to sign in again when no refresh token is stored", async () => {
	const { fetch } = stubFetch(() => jsonResponse({}));
	const stale = provider(fetch, { ...CREDENTIALS, expiresAtMs: NOW.getTime() - 1, hasRefreshToken: false });

	const snapshot = await stale.fetch();

	assert.equal(snapshot.status, "expired");
	assert.equal(snapshot.message, "Run clio-coder auth login anthropic-max again");
});

it("reports an absent credential without a network call", async () => {
	const { fetch, calls } = stubFetch(() => jsonResponse({}));
	const absent = provider(fetch, null);

	const snapshot = await absent.fetch();

	assert.equal(snapshot.status, "no_credentials");
	assert.equal(snapshot.message, "Clio holds no Anthropic OAuth credential");
	assert.equal(await absent.detect(), false);
	assert.equal(calls.length, 0);
});

it("maps a rejected token to expired with adapter-specific advice", async () => {
	const { fetch } = stubFetch(() => new Response("", { status: 401 }));

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "expired");
	assert.equal(snapshot.message, "Run clio-coder auth login anthropic-max again");
});

it("carries Retry-After through from a rate-limited usage read", async () => {
	const { fetch } = stubFetch(() => new Response("", { status: 429, headers: { "Retry-After": "17" } }));

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.message, "HTTP 429");
	assert.equal(snapshot.retryAfterSeconds, 17);
});

it("polls the two Anthropic adapters one at a time, holds each credential's 429, and a stalled adapter blocks neither (C-19)", {
	timeout: 10_000,
}, async () => {
	let active = 0;
	let peak = 0;
	const { fetch, calls } = stubFetch(() => new Response("", { status: 429, headers: { "Retry-After": "300" } }));
	const serialFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setImmediate(resolve));
		active -= 1;
		return fetch(input, init);
	}) as typeof globalThis.fetch;
	const claudeCodeCredentials = async () => ({
		accessToken: "sk-ant-oat-claude-code",
		subscriptionType: null,
		expiresAtMs: null,
		refreshTokenExpiresAtMs: null,
		hasRefreshToken: true,
	});
	const claudeCode = createClaudeCodeQuotaProvider({
		fetch: serialFetch,
		now: () => NOW,
		readCredentials: claudeCodeCredentials,
	});
	const service = createQuotaService({ providers: [provider(serialFetch), claudeCode], includeLocal: false });

	const rows = await service.read();
	await service.read();

	assert.equal(peak, 1, "adapters on one endpoint never poll at once");
	assert.equal(calls.length, 2, "each credential polls once, then its own 429 holds it");
	assert.deepEqual(
		rows.map((row) => [row.providerId, row.status, row.message]),
		[
			["anthropic-max", "error", "HTTP 429"],
			["claude-code", "error", "HTTP 429"],
		],
	);

	// A body that never ends times out instead of holding the endpoint lane forever.
	const stalled = stubFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
	const timedOut = await createAnthropicMaxQuotaProvider({
		readCredentials: async () => CREDENTIALS,
		fetch: stalled.fetch,
		now: () => NOW,
		timeoutMs: 20,
	}).fetch();
	assert.deepEqual([timedOut.status, timedOut.message], ["error", "timeout after 20ms"]);

	// And a turn that never settles holds its sibling only for the lane bound.
	const hung: QuotaProvider = {
		id: "anthropic-max",
		displayName: "Anthropic Max",
		endpoint: ANTHROPIC_USAGE_URL,
		detect: async () => true,
		fetch: () => new Promise<UsageSnapshot>(() => undefined),
	};
	const cache = createQuotaCache({ laneTurnMs: 20 });
	void cache.resolve(hung);
	const sibling = createClaudeCodeQuotaProvider({ fetch, now: () => NOW, readCredentials: claudeCodeCredentials });
	assert.equal((await cache.resolve(sibling)).status, "error");
});

it("accepts only a stored oauth credential with a usable access token", () => {
	assert.deepEqual(parseStoredAnthropicCredential({ type: "oauth", access: "abc", refresh: "def", expires: 1234 }), {
		accessToken: "abc",
		expiresAtMs: 1234,
		hasRefreshToken: true,
	});
	assert.equal(parseStoredAnthropicCredential({ type: "api_key", key: "sk-ant-api" }), null);
	assert.equal(parseStoredAnthropicCredential({ type: "oauth", access: "" }), null);
	assert.equal(parseStoredAnthropicCredential(undefined), null);
	assert.equal(parseStoredAnthropicCredential({ type: "oauth", access: "abc" })?.hasRefreshToken, false);
});

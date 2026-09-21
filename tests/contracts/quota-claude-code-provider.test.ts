import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_USAGE_URL } from "../../src/domains/quota/anthropic-usage.js";
import { createQuotaCache, DEFAULT_QUOTA_CACHE_TTL_MS } from "../../src/domains/quota/cache.js";
import type { ClaudeCodeCredentials } from "../../src/domains/quota/claude-code-provider.js";
import { createClaudeCodeQuotaProvider, parseClaudeCredentials } from "../../src/domains/quota/claude-code-provider.js";
import { buildQuotaProviders } from "../../src/domains/quota/registry.js";
import type { QuotaProvider, UsageSnapshot } from "../../src/domains/quota/types.js";
import { formatPlan, parseRetryAfterSeconds } from "../../src/domains/quota/types.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const CREDENTIALS: ClaudeCodeCredentials = {
	accessToken: "sk-oauth-test",
	subscriptionType: "max_5x",
	expiresAtMs: NOW.getTime() + 3_600_000,
	refreshTokenExpiresAtMs: NOW.getTime() + 86_400_000,
	hasRefreshToken: true,
};

interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

function stubFetch(
	respond: () => Response | Promise<Response> | never,
	calls: FetchCall[] = [],
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({ url: String(input), headers: Object.fromEntries(headers.entries()) });
		return await respond();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function provider(fetch: typeof globalThis.fetch): QuotaProvider {
	return createClaudeCodeQuotaProvider({
		readCredentials: async () => CREDENTIALS,
		fetch,
		now: () => NOW,
	});
}

it("reads the limits[] usage shape into ordered windows", async () => {
	const { fetch, calls } = stubFetch(() =>
		jsonResponse({
			limits: [
				{
					kind: "weekly_scoped",
					percent: 12,
					resets_at: "2026-01-06T00:00:00Z",
					scope: { model: { display_name: "Opus" } },
				},
				{ kind: "weekly_all", percent: "41.5", resets_at: "2026-01-05T00:00:00Z", severity: "warning" },
				{ kind: "session", percent: 88, resets_at: "2026-01-01T04:00:00Z", is_active: true },
				{ kind: "weekly_scoped", percent: 3, scope: { model: { display_name: "All Models" } } },
				{ kind: "session", resets_at: "2026-01-01T04:00:00Z" },
			],
			spend: {
				enabled: true,
				used: { amount_minor: 1250, exponent: 2, currency: "USD" },
				limit: { amount_minor: 5000, exponent: 2, currency: "USD" },
			},
		}),
	);

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.providerId, "claude-code");
	assert.equal(snapshot.plan, "Max 5x");
	assert.equal(snapshot.fetchedAt, "2026-01-01T00:00:00.000Z");
	assert.deepEqual(
		snapshot.windows.map((window) => [window.key, window.label, window.usedPct]),
		[
			["session", "5h", 88],
			["weekly", "Weekly", 41.5],
			["weekly_scoped.opus", "Opus", 12],
		],
	);
	assert.equal(snapshot.windows[0]?.active, true);
	assert.equal(snapshot.windows[1]?.severity, "warning");
	assert.equal(snapshot.windows[2]?.scope, "Opus");
	assert.equal(snapshot.windows[0]?.resetsAt, "2026-01-01T04:00:00.000Z");
	assert.deepEqual(snapshot.credits, { display: "$12.50 / $50.00", usedPct: 25 });

	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, ANTHROPIC_USAGE_URL);
	assert.equal(calls[0]?.headers.authorization, `Bearer ${CREDENTIALS.accessToken}`);
	assert.equal(calls[0]?.headers["anthropic-beta"], ANTHROPIC_OAUTH_BETA);
});

it("falls back to the flat five_hour and seven_day buckets", async () => {
	const { fetch } = stubFetch(() =>
		jsonResponse({
			five_hour: { utilization: 37.5, resets_at: "2026-01-01T03:00:00Z" },
			seven_day: { utilization: 64 },
			limits: [],
		}),
	);

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.deepEqual(snapshot.windows, [
		{ key: "session", label: "5h", short: "5h", usedPct: 37.5, resetsAt: "2026-01-01T03:00:00.000Z" },
		{ key: "weekly", label: "Weekly", short: "wk", usedPct: 64, resetsAt: null },
	]);
	assert.equal(snapshot.credits, null);
});

it("maps 401 and 403 to an expired session", async () => {
	for (const status of [401, 403]) {
		const { fetch } = stubFetch(() => new Response("", { status }));
		const snapshot = await provider(fetch).fetch();
		assert.equal(snapshot.status, "expired");
		assert.equal(snapshot.message, "Sign in with Claude Code again");
		assert.deepEqual(snapshot.windows, []);
	}
});

it("captures Retry-After when the usage endpoint rate limits the read", async () => {
	const { fetch } = stubFetch(() => new Response("", { status: 429, headers: { "Retry-After": "42" } }));

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.message, "HTTP 429");
	assert.equal(snapshot.retryAfterSeconds, 42);
});

it("reports other failing statuses and malformed JSON as errors", async () => {
	const serverError = await provider(stubFetch(() => new Response("", { status: 503 })).fetch).fetch();
	assert.equal(serverError.status, "error");
	assert.equal(serverError.message, "HTTP 503");

	const malformed = await provider(
		stubFetch(() => new Response("not json{", { status: 200, headers: { "content-type": "application/json" } })).fetch,
	).fetch();
	assert.equal(malformed.status, "error");
	assert.equal(malformed.message, "Unexpected usage response");

	const nonObject = await provider(stubFetch(() => jsonResponse([1, 2, 3])).fetch).fetch();
	assert.equal(nonObject.status, "error");
	assert.equal(nonObject.message, "Unexpected usage response");

	const transport = await provider(
		stubFetch(() => {
			throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
		}).fetch,
	).fetch();
	assert.equal(transport.status, "error");
	assert.equal(transport.message, "getaddrinfo ENOTFOUND api.anthropic.com");
});

it("reports missing credentials without spending a network call", async () => {
	const { fetch, calls } = stubFetch(() => jsonResponse({}));
	const noCredentials = createClaudeCodeQuotaProvider({ readCredentials: async () => null, fetch });

	assert.equal(await noCredentials.detect(), false);
	const snapshot = await noCredentials.fetch();

	assert.equal(snapshot.status, "no_credentials");
	assert.equal(snapshot.message, "No Claude Code credentials found");
	assert.equal(calls.length, 0);
});

it("detects Claude Code's own credential file and ignores an unusable one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "clio-quota-"));
	const good = join(dir, "good.json");
	const bad = join(dir, "bad.json");
	await writeFile(good, JSON.stringify({ claudeAiOauth: { accessToken: "abc", subscriptionType: "max_20x" } }));
	await writeFile(bad, JSON.stringify({ claudeAiOauth: { accessToken: "" } }));

	assert.equal(await createClaudeCodeQuotaProvider({ credentialsPath: good }).detect(), true);
	assert.equal(await createClaudeCodeQuotaProvider({ credentialsPath: bad }).detect(), false);
	assert.equal(await createClaudeCodeQuotaProvider({ credentialsPath: join(dir, "missing.json") }).detect(), false);

	assert.equal(parseClaudeCredentials({ claudeAiOauth: { accessToken: "abc" } })?.subscriptionType, null);
	assert.equal(parseClaudeCredentials("nope"), null);
});

it("refuses a token the credential record already declares expired, without a request", async () => {
	const { fetch, calls } = stubFetch(() => jsonResponse({}));
	const refreshable = createClaudeCodeQuotaProvider({
		readCredentials: async () => ({ ...CREDENTIALS, expiresAtMs: NOW.getTime() - 1 }),
		fetch,
		now: () => NOW,
	});

	const snapshot = await refreshable.fetch();

	assert.equal(snapshot.status, "expired");
	assert.equal(snapshot.message, "Claude Code's stored token expired; run the claude command once to refresh it");
	assert.equal(calls.length, 0, "an expiry known from the record must not spend a network call");
});

it("asks for a fresh sign-in when the refresh token is gone or also expired", async () => {
	const variants: Array<Partial<ClaudeCodeCredentials>> = [
		{ hasRefreshToken: false },
		{ refreshTokenExpiresAtMs: NOW.getTime() - 1 },
	];
	for (const variant of variants) {
		const { fetch, calls } = stubFetch(() => jsonResponse({}));
		const stale = createClaudeCodeQuotaProvider({
			readCredentials: async () => ({ ...CREDENTIALS, expiresAtMs: NOW.getTime() - 1, ...variant }),
			fetch,
			now: () => NOW,
		});
		const snapshot = await stale.fetch();
		assert.equal(snapshot.status, "expired");
		assert.equal(snapshot.message, "Sign in with Claude Code again");
		assert.equal(calls.length, 0);
	}
});

it("still calls the endpoint when the record carries no expiry at all", async () => {
	const { fetch, calls } = stubFetch(() => jsonResponse({ five_hour: { utilization: 5 } }));
	const undated = createClaudeCodeQuotaProvider({
		readCredentials: async () => ({ ...CREDENTIALS, expiresAtMs: null }),
		fetch,
		now: () => NOW,
	});

	const snapshot = await undated.fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(calls.length, 1);
});

it("reads the expiry and refresh fields out of the stored record", () => {
	const parsed = parseClaudeCredentials({
		claudeAiOauth: {
			accessToken: "abc",
			refreshToken: "def",
			expiresAt: 1_789_959_744_156,
			refreshTokenExpiresAt: 1_792_551_744_156,
			subscriptionType: "max",
		},
	});

	assert.equal(parsed?.expiresAtMs, 1_789_959_744_156);
	assert.equal(parsed?.refreshTokenExpiresAtMs, 1_792_551_744_156);
	assert.equal(parsed?.hasRefreshToken, true);

	const bare = parseClaudeCredentials({ claudeAiOauth: { accessToken: "abc" } });
	assert.equal(bare?.expiresAtMs, null);
	assert.equal(bare?.refreshTokenExpiresAtMs, null);
	assert.equal(bare?.hasRefreshToken, false);
});

it("parses Retry-After and plan strings defensively", () => {
	assert.equal(parseRetryAfterSeconds("30"), 30);
	assert.equal(parseRetryAfterSeconds("-5"), 0);
	assert.equal(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT"), null);
	assert.equal(parseRetryAfterSeconds(null), null);
	assert.equal(formatPlan("max_5x"), "Max 5x");
	assert.equal(formatPlan(null), null);
});

function countingProvider(snapshots: UsageSnapshot[]): { provider: QuotaProvider; calls: () => number } {
	let index = 0;
	return {
		provider: {
			id: "claude-code",
			displayName: "Claude Code",
			detect: async () => true,
			fetch: async () => snapshots[Math.min(index++, snapshots.length - 1)] as UsageSnapshot,
		},
		calls: () => index,
	};
}

function okSnapshot(usedPct: number): UsageSnapshot {
	return {
		providerId: "claude-code",
		displayName: "Claude Code",
		status: "ok",
		windows: [{ key: "session", label: "5h", usedPct, resetsAt: null }],
		fetchedAt: "2026-01-01T00:00:00.000Z",
	};
}

it("serves a cached snapshot inside the TTL and refetches after it expires", async () => {
	let clock = 1_000;
	const cache = createQuotaCache({ ttlMs: 60_000, now: () => clock });
	const { provider: source, calls } = countingProvider([okSnapshot(10), okSnapshot(80)]);

	const first = await cache.resolve(source);
	assert.equal(first.windows[0]?.usedPct, 10);
	assert.equal(calls(), 1);

	clock += 59_000;
	const cached = await cache.resolve(source);
	assert.equal(cached.windows[0]?.usedPct, 10);
	assert.equal(calls(), 1, "a read inside the TTL must not spend a provider call");
	assert.equal(cache.read("claude-code")?.windows[0]?.usedPct, 10);

	clock += 2_000;
	assert.equal(cache.read("claude-code"), null);
	const refreshed = await cache.resolve(source);
	assert.equal(refreshed.windows[0]?.usedPct, 80);
	assert.equal(calls(), 2);
});

it("falls back to the last good snapshot when a refresh fails", async () => {
	let clock = 0;
	const cache = createQuotaCache({ ttlMs: 1_000, now: () => clock });
	const failure: UsageSnapshot = {
		providerId: "claude-code",
		displayName: "Claude Code",
		status: "error",
		windows: [],
		message: "HTTP 429",
		fetchedAt: "2026-01-01T00:05:00.000Z",
	};
	const { provider: source } = countingProvider([okSnapshot(20), failure]);

	await cache.resolve(source);
	clock += 2_000;
	const stale = await cache.resolve(source);

	assert.equal(stale.status, "ok");
	assert.equal(stale.stale, true);
	assert.equal(stale.message, "HTTP 429");
	assert.equal(stale.windows[0]?.usedPct, 20);
	assert.equal(cache.readLastGood("claude-code")?.stale, true);

	cache.clear();
	assert.equal(cache.readLastGood("claude-code"), null);
});

it("reports a failure directly when nothing good was ever cached", async () => {
	const cache = createQuotaCache({ ttlMs: DEFAULT_QUOTA_CACHE_TTL_MS, now: () => 0 });
	const { provider: source } = countingProvider([
		{
			providerId: "claude-code",
			displayName: "Claude Code",
			status: "no_credentials",
			windows: [],
			message: "No Claude Code credentials found",
			fetchedAt: null,
		},
	]);

	const snapshot = await cache.resolve(source);

	assert.equal(snapshot.status, "no_credentials");
	assert.equal(snapshot.stale, undefined);
	assert.equal(cache.read("claude-code"), null);
});

it("registers one adapter per supported runtime, in display order", () => {
	const providers = buildQuotaProviders();
	assert.deepEqual(
		providers.map((entry) => entry.id),
		["anthropic-max", "claude-code", "codex", "antigravity"],
	);
	assert.deepEqual(
		providers.map((entry) => entry.displayName),
		["Anthropic Max", "Claude Code", "Codex", "Antigravity"],
	);
});

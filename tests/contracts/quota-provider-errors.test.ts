import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeCodeQuotaProvider } from "../../src/domains/quota/claude-code-provider.js";
import { createCodexQuotaProvider } from "../../src/domains/quota/codex-provider.js";
import {
	COPILOT_QUOTA_PROVIDER_ID,
	createCopilotQuotaProvider,
	mapCopilotQuotaEntries,
} from "../../src/domains/quota/copilot-provider.js";
import { quotaReadingFromSnapshot } from "../../src/domains/quota/reading.js";
import { quotaProviderIdForRuntime } from "../../src/domains/quota/registry.js";
import type { QuotaProvider, UsageSnapshot } from "../../src/domains/quota/types.js";
import { parseCopilotQuotaResponse, readCopilotQuota } from "../../src/engine/copilot/quota.js";
import { jsonResponse, stubFetch } from "../harness/quota-fetch.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

type Provider = "claude-code" | "codex";

const PROVIDERS: Record<Provider, (fetch: typeof globalThis.fetch, signedIn: boolean) => QuotaProvider> = {
	"claude-code": (fetch, signedIn) =>
		createClaudeCodeQuotaProvider({
			readCredentials: async () =>
				signedIn
					? {
							accessToken: "sk-oauth-test",
							subscriptionType: "max_5x",
							expiresAtMs: NOW.getTime() + 3_600_000,
							refreshTokenExpiresAtMs: NOW.getTime() + 86_400_000,
							hasRefreshToken: true,
						}
					: null,
			fetch,
			now: () => NOW,
		}),
	codex: (fetch, signedIn) =>
		createCodexQuotaProvider({
			readCredentials: async () =>
				signedIn ? { accessToken: "sk-codex-test", accountId: "acct-123", expiresAtMs: null, hasRefreshToken: true } : null,
			fetch,
			now: () => NOW,
		}),
};

const FAULTS = {
	auth401: () => new Response("", { status: 401 }),
	auth403: () => new Response("", { status: 403 }),
	rateLimited: () => new Response("", { status: 429, headers: { "Retry-After": "42" } }),
	http503: () => new Response("", { status: 503 }),
	badJson: () => new Response("not json{", { status: 200, headers: { "content-type": "application/json" } }),
	nonObject: () => jsonResponse([1, 2, 3]),
	transport: (): Response => {
		throw new Error("getaddrinfo ENOTFOUND quota.test");
	},
	noCreds: () => jsonResponse({}),
} satisfies Record<string, () => Response>;

interface Row {
	name: string;
	provider: Provider;
	fault: keyof typeof FAULTS;
	expect: Partial<UsageSnapshot> & Pick<UsageSnapshot, "status" | "message">;
}

const CLAUDE_EXPIRED: Row["expect"] = { status: "expired", message: "Sign in with Claude Code again", windows: [] };
const CODEX_EXPIRED: Row["expect"] = {
	status: "expired",
	message: "Run clio-coder auth login openai-codex again",
	windows: [],
};
const UNEXPECTED = { status: "error", message: "Unexpected usage response" } as const;
const TRANSPORT = { status: "error", message: "getaddrinfo ENOTFOUND quota.test" } as const;
const statuses = "reports other failing statuses and malformed JSON as errors";

const rows: Row[] = [
	{ name: "maps 401 and 403 to an expired session", provider: "claude-code", fault: "auth401", expect: CLAUDE_EXPIRED },
	{ name: "maps 401 and 403 to an expired session", provider: "claude-code", fault: "auth403", expect: CLAUDE_EXPIRED },
	{ name: "maps 401 and 403 to an expired session", provider: "codex", fault: "auth401", expect: CODEX_EXPIRED },
	{ name: "maps 401 and 403 to an expired session", provider: "codex", fault: "auth403", expect: CODEX_EXPIRED },
	{
		name: "captures Retry-After when the usage endpoint rate limits the read",
		provider: "claude-code",
		fault: "rateLimited",
		expect: { status: "error", message: "HTTP 429", retryAfterSeconds: 42 },
	},
	{ name: statuses, provider: "claude-code", fault: "http503", expect: { status: "error", message: "HTTP 503" } },
	{ name: statuses, provider: "codex", fault: "http503", expect: { status: "error", message: "HTTP 503" } },
	{ name: statuses, provider: "claude-code", fault: "badJson", expect: UNEXPECTED },
	{ name: statuses, provider: "codex", fault: "badJson", expect: UNEXPECTED },
	{ name: statuses, provider: "claude-code", fault: "nonObject", expect: UNEXPECTED },
	{ name: statuses, provider: "codex", fault: "nonObject", expect: UNEXPECTED },
	{ name: statuses, provider: "claude-code", fault: "transport", expect: TRANSPORT },
	{ name: statuses, provider: "codex", fault: "transport", expect: TRANSPORT },
	{
		name: "reports missing credentials without spending a network call",
		provider: "claude-code",
		fault: "noCreds",
		expect: { status: "no_credentials", message: "No Claude Code credentials found" },
	},
	{
		name: "reports missing credentials without spending a network call",
		provider: "codex",
		fault: "noCreds",
		expect: { status: "no_credentials", message: "CLIO Coder holds no OpenAI Codex OAuth credential" },
	},
];

test("each quota provider reports an expired session, a failing read and missing credentials in its own words", async () => {
	for (const row of rows) {
		const label = `${row.provider} ${row.fault}: ${row.name}`;
		const { fetch, calls } = stubFetch(FAULTS[row.fault]);
		const signedIn = row.fault !== "noCreds";
		const provider = PROVIDERS[row.provider](fetch, signedIn);
		if (!signedIn) assert.equal(await provider.detect(), false, label);
		const snapshot = await provider.fetch();
		for (const [key, value] of Object.entries(row.expect))
			assert.deepEqual(snapshot[key as keyof UsageSnapshot], value, `${label}: ${key}`);
		assert.equal(calls.length, signedIn ? 1 : 0, `${label}: requests`);
	}
});

test("copilot quota adapter maps finite requests, nano_aiu credits, per-bucket unlimited, and advisory vs authoritative honestly", async () => {
	assert.equal(quotaProviderIdForRuntime("copilot-sdk"), COPILOT_QUOTA_PROVIDER_ID);

	// 1. Finite authoritative premium requests + local timezone offset normalized to UTC ISO.
	const finiteEntries = parseCopilotQuotaResponse({
		quotaSnapshots: {
			premium_interactions: {
				isUnlimitedEntitlement: false,
				entitlementRequests: 300,
				usedRequests: 120,
				remainingPercentage: 60,
				resetDate: "2026-11-22T06:34:34.688-08:00",
				usageAllowedWithExhaustedQuota: false,
				overage: 0,
				overageAllowedWithExhaustedQuota: false,
			},
			chat: {
				isUnlimitedEntitlement: true,
				entitlementRequests: 0,
				usedRequests: 0,
				remainingPercentage: 100,
				resetDate: "2026-11-22T06:34:34.688-08:00",
			},
		},
	});
	assert.ok(finiteEntries !== null);
	const provider = createCopilotQuotaProvider({
		readAccount: async () => ({ login: "octocat", host: "https://github.com" }),
		readQuota: async () => ({
			kind: "ok",
			account: { login: "octocat", host: "https://github.com" },
			entries: finiteEntries,
		}),
		now: () => NOW,
	});
	assert.equal(await provider.detect(), true);
	const scopeA = await provider.credentialScope?.();
	assert.ok(scopeA && !scopeA.includes("octocat"));
	const snapshot = await provider.fetch();
	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.plan, null);
	assert.deepEqual(snapshot.windows, [
		{
			key: "premium_interactions",
			label: "Premium",
			short: "prem",
			usedPct: 40,
			resetsAt: "2026-11-22T14:34:34.688Z",
		},
	]);
	assert.equal(snapshot.credits?.usedPct, 40);
	assert.match(snapshot.credits?.display ?? "", /120\/300 premium requests used, 180 remaining \(authoritative/);
	assert.match(snapshot.credits?.display ?? "", /Chat: unlimited \(authoritative/);
	const reading = quotaReadingFromSnapshot(snapshot, NOW.toISOString());
	assert.equal(reading.status, "ok");

	// 2. nano_aiu credits scale by 1e9 with no legacy multiplier; -1 sentinel marks only that bucket unlimited.
	const creditEntries = parseCopilotQuotaResponse({
		providerQuotas: [
			{
				quotaId: "premium_interactions",
				compatibilityKey: "premium_interactions",
				unit: "nano_aiu",
				quantityKind: "authoritative_budget",
				observationKind: "account_snapshot",
				capacityState: "available",
				accessState: "allowed",
				entitledQuantity: 500_000_000_000,
				availableQuantity: 375_000_000_000,
				budgetMetadata: {
					entitlement: 500_000_000_000,
					consumed: 125_000_000_000,
					unlimited: false,
					resetAtEpochMs: Date.parse("2026-12-01T00:00:00.000Z"),
				},
			},
			{
				quotaId: "completions",
				compatibilityKey: "completions",
				unit: "requests",
				quantityKind: "authoritative_budget",
				observationKind: "account_snapshot",
				capacityState: "available",
				accessState: "allowed",
				entitledQuantity: -1,
			},
		],
	});
	assert.ok(creditEntries !== null);
	const mappedCredits = mapCopilotQuotaEntries(creditEntries);
	assert.deepEqual(mappedCredits.windows, [
		{
			key: "premium_interactions",
			label: "Premium",
			short: "prem",
			usedPct: 25,
			resetsAt: "2026-12-01T00:00:00.000Z",
		},
	]);
	assert.match(mappedCredits.credits?.display ?? "", /125\/500 AI credits used, 375 remaining \(authoritative/);
	assert.match(mappedCredits.credits?.display ?? "", /Completions: unlimited \(authoritative\)/);

	// 3. Advisory balances, admission-state observations, and zero-denominator / percent-only snapshots never compute percent or claim unlimited.
	const nonAuthoritative = parseCopilotQuotaResponse({
		providerQuotas: [
			{
				quotaId: "advisory_credits",
				unit: "ai_credits",
				quantityKind: "advisory_balance",
				observationKind: "account_snapshot",
				capacityState: "available",
				accessState: "allowed",
				entitledQuantity: 100,
				availableQuantity: 40,
				budgetMetadata: { entitlement: 100, consumed: 60, remainingPercentage: 40 },
			},
			{
				quotaId: "admission_only",
				unit: "requests",
				quantityKind: "none",
				observationKind: "admission_state",
				capacityState: "exhausted",
				accessState: "denied",
			},
		],
		quotaSnapshots: {
			pct_only: {
				isUnlimitedEntitlement: false,
				entitlementRequests: 0,
				usedRequests: 0,
				remainingPercentage: 40,
			},
		},
	});
	assert.ok(nonAuthoritative !== null);
	const mappedNonAuth = mapCopilotQuotaEntries(nonAuthoritative);
	assert.deepEqual(mappedNonAuth.windows, []);
	assert.equal(mappedNonAuth.credits?.usedPct, null);
	assert.match(mappedNonAuth.credits?.display ?? "", /60\/100 AI credits used, 40 remaining \(advisory\)/);
	assert.match(mappedNonAuth.credits?.display ?? "", /Admission Only: exhausted \(admission state\)/);
	assert.doesNotMatch(mappedNonAuth.credits?.display ?? "", /Pct Only: unlimited/);
});

test("copilot quota RPC probe capability-detects absence, bounds timeout, and never retries errors in a loop", async () => {
	// Absent getQuota capability -> unsupported -> provider reports error/unknown without guessing.
	const absent = await readCopilotQuota({
		client: async () => ({
			getAuthStatus: async () => ({ isAuthenticated: true, login: "octocat" }),
			rpc: { account: {} },
		}),
	});
	assert.equal(absent.kind, "unsupported");
	const absentSnap = await createCopilotQuotaProvider({
		readAccount: async () => ({ login: "octocat", host: "https://github.com" }),
		readQuota: async () => absent,
		now: () => NOW,
	}).fetch();
	assert.equal(absentSnap.status, "error");
	assert.equal(absentSnap.plan, null);
	assert.deepEqual(absentSnap.windows, []);
	assert.equal(absentSnap.credits, null);
	assert.match(absentSnap.message ?? "", /quota unknown/i);

	// Method-not-found JSON-RPC error -> unsupported, called exactly once.
	let methodCalls = 0;
	const methodNotFound = await readCopilotQuota({
		client: async () => ({
			getAuthStatus: async () => ({ isAuthenticated: true, login: "octocat" }),
			rpc: {
				account: {
					getQuota: async () => {
						methodCalls += 1;
						throw Object.assign(new Error("Method not found"), { code: -32601 });
					},
				},
			},
		}),
	});
	assert.equal(methodNotFound.kind, "unsupported");
	assert.equal(methodCalls, 1);

	// Runtime error -> error, called once (never retried in a loop).
	let errorCalls = 0;
	const failed = await readCopilotQuota({
		client: async () => ({
			getAuthStatus: async () => ({ isAuthenticated: true, login: "octocat" }),
			rpc: {
				account: {
					getQuota: async () => {
						errorCalls += 1;
						throw new Error("upstream 502");
					},
				},
			},
		}),
	});
	assert.equal(failed.kind, "error");
	assert.equal(errorCalls, 1);

	// Bounded timeout -> error, called once (never retried).
	let hungCalls = 0;
	const timedOut = await readCopilotQuota({
		timeoutMs: 25,
		client: async () => ({
			getAuthStatus: async () => ({ isAuthenticated: true, login: "octocat" }),
			rpc: {
				account: {
					getQuota: async () => {
						hungCalls += 1;
						await new Promise(() => {});
					},
				},
			},
		}),
	});
	assert.equal(timedOut.kind, "error");
	assert.match(timedOut.message, /timed out/i);
	assert.equal(hungCalls, 1);

	// Signed out -> no_credentials without invoking getQuota.
	let authCalls = 0;
	const signedOut = await readCopilotQuota({
		client: async () => ({
			getAuthStatus: async () => ({ isAuthenticated: false, statusMessage: "Not logged in" }),
			rpc: {
				account: {
					getQuota: async () => {
						authCalls += 1;
						return {};
					},
				},
			},
		}),
	});
	assert.equal(signedOut.kind, "no_credentials");
	assert.equal(authCalls, 0);
});

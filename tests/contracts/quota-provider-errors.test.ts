import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeCodeQuotaProvider } from "../../src/domains/quota/claude-code-provider.js";
import { createCodexQuotaProvider } from "../../src/domains/quota/codex-provider.js";
import type { QuotaProvider, UsageSnapshot } from "../../src/domains/quota/types.js";
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
			timeoutMs: 100,
		}),
};

const FAULTS = {
	auth401: () => new Response("", { status: 401 }),
	auth403: () => new Response("", { status: 403 }),
	rateLimited: () => new Response("", { status: 429, headers: { "Retry-After": "42" } }),
	http503: () => new Response("", { status: 503 }),
	stalledBody: () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
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
	{
		name: "times out a body that stalls after the headers",
		provider: "codex",
		fault: "stalledBody",
		expect: { status: "error", message: "timeout after 100ms" },
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

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import type { CodexCredentials } from "../../src/domains/quota/codex-provider.js";
import { CODEX_USAGE_URL, createCodexQuotaProvider } from "../../src/domains/quota/codex-provider.js";
import type { QuotaProvider } from "../../src/domains/quota/types.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const CREDENTIALS: CodexCredentials = {
	accessToken: "sk-codex-test",
	accountId: "acct-123",
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

function provider(fetch: typeof globalThis.fetch, credentials: CodexCredentials | null = CREDENTIALS): QuotaProvider {
	return createCodexQuotaProvider({
		readCredentials: async () => credentials,
		fetch,
		now: () => NOW,
	});
}

it("reads both rate limit windows, using limit_window_seconds to pick their keys", async () => {
	const { fetch, calls } = stubFetch(() =>
		jsonResponse({
			plan_type: "plus",
			rate_limit: {
				primary_window: { used_percent: 91, reset_at: 1_767_225_600, limit_window_seconds: 604_800 },
				secondary_window: { used_percent: 12, reset_at: 1_767_000_000, limit_window_seconds: 300 },
			},
		}),
	);

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.providerId, "codex");
	assert.equal(snapshot.plan, "Plus");
	assert.deepEqual(
		snapshot.windows.map((window) => [window.key, window.label, window.short, window.usedPct]),
		[
			["session", "5h", "5h", 12],
			["weekly", "Weekly", "wk", 91],
		],
	);
	assert.equal(snapshot.windows[0]?.resetsAt, new Date(1_767_000_000 * 1000).toISOString());
	assert.equal(snapshot.windows[1]?.resetsAt, new Date(1_767_225_600 * 1000).toISOString());

	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, CODEX_USAGE_URL);
	assert.equal(calls[0]?.headers.authorization, `Bearer ${CREDENTIALS.accessToken}`);
	assert.equal(calls[0]?.headers["user-agent"], "codex-cli");
});

it("defaults primary to session and secondary to weekly when limit_window_seconds is absent", async () => {
	const { fetch } = stubFetch(() =>
		jsonResponse({
			rate_limit: {
				primary_window: { used_percent: 40 },
				secondary_window: { used_percent: 60 },
			},
		}),
	);

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.deepEqual(snapshot.windows, [
		{ key: "session", label: "5h", short: "5h", usedPct: 40, resetsAt: null },
		{ key: "weekly", label: "Weekly", short: "wk", usedPct: 60, resetsAt: null },
	]);
});

it("reports an empty window list, still ok, when rate_limit is absent", async () => {
	const { fetch } = stubFetch(() => jsonResponse({ plan_type: "free" }));

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.deepEqual(snapshot.windows, []);
	assert.equal(snapshot.plan, "Free");
});

it("reports unlimited credits without a used percentage", async () => {
	const { fetch } = stubFetch(() => jsonResponse({ credits: { unlimited: true, has_credits: true, balance: "0" } }));

	const snapshot = await provider(fetch).fetch();

	assert.deepEqual(snapshot.credits, { display: "Unlimited", usedPct: null });
});

it("reports the raw balance string when credits carry a balance", async () => {
	const { fetch } = stubFetch(() => jsonResponse({ credits: { has_credits: true, balance: "$4.20" } }));

	const snapshot = await provider(fetch).fetch();

	assert.deepEqual(snapshot.credits, { display: "$4.20", usedPct: null });
});

it("maps 401 and 403 to an expired session", async () => {
	for (const status of [401, 403]) {
		const { fetch } = stubFetch(() => new Response("", { status }));
		const snapshot = await provider(fetch).fetch();
		assert.equal(snapshot.status, "expired");
		assert.equal(snapshot.message, "Sign in with Codex again");
		assert.deepEqual(snapshot.windows, []);
	}
});

it("reports other failing statuses and malformed JSON as errors", async () => {
	const serverError = await provider(stubFetch(() => new Response("", { status: 500 })).fetch).fetch();
	assert.equal(serverError.status, "error");
	assert.equal(serverError.message, "HTTP 500");

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
			throw new Error("getaddrinfo ENOTFOUND chatgpt.com");
		}).fetch,
	).fetch();
	assert.equal(transport.status, "error");
	assert.equal(transport.message, "getaddrinfo ENOTFOUND chatgpt.com");
});

it("reports missing credentials without spending a network call", async () => {
	const { fetch, calls } = stubFetch(() => jsonResponse({}));
	const noCredentials = provider(fetch, null);

	assert.equal(await noCredentials.detect(), false);
	const snapshot = await noCredentials.fetch();

	assert.equal(snapshot.status, "no_credentials");
	assert.equal(snapshot.message, "No Codex credentials found");
	assert.equal(calls.length, 0);
});

it("sends ChatGPT-Account-Id only when the credential record carries an account id", async () => {
	const withAccount = stubFetch(() => jsonResponse({}));
	await provider(withAccount.fetch, CREDENTIALS).fetch();
	assert.equal(withAccount.calls[0]?.headers["chatgpt-account-id"], CREDENTIALS.accountId);

	const withoutAccount = stubFetch(() => jsonResponse({}));
	await provider(withoutAccount.fetch, { accessToken: "sk-codex-test", accountId: null }).fetch();
	assert.equal("chatgpt-account-id" in (withoutAccount.calls[0]?.headers ?? {}), false);
});

it("detects Codex's own credential file and ignores an unusable one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "clio-quota-codex-"));
	const good = join(dir, "good.json");
	const bad = join(dir, "bad.json");
	await writeFile(
		good,
		JSON.stringify({
			auth_mode: "chatgpt",
			OPENAI_API_KEY: null,
			tokens: { id_token: "id", access_token: "abc", refresh_token: "ref", account_id: "acct-1" },
			last_refresh: "2026-01-01T00:00:00Z",
		}),
	);
	await writeFile(bad, JSON.stringify({ tokens: { access_token: "" } }));

	assert.equal(await createCodexQuotaProvider({ credentialsPath: good }).detect(), true);
	assert.equal(await createCodexQuotaProvider({ credentialsPath: bad }).detect(), false);
	assert.equal(await createCodexQuotaProvider({ credentialsPath: join(dir, "missing.json") }).detect(), false);
});

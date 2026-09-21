import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import type { AntigravityCredentials } from "../../src/domains/quota/antigravity-provider.js";
import { createAntigravityQuotaProvider } from "../../src/domains/quota/antigravity-provider.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const CREDENTIALS: AntigravityCredentials = {
	accessToken: "ya29-test",
	refreshToken: "refresh-test",
	expiryMs: NOW.getTime() + 3_600_000,
};

const PRIMARY = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

type Route = (url: string, body: unknown) => Response;

function stubFetch(route: Route): { fetch: typeof globalThis.fetch; urls: string[] } {
	const urls: string[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		urls.push(url);
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		return route(url, body);
	}) as typeof globalThis.fetch;
	return { fetch, urls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function provider(fetch: typeof globalThis.fetch, credentials: AntigravityCredentials = CREDENTIALS) {
	return createAntigravityQuotaProvider({
		readCredentials: async () => credentials,
		fetch,
		now: () => NOW,
	});
}

const LOAD_OK = { cloudaicompanionProject: "projects/demo", currentTier: { name: "pro_tier" } };

function summaryBody(groups: unknown[]): unknown {
	return { groups };
}

const GEMINI_GROUP = {
	displayName: "Gemini models",
	buckets: [
		{ window: "weekly", bucketId: "gemini-weekly", remainingFraction: 0.25, resetTime: "2026-01-07T00:00:00Z" },
		{ window: "5h", bucketId: "gemini-5h", remainingFraction: 0.9, resetTime: "2026-01-01T05:00:00Z" },
		{ window: "monthly", bucketId: "gemini-monthly", remainingFraction: 0.5 },
	],
};

const OTHER_GROUP = {
	displayName: "Other models",
	buckets: [{ window: "5h", bucketId: "other-5h", remainingFraction: 0.1 }],
};

it("retains every quota group, with Gemini first and session before weekly", async () => {
	const { fetch, urls } = stubFetch((url) => {
		if (url.endsWith("loadCodeAssist")) return jsonResponse(LOAD_OK);
		if (url.endsWith("retrieveUserQuotaSummary")) return jsonResponse(summaryBody([OTHER_GROUP, GEMINI_GROUP]));
		return jsonResponse({});
	});

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.providerId, "antigravity");
	assert.equal(snapshot.plan, "Pro Tier");
	assert.deepEqual(
		snapshot.windows.map((window) => [window.key, window.label, Math.round(window.usedPct)]),
		[
			["session", "5h", 10],
			["weekly", "Weekly", 75],
			["group.1.session", "5h", 90],
		],
	);
	assert.deepEqual(
		snapshot.windows.map((window) => window.scope),
		["Gemini models", "Gemini models", "Other models"],
	);
	assert.equal(snapshot.windows[0]?.resetsAt, "2026-01-01T05:00:00.000Z");
	assert.equal(urls.length, 2, "a usable summary must not trigger the models fallback");
});

it("sends the project and the Antigravity user agent on every call", async () => {
	let seenHeaders: Record<string, string> = {};
	let summaryBodySeen: unknown;
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("retrieveUserQuotaSummary")) {
			seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
			summaryBodySeen = JSON.parse(String(init?.body));
			return jsonResponse(summaryBody([GEMINI_GROUP]));
		}
		return jsonResponse(LOAD_OK);
	}) as typeof globalThis.fetch;

	await provider(fetch).fetch();

	assert.equal(seenHeaders.authorization, `Bearer ${CREDENTIALS.accessToken}`);
	assert.equal(seenHeaders["user-agent"], "antigravity");
	assert.equal(seenHeaders["content-type"], "application/json");
	assert.deepEqual(summaryBodySeen, { project: "projects/demo" });
});

it("retains model fallback quotas without inventing a five-hour window", async () => {
	const { fetch } = stubFetch((url) => {
		if (url.endsWith("loadCodeAssist")) return jsonResponse(LOAD_OK);
		if (url.endsWith("retrieveUserQuotaSummary")) return jsonResponse(summaryBody([]));
		return jsonResponse({
			models: {
				"gemini-3-pro": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-01-01T06:00:00Z" } },
				"gemini-3-flash": { quotaInfo: { remainingFraction: 0.3 } },
				"internal-tool": { quotaInfo: { remainingFraction: 0.01 } },
				"claude-sonnet": {},
			},
		});
	});

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.windows.length, 2);
	assert.equal(snapshot.windows[0]?.key, "model.gemini-3-pro");
	assert.equal(snapshot.windows[1]?.scope, "gemini-3-flash");
	assert.equal(Math.round(snapshot.windows[1]?.usedPct ?? 0), 70);
	assert.ok(snapshot.windows.every((window) => window.label === "Model quota"));
});

it("moves to the next endpoint when the first one fails", async () => {
	const { fetch, urls } = stubFetch((url) => {
		if (url.startsWith(PRIMARY)) return jsonResponse({ error: "nope" }, 500);
		if (url.startsWith(SANDBOX) && url.endsWith("loadCodeAssist")) return jsonResponse(LOAD_OK);
		if (url.startsWith(SANDBOX)) return jsonResponse(summaryBody([GEMINI_GROUP]));
		return jsonResponse({});
	});

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.windows.length, 2);
	assert.ok(urls[0]?.startsWith(PRIMARY));
	assert.ok(urls[1]?.startsWith(SANDBOX));
});

it("maps an auth failure on every endpoint to expired", async () => {
	const { fetch } = stubFetch(() => new Response("", { status: 401 }));

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "expired");
	assert.equal(snapshot.message, "Sign in with Antigravity again");
});

it("refuses an expired stored token without any network call", async () => {
	const { fetch, urls } = stubFetch(() => jsonResponse(LOAD_OK));
	const stale = provider(fetch, { ...CREDENTIALS, expiryMs: NOW.getTime() + 30_000 });

	const snapshot = await stale.fetch();

	assert.equal(snapshot.status, "expired");
	assert.equal(snapshot.message, "Antigravity's stored token expired; run the agy command once to refresh it");
	assert.equal(urls.length, 0, "the 60 second skew window must catch a token about to expire");
});

it("reports missing credentials without spending a network call", async () => {
	const { fetch, urls } = stubFetch(() => jsonResponse(LOAD_OK));
	const absent = createAntigravityQuotaProvider({ readCredentials: async () => null, fetch, now: () => NOW });

	const snapshot = await absent.fetch();

	assert.equal(snapshot.status, "no_credentials");
	assert.equal(snapshot.message, "No Antigravity credentials found");
	assert.equal(await absent.detect(), false);
	assert.equal(urls.length, 0);
});

it("reports an empty quota surface and a transport failure distinctly", async () => {
	const { fetch } = stubFetch((url) => {
		if (url.endsWith("loadCodeAssist")) return jsonResponse(LOAD_OK);
		if (url.endsWith("retrieveUserQuotaSummary")) return jsonResponse(summaryBody([]));
		return jsonResponse({ models: {} });
	});
	const empty = await provider(fetch).fetch();
	assert.equal(empty.status, "error");
	assert.equal(empty.message, "Antigravity returned no quota");

	const broken = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof globalThis.fetch;
	const failed = await provider(broken).fetch();
	assert.equal(failed.status, "error");
	assert.equal(failed.message, "ECONNREFUSED");
});

it("drops a plan label that merely repeats the product name", async () => {
	const { fetch } = stubFetch((url) => {
		if (url.endsWith("loadCodeAssist")) {
			return jsonResponse({ cloudaicompanionProject: "projects/demo", currentTier: { name: "antigravity" } });
		}
		if (url.endsWith("retrieveUserQuotaSummary")) return jsonResponse(summaryBody([GEMINI_GROUP]));
		return jsonResponse({});
	});

	const snapshot = await provider(fetch).fetch();

	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.plan, null);
});

it("reads the stored token file and rejects an unusable one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "clio-antigravity-"));
	const good = join(dir, "good.json");
	const bad = join(dir, "bad.json");
	await writeFile(
		good,
		JSON.stringify({
			token: { access_token: "abc", token_type: "Bearer", refresh_token: "def", expiry: "2026-01-01T00:00:00Z" },
			auth_method: "oauth",
		}),
	);
	await writeFile(bad, JSON.stringify({ token: { access_token: "" } }));

	assert.equal(await createAntigravityQuotaProvider({ credentialsPath: good }).detect(), true);
	assert.equal(await createAntigravityQuotaProvider({ credentialsPath: bad }).detect(), false);
	assert.equal(await createAntigravityQuotaProvider({ credentialsPath: join(dir, "missing.json") }).detect(), false);
});

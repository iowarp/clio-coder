import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { decideBackgroundStep } from "../../src/domains/memory/background-budget.js";
import { getCatalogModelForRuntime } from "../../src/domains/providers/catalog.js";
import { createCodexCliQuotaProvider } from "../../src/domains/quota/codex-cli-provider.js";
import type { CodexCredentials } from "../../src/domains/quota/codex-provider.js";
import { createCodexQuotaProvider } from "../../src/domains/quota/codex-provider.js";
import { CODEX_USAGE_URL } from "../../src/domains/quota/codex-usage.js";
import {
	codexStreamSnapshots,
	noteCodexStreamQuota,
	observedCodexQuota,
	observedQuota,
	quotaReadingFingerprint,
	quotaReadingFromMessage,
} from "../../src/domains/quota/index.js";
import type { QuotaProvider } from "../../src/domains/quota/types.js";
import { quotaAccount } from "../../src/domains/telemetry/read-model.js";
import { codexAccountScope, parseCodexQuotaEvent } from "../../src/engine/apis/codex-quota.js";
import { observeResponsesModelId } from "../../src/engine/apis/responses-model-id.js";
import type { CodexQuotaObservation } from "../../src/engine/types.js";
import { createTurnPersistence } from "../../src/session-control/turn-persistence.js";
import { createTurnState } from "../../src/session-control/turn-state.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const CREDENTIALS: CodexCredentials = {
	accessToken: "sk-codex-test",
	accountId: "acct-123",
	expiresAtMs: null,
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
	assert.match(calls[0]?.headers["user-agent"] ?? "", /^clio-coder\//);
	assert.equal(calls[0]?.headers.originator, "clio-coder");
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
		assert.equal(snapshot.message, "Run clio-coder auth login openai-codex again");
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
	assert.equal(snapshot.message, "Clio holds no OpenAI Codex OAuth credential");
	assert.equal(calls.length, 0);
});

it("sends ChatGPT-Account-Id only when the credential record carries an account id", async () => {
	const withAccount = stubFetch(() => jsonResponse({}));
	await provider(withAccount.fetch, CREDENTIALS).fetch();
	assert.equal(withAccount.calls[0]?.headers["chatgpt-account-id"], CREDENTIALS.accountId);

	const withoutAccount = stubFetch(() => jsonResponse({}));
	await provider(withoutAccount.fetch, { ...CREDENTIALS, accountId: null }).fetch();
	assert.equal("chatgpt-account-id" in (withoutAccount.calls[0]?.headers ?? {}), false);
});

it("detects the Codex CLI's own credential file and ignores an unusable one", async () => {
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

	assert.equal(await createCodexCliQuotaProvider({ credentialsPath: good }).detect(), true);
	assert.equal(await createCodexCliQuotaProvider({ credentialsPath: bad }).detect(), false);
	assert.equal(await createCodexCliQuotaProvider({ credentialsPath: join(dir, "missing.json") }).detect(), false);
});

it("captures stream quota without a request and keeps target/account evidence distinct", async () => {
	const token = (account: string) =>
		`e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
	const account = codexAccountScope(token("account-a"));
	assert.ok(account);
	assert.equal(codexAccountScope("not-a-token"), null);
	const event = {
		type: "codex.rate_limits",
		plan_type: "plus",
		rate_limits: {
			allowed: false,
			limit_reached: true,
			primary: { used_percent: 100, window_minutes: 300, resets_at: NOW.getTime() / 1000 + 3600 },
			secondary: { used_percent: 16, window_minutes: 10_080, reset_after_seconds: 7200 },
		},
		credits: { has_credits: true, unlimited: false },
	};
	const parsed = parseCodexQuotaEvent(event, account, NOW.getTime());
	assert.ok(parsed);
	assert.deepEqual(
		parsed.windows.map((w) => [w.windowMinutes, w.usedPercent]),
		[
			[300, 100],
			[10_080, 16],
		],
	);
	assert.equal(parsed.windows[1]?.resetsAt, new Date(NOW.getTime() + 7200000).toISOString());
	assert.equal(parsed.credits?.balance, null);
	for (const malformed of [
		null,
		{},
		{ type: "codex.rate_limits", rate_limits: { primary: { used_percent: "10", window_minutes: 300 } } },
	])
		assert.equal(parseCodexQuotaEvent(malformed, account), null);
	const weekly = parseCodexQuotaEvent(
		{ ...event, credits: undefined, rate_limits: { primary: event.rate_limits.secondary } },
		account,
		NOW.getTime(),
	);
	assert.ok(weekly);
	assert.equal(weekly.windows.length, 1);
	assert.equal(weekly.windows[0]?.windowMinutes, 10_080);
	assert.equal(weekly.credits, null);
	const model = getCatalogModelForRuntime("openai-codex", "gpt-6-luna");
	assert.ok(model);
	type Stream = ReturnType<typeof observeResponsesModelId>;
	type Options = Parameters<typeof observeResponsesModelId>[1];
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "completed with credit fallback" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: NOW.getTime(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	let invocations = 0;
	const stream = observeResponsesModelId(model, { apiKey: token("account-a") } as Options, (options) => {
		invocations++;
		return {
			async *[Symbol.asyncIterator]() {
				await options?.onProviderStreamEvent?.(event, model);
				yield { type: "done", reason: "stop", message };
			},
			result: () => Promise.resolve(message),
		} as unknown as Stream;
	});
	const result = await stream.result();
	assert.equal(result.stopReason, "stop", "included-window flags must not stop a foreground completion");
	assert.equal(invocations, 1);
	const quota = (result as typeof result & { codexQuota?: CodexQuotaObservation }).codexQuota;
	assert.ok(quota);
	assert.doesNotMatch(JSON.stringify(quota), /account-a|signature/);
	const state = createTurnState("off");
	state.runtime = { targetId: "stream-test", runtimeId: "openai-codex" } as never;
	const persisted: unknown[] = [];
	const persistence = createTurnPersistence({
		session: {
			append: (input: { payload: unknown }) => {
				persisted.push(input.payload);
				return { id: "quota-turn" };
			},
		} as never,
		state,
		getSettings: () => DEFAULT_SETTINGS,
		middlewareToolChoice: {} as never,
		consumePersistedEcho: () => false,
		removeQueuedMirrorEntry: () => undefined,
		promptCachePayloadForAssistant: () => ({}),
	});
	persistence.appendAssistantTurn(result);
	const observed = observedCodexQuota("stream-test", account, Date.parse(quota.observedAt));
	assert.equal(observed?.snapshot?.windows[0]?.usedPct, 100);
	assert.equal(observed?.stale, false);
	assert.deepEqual((persisted[0] as { codexQuota: unknown }).codexQuota, quota);
	assert.equal(observedCodexQuota("other-target", account, Date.parse(quota.observedAt)), null);
	assert.equal(
		observedCodexQuota("stream-test", codexAccountScope(token("account-b")), Date.parse(quota.observedAt)),
		null,
	);
	assert.equal(observedCodexQuota("stream-test", account, Date.parse(quota.observedAt) + 300000)?.stale, true);
	noteCodexStreamQuota("weekly-test", weekly);
	assert.equal(observedCodexQuota("weekly-test", account, NOW.getTime())?.snapshot?.windows[0]?.key, "weekly");
	const background = (reading: ReturnType<typeof observedCodexQuota>) =>
		decideBackgroundStep({
			route: { pricedBy: "catalog", rates: null, runtime: { auth: "oauth", tier: "cloud" }, quotaProviderId: "codex" },
			inputTokens: 100,
			maxOutputTokens: 10,
			timeoutCapMs: 1000,
			nowMs: NOW.getTime(),
			session: { spendUsd: 0, ceilingUsd: 5 },
			quota: reading,
			endpoint: { occupied: 0, admissionLimit: 1, prefillTokensPerSecond: null, generationTokensPerSecond: null },
		});
	assert.equal(
		background(observedCodexQuota("weekly-test", account, NOW.getTime())).admit,
		true,
		"a low fresh stream window must enable optional memory on the native Codex route",
	);
	assert.deepEqual(background(null), { admit: false, kind: "quota", reason: "quota_unknown" });
	assert.equal(observedQuota("codex", NOW.getTime()), null, "a Clio stream must not overwrite a sibling CLI reading");
	assert.ok(codexStreamSnapshots(NOW.getTime()).some((s) => s.providerId === "codex:weekly-test"));
});

it("journals a codex.rate_limits event as one quota reading whose identity ignores reset drift (#434)", () => {
	const event = {
		type: "codex.rate_limits",
		rate_limits: {
			limit_reached: true,
			primary: { used_percent: 100, window_minutes: 300, reset_after_seconds: 3600 },
			secondary: { used_percent: 16, window_minutes: 10_080, reset_after_seconds: 7200 },
		},
	};
	const first = parseCodexQuotaEvent(event, "account", NOW.getTime());
	const later = parseCodexQuotaEvent(event, "account", NOW.getTime() + 5_000);
	assert.ok(first && later);
	const reading = quotaReadingFromMessage({ codexQuota: first }, "openai-codex", "codex-target");
	assert.ok(reading && validPayload("quota.read", reading));
	assert.equal(reading.source, "stream-event");
	assert.equal(reading.limitReached, true);
	assert.deepEqual(
		reading.windows.map((window) => [window.key, window.usedPct]),
		[
			["session", { kind: "measured", value: 100, source: "provider" }],
			["weekly", { kind: "measured", value: 16, source: "provider" }],
		],
	);
	const drifted = quotaReadingFromMessage({ codexQuota: later }, "openai-codex", "codex-target");
	assert.ok(drifted);
	assert.equal(quotaReadingFingerprint(drifted), quotaReadingFingerprint(reading));
	assert.equal(quotaAccount(reading), "codex:codex-target");
	const polled = { ...reading, source: "poll" as const, targetId: "codex" };
	assert.equal(quotaAccount(polled), "codex");
	assert.notEqual(
		quotaReadingFingerprint(polled),
		quotaReadingFingerprint({ ...polled, observedAt: "2026-01-01T00:10:00.000Z" }),
	);
	assert.equal(quotaReadingFromMessage({ codexQuota: first }, "openai", "codex-target"), null);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { decideBackgroundStep } from "../../src/domains/memory/background-budget.js";
import { getCatalogModelForRuntime } from "../../src/domains/providers/catalog.js";
import { createCodexCliQuotaProvider } from "../../src/domains/quota/codex-cli-provider.js";
import type { CodexCredentials } from "../../src/domains/quota/codex-provider.js";
import { createCodexQuotaProvider } from "../../src/domains/quota/codex-provider.js";
import { CODEX_USAGE_URL } from "../../src/domains/quota/codex-usage.js";
import { createCopilotQuotaProvider } from "../../src/domains/quota/copilot-provider.js";
import {
	codexStreamSnapshots,
	noteCodexStreamQuota,
	observedCodexQuota,
	observedQuota,
	type QuotaReading,
	quotaDenial,
	quotaReadingFingerprint,
	quotaReadingFromMessage,
} from "../../src/domains/quota/index.js";
import { footerQuotaSegment } from "../../src/domains/quota/presentation.js";
import { quotaReadingFromSnapshot } from "../../src/domains/quota/reading.js";
import type { QuotaProvider } from "../../src/domains/quota/types.js";
import { foldAccountQuota, quotaAccount } from "../../src/domains/telemetry/read-model.js";
import { codexAccountScope, parseCodexQuotaEvent } from "../../src/engine/apis/codex-quota.js";
import { observeResponsesModelId } from "../../src/engine/apis/responses-model-id.js";
import { readCopilotQuota } from "../../src/engine/copilot/quota.js";
import type { CodexQuotaObservation } from "../../src/engine/types.js";
import { createTurnPersistence } from "../../src/session-control/turn-persistence.js";
import { createTurnState } from "../../src/session-control/turn-state.js";
import { jsonResponse, stubFetch } from "../harness/quota-fetch.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const CREDENTIALS: CodexCredentials = {
	accessToken: "sk-codex-test",
	accountId: "acct-123",
	expiresAtMs: null,
	hasRefreshToken: true,
};

function provider(fetch: typeof globalThis.fetch, credentials: CodexCredentials | null = CREDENTIALS): QuotaProvider {
	return createCodexQuotaProvider({
		readCredentials: async () => credentials,
		fetch,
		now: () => NOW,
	});
}

it("reads both rate limit windows, keyed and labeled by limit_window_seconds", async () => {
	const { fetch, calls } = stubFetch(() =>
		jsonResponse({
			plan_type: "plus",
			rate_limit: {
				primary_window: { used_percent: 91, reset_at: 1_767_225_600, limit_window_seconds: 604_800 },
				secondary_window: { used_percent: 12, reset_at: 1_767_000_000, limit_window_seconds: 10_800 },
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
			["session", "3h", "3h", 12],
			["weekly", "Weekly", "wk", 91],
		],
	);
	assert.equal(snapshot.windows[0]?.resetsAt, new Date(1_767_000_000 * 1000).toISOString());
	assert.equal(snapshot.windows[1]?.resetsAt, new Date(1_767_225_600 * 1000).toISOString());
	assert.equal(footerQuotaSegment([snapshot]), "OpenAI 3h 12% used/wk 91% used");

	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, CODEX_USAGE_URL);
	assert.equal(calls[0]?.headers.authorization, `Bearer ${CREDENTIALS.accessToken}`);
	assert.match(calls[0]?.headers["user-agent"] ?? "", /^clio-coder\//);
	assert.equal(calls[0]?.headers.originator, "clio-coder");
});

it("keys primary as session and secondary as weekly, naming the slot, when limit_window_seconds is absent", async () => {
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
		{ key: "session", label: "Primary", short: "pri", usedPct: 40, resetsAt: null, unit: "percent" },
		{ key: "weekly", label: "Secondary", short: "sec", usedPct: 60, resetsAt: null, unit: "percent" },
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

	assert.deepEqual(snapshot.credits, { display: "Unlimited", usedPct: null, unit: "provider-credits" });
});

it("reports the raw balance string when credits carry a balance", async () => {
	const { fetch } = stubFetch(() => jsonResponse({ credits: { has_credits: true, balance: "$4.20" } }));

	const snapshot = await provider(fetch).fetch();

	assert.deepEqual(snapshot.credits, { display: "$4.20", usedPct: null, unit: "provider-credits" });
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

it("never folds one account's quota window against another account's reading on the same target (T7)", () => {
	const at = (seconds: number, used: number) =>
		parseCodexQuotaEvent(
			{
				type: "codex.rate_limits",
				rate_limits: { primary: { used_percent: used, window_minutes: 300, reset_after_seconds: 3600 - seconds } },
			},
			"unused",
			NOW.getTime() + seconds * 1000,
		);
	const read = (scope: string, seconds: number, used: number) => {
		const observation = at(seconds, used);
		assert.ok(observation);
		const reading = quotaReadingFromMessage(
			{ codexQuota: { ...observation, accountScope: scope } },
			"openai-codex",
			"codex-target",
		);
		assert.ok(reading && validPayload("quota.read", reading));
		return reading;
	};
	const a1 = read("a".repeat(64), 0, 10);
	const b = read("b".repeat(64), 10, 60);
	const a2 = read("a".repeat(64), 20, 15);
	assert.ok(a1.account && b.account && a1.account !== b.account);
	assert.equal(a1.account, a2.account);
	assert.ok(!JSON.stringify(a1).includes("a".repeat(16)), "the journaled account is not the runtime's scope");
	const fold = (...readings: QuotaReading[]) =>
		foldAccountQuota(readings.map((data) => ({ k: "quota.read", data }) as unknown as TelemetryRecord)).get(
			"codex:codex-target",
		);
	assert.equal(fold(a1, b)?.consumed.size, 0, "a second account's reading is not the first account's consumption");
	assert.deepEqual(fold(a1, b, a2)?.consumed.get("session"), {
		kind: "estimated",
		value: 5,
		method: "shared-account-window-delta",
	});
	assert.equal(fold(a1, b, a2)?.reading, a2);
});

it("stamps comparable pool evidence for Codex, Anthropic and Copilot: pseudonym, units, durations and a deny status only the provider states (S5b)", async () => {
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-pool" } })).toString("base64url")}.sig`;
	const poll = async (rateLimit: Record<string, unknown>, credits?: Record<string, unknown>) => {
		const { fetch } = stubFetch(() =>
			jsonResponse({
				plan_type: "plus",
				rate_limit: {
					...rateLimit,
					primary_window: { used_percent: 100, reset_at: 1_767_225_600, limit_window_seconds: 18_000 },
					secondary_window: { used_percent: 40, reset_at: 1_767_600_000, limit_window_seconds: 604_800 },
				},
				...(credits ? { credits } : {}),
			}),
		);
		const snapshot = await provider(fetch, { ...CREDENTIALS, accessToken: token, accountId: "acct-pool" }).fetch();
		const reading = quotaReadingFromSnapshot(snapshot, NOW.toISOString(), 60_000);
		assert.ok(reading && validPayload("quota.read", reading));
		return reading;
	};
	const denied = await poll({ allowed: false, limit_reached: true }, { has_credits: false, unlimited: false });
	assert.equal(denied.access, "denied");
	assert.equal(denied.overage, "refused");
	assert.match(denied.accountPseudonym ?? "", /^[0-9a-f]{32}$/);
	assert.ok(!JSON.stringify(denied).includes("acct-pool"));
	assert.deepEqual(
		denied.windows.map((window) => [window.key, window.unit, window.durationSeconds]),
		[
			["session", "percent", 18_000],
			["weekly", "percent", 604_800],
		],
	);
	assert.deepEqual(quotaDenial(denied, NOW.getTime())?.window, {
		key: "session",
		label: "5h",
		durationSeconds: 18_000,
		resetsAt: new Date(1_767_225_600_000).toISOString(),
	});
	assert.equal(quotaDenial(denied, NOW.getTime())?.fresh, true);
	assert.equal(quotaDenial(denied, NOW.getTime() + 120_000)?.fresh, false);

	const full = await poll({ allowed: true, limit_reached: false });
	assert.equal(full.access, "allowed", "a window measured at 100% is not a denial");
	assert.equal(quotaDenial(full), null);
	const paid = await poll(
		{ allowed: false, limit_reached: true },
		{ has_credits: true, unlimited: false, balance: "5" },
	);
	assert.deepEqual([paid.access, paid.overage], ["allowed", "permitted"]);
	assert.equal((await poll({})).access, "unknown");

	const limitOnly = parseCodexQuotaEvent(
		{ type: "codex.rate_limits", rate_limits: { allowed: false, limit_reached: true } },
		codexAccountScope(token),
		NOW.getTime(),
	);
	assert.ok(limitOnly);
	const stream = quotaReadingFromMessage({ codexQuota: limitOnly }, "openai-codex", "codex-target");
	assert.ok(stream && validPayload("quota.read", stream));
	assert.deepEqual([stream.limitOnly, stream.access, stream.windows.length], [true, "denied", 0]);
	assert.equal(stream.accountPseudonym, denied.accountPseudonym, "poll and stream share one pool key");
	assert.equal(quotaDenial(stream, NOW.getTime())?.window, null, "a denial survives a missing window");

	const { fetch: other } = stubFetch(() => jsonResponse({ rate_limit: { allowed: true } }));
	const selected = await provider(other, { ...CREDENTIALS, accessToken: token, accountId: "acct-other" }).fetch();
	assert.equal(
		selected.accountPseudonym,
		undefined,
		"an explicitly selected account the token cannot vouch for has no pool",
	);

	const { accountPseudonym: _pool, ...unpooled } = denied;
	const anonymous = (used: number, at: string): QuotaReading => ({
		...unpooled,
		observedAt: at,
		windows: [{ key: "weekly", usedPct: { kind: "measured", value: used, source: "provider" } }],
	});
	const folded = foldAccountQuota(
		[anonymous(40, "2026-01-01T00:00:00.000Z"), anonymous(60, "2026-01-01T00:01:00.000Z")].map(
			(data) => ({ k: "quota.read", data }) as unknown as TelemetryRecord,
		),
	);
	assert.equal([...folded.values()][0]?.consumed.size, 0, "readings without a verified identity never fold a delta");

	const familyOnly = quotaReadingFromMessage(
		{
			anthropicResponse: {
				observedAt: NOW.toISOString(),
				status: 429,
				attempts: 1,
				requestId: null,
				accountScope: "0123456789ab",
				retryAfterSeconds: null,
				rateLimit: { "7d-status": "rejected", "7d-reset": "1767225600", "overage-status": "rejected" },
				messageStart: null,
			},
		},
		"anthropic-max",
		"claude-target",
	);
	assert.ok(familyOnly && validPayload("quota.read", familyOnly));
	assert.deepEqual([familyOnly.access, familyOnly.overage, familyOnly.windows.length], ["denied", "refused", 0]);
	assert.deepEqual(
		[quotaDenial(familyOnly, NOW.getTime())?.resetsAt, quotaDenial(familyOnly, NOW.getTime())?.fresh],
		[new Date(1_767_225_600_000).toISOString(), true],
		"a family rejection without utilization still denies, fresh, until its reset",
	);

	const copilot = async (raw: unknown) => {
		const client = async () => ({
			getAuthStatus: async () => ({ isAuthenticated: true, login: "octocat", host: "https://github.com" }),
			rpc: { account: { getQuota: async () => raw } },
		});
		const snapshot = await createCopilotQuotaProvider({
			readQuota: () => readCopilotQuota({ client }),
			now: () => NOW,
		}).fetch();
		const reading = quotaReadingFromSnapshot(snapshot, NOW.toISOString(), 60_000);
		assert.ok(validPayload("quota.read", reading));
		assert.ok(!JSON.stringify(reading).includes("octocat"));
		return reading;
	};
	const evidence = (reading: QuotaReading) =>
		reading.windows.map((window) => [
			window.key,
			window.unit,
			window.durationSeconds ?? null,
			window.usedPct.kind === "measured" ? window.usedPct.value : (window.unlimited ?? window.usedPct.kind),
			window.access,
			window.qualification,
		]);
	const legacy = await copilot({
		quotaSnapshots: {
			chat: {
				isUnlimitedEntitlement: true,
				entitlementRequests: 0,
				usedRequests: 0,
				hasQuota: true,
				tokenBasedBilling: true,
			},
			premium_interactions: {
				isUnlimitedEntitlement: false,
				entitlementRequests: 300,
				usedRequests: 300,
				hasQuota: false,
				usageAllowedWithExhaustedQuota: false,
				overageAllowedWithExhaustedQuota: false,
				tokenBasedBilling: false,
			},
		},
	});
	assert.match(legacy.accountPseudonym ?? "", /^[0-9a-f]{32}$/);
	assert.deepEqual(evidence(legacy), [
		["premium_interactions", "premium-requests", null, 100, "denied", "authoritative"],
		["chat", "provider-credits", null, true, "allowed", "authoritative"],
	]);
	assert.equal(legacy.access, "allowed", "an exhausted premium bucket denies its window, not the chat bucket");
	assert.equal(quotaDenial(legacy), null);

	const budget = {
		consumed: 300,
		entitlement: 300,
		overage: 0,
		overageAllowedWhenExhausted: true,
		remainingPercentage: 0,
		unlimited: false,
		usageAllowedWhenExhausted: false,
	};
	const monthly = {
		state: "available",
		scope: "user",
		unit: "requests",
		consumedQuantity: 300,
		cycleStart: "2026-01-01T00:00:00Z",
		resetOn: "2026-02-01T00:00:00Z",
	};
	const sdk = { provider: { id: "github" }, observationKind: "account_snapshot", acquisitionStatus: "succeeded" };
	const failed = {
		...sdk,
		quotaId: "chat",
		unit: "unknown",
		accessState: "unavailable",
		capacityState: "unavailable",
		acquisitionStatus: "failed",
	};
	const current = await copilot({
		providerQuotas: [
			{
				...sdk,
				quotaId: "premium",
				compatibilityKey: "premium_interactions",
				unit: "requests",
				quantityKind: "authoritative_budget",
				accessState: "allowed",
				capacityState: "exhausted",
				availableQuantity: 0,
				budgetMetadata: budget,
				monthlyUsage: monthly,
			},
			{
				...sdk,
				quotaId: "credits",
				unit: "ai_credits",
				quantityKind: "advisory_balance",
				accessState: "unknown",
				capacityState: "available",
				availableQuantity: 0,
			},
			failed,
		],
	});
	assert.deepEqual(evidence(current), [
		["premium_interactions", "premium-requests", 2_678_400, 100, "allowed", "authoritative"],
		["credits", "provider-credits", null, "unknown", "unknown", "advisory"],
	]);
	assert.deepEqual([current.access, current.overage], ["allowed", "permitted"], "exhausted with overage permitted");
	assert.equal(current.accountPseudonym, legacy.accountPseudonym, "one account, one pool, whatever the model");

	const unacquired = await copilot({ providerQuotas: [failed] });
	assert.deepEqual([unacquired.status, unacquired.access, unacquired.validUntil], ["error", "unknown", undefined]);
});

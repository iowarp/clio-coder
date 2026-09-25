import assert from "node:assert/strict";
import { it } from "node:test";

import {
	foldDuplicateAccounts,
	footerQuotaSegment,
	formatPct,
	localQuotaSnapshot,
	primaryWindow,
	severityForPct,
	snapshotSeverity,
	windowByKey,
	windowSeverity,
} from "../../src/domains/quota/presentation.js";
import { createQuotaService } from "../../src/domains/quota/service.js";
import type { QuotaProvider, UsageSnapshot, UsageWindow } from "../../src/domains/quota/types.js";

function window(key: string, label: string, usedPct: number, extra: Partial<UsageWindow> = {}): UsageWindow {
	return { key, label, usedPct, resetsAt: null, ...extra };
}

function snapshot(
	providerId: string,
	displayName: string,
	windows: UsageWindow[],
	extra: Partial<UsageSnapshot> = {},
): UsageSnapshot {
	return { providerId, displayName, status: "ok", windows, fetchedAt: null, ...extra };
}

const ANTHROPIC_WINDOWS = [window("session", "5h", 6), window("weekly", "Weekly", 9)];

it("classifies severity by threshold and prefers the provider's own word", () => {
	assert.equal(severityForPct(0), "normal");
	assert.equal(severityForPct(59.9), "normal");
	assert.equal(severityForPct(60), "caution");
	assert.equal(severityForPct(80), "warning");
	assert.equal(severityForPct(95), "critical");

	assert.equal(windowSeverity(window("weekly", "Weekly", 99, { severity: "normal" })), "normal");
	assert.equal(windowSeverity(window("weekly", "Weekly", 99, { severity: "nonsense" })), "critical");
	assert.equal(windowSeverity(window("weekly", "Weekly", 12)), "normal");
});

it("reports a snapshot's worst window as its severity", () => {
	const mixed = snapshot("codex", "Codex", [window("session", "5h", 3), window("weekly", "Weekly", 88)]);
	assert.equal(snapshotSeverity(mixed), "warning");
	assert.equal(snapshotSeverity(snapshot("x", "X", [])), "normal");
});

it("picks the window closest to biting as the compact one", () => {
	const codex = snapshot("codex", "Codex", [window("weekly", "Weekly", 76)]);
	assert.equal(primaryWindow(codex)?.key, "weekly");
	assert.equal(primaryWindow(snapshot("x", "X", []))?.key, undefined);
	assert.equal(windowByKey(codex, "weekly")?.label, "Weekly");
	assert.equal(windowByKey(codex, "session"), null);
});

it("rounds percentages so a footer does not jitter on a fractional change", () => {
	assert.equal(formatPct(5.4), "5%");
	assert.equal(formatPct(5.5), "6%");
	assert.equal(formatPct(0), "0%");
});

it("folds two credentials that report the same account, keeping the labelled one", () => {
	const max = snapshot("anthropic-max", "Anthropic Max", ANTHROPIC_WINDOWS, { plan: null });
	const code = snapshot("claude-code", "Claude Code", ANTHROPIC_WINDOWS, { plan: "Max" });

	const folded = foldDuplicateAccounts([max, code]);

	assert.equal(folded.length, 1, "one account must not appear as two budgets");
	assert.equal(folded[0]?.providerId, "claude-code");
	assert.equal(folded[0]?.plan, "Max");
});

it("keeps genuinely different accounts apart", () => {
	const claude = snapshot("claude-code", "Claude Code", ANTHROPIC_WINDOWS);
	const codex = snapshot("codex", "Codex", [window("weekly", "Weekly", 76)]);
	const antigravity = snapshot("antigravity", "Antigravity", [
		window("session", "5h", 0),
		window("weekly", "Weekly", 73),
	]);

	assert.equal(foldDuplicateAccounts([claude, codex, antigravity]).length, 3);
});

it("builds a compact footer segment, showing 5h only where a provider reports one", () => {
	const segment = footerQuotaSegment([
		snapshot("claude-code", "Claude Code", ANTHROPIC_WINDOWS, { plan: "Max" }),
		snapshot("codex", "Codex", [window("weekly", "Weekly", 76)]),
		snapshot("antigravity", "Antigravity", [window("session", "5h", 0), window("weekly", "Weekly", 73)]),
	]);

	assert.equal(segment, "Claude 5h 6% used/wk 9% used · Codex wk 76% used · Antigravity 5h 0% used/wk 73% used");
});

it("falls back to the busiest window when a provider names neither session nor weekly", () => {
	const segment = footerQuotaSegment([
		snapshot("odd", "Odd", [window("weekly_scoped.fable", "Fable", 12, { short: "fbl" })]),
	]);
	assert.equal(segment, "Odd fbl 12% used");
});

it("returns no footer segment when nothing is connected", () => {
	assert.equal(footerQuotaSegment([]), null);
	assert.equal(footerQuotaSegment([snapshot("x", "X", [], { status: "error", message: "boom" })]), null);
});

it("marks local inference as free rather than omitting it", () => {
	const local = localQuotaSnapshot();

	assert.equal(local.providerId, "local");
	assert.equal(local.status, "ok");
	assert.deepEqual(local.windows, []);
	assert.equal(local.credits?.display, "$0.00");
	assert.equal(local.plan, "Local");
	assert.equal(local.message, "no subscription window consumed");
	assert.equal(localQuotaSnapshot({ runtimeLabel: "Ollama" }).displayName, "Ollama");
});

function fakeProvider(id: string, result: UsageSnapshot, counter: { calls: number }): QuotaProvider {
	return {
		id,
		displayName: result.displayName,
		detect: async () => result.status !== "no_credentials",
		fetch: async () => {
			counter.calls += 1;
			return result;
		},
	};
}

it("reads every provider concurrently and appends the free local row", async () => {
	const paid = { calls: 0 };
	const absent = { calls: 0 };
	const service = createQuotaService({
		providers: [
			fakeProvider("codex", snapshot("codex", "Codex", [window("weekly", "Weekly", 76)]), paid),
			fakeProvider("copilot", snapshot("copilot", "Copilot", [], { status: "no_credentials", message: "none" }), absent),
		],
	});

	const snapshots = await service.read();

	assert.deepEqual(
		snapshots.map((entry) => entry.providerId),
		["codex", "local"],
		"a provider with no credentials is dropped, and local is always shown",
	);
	assert.equal(paid.calls, 1);
	assert.equal(absent.calls, 1);

	const again = await service.read();
	assert.equal(paid.calls, 1, "a good snapshot inside the TTL must not spend another network read");
	assert.equal(absent.calls, 2, "an absent credential is re-checked, since signing in must take effect");
	assert.equal(again.length, 2);
});

it("survives a provider that throws instead of returning a snapshot", async () => {
	const service = createQuotaService({
		providers: [
			{
				id: "broken",
				displayName: "Broken",
				detect: async () => {
					throw new Error("detect exploded");
				},
				fetch: async () => {
					throw new Error("fetch exploded");
				},
			},
		],
		includeLocal: false,
	});

	const snapshots = await service.read();

	assert.equal(snapshots.length, 1);
	assert.equal(snapshots[0]?.status, "error");
	assert.equal(snapshots[0]?.message, "fetch exploded");
	assert.deepEqual(await service.detected(), []);
});

it("peeks without spending a read", async () => {
	const calls = { calls: 0 };
	const service = createQuotaService({
		providers: [fakeProvider("codex", snapshot("codex", "Codex", [window("weekly", "Weekly", 76)]), calls)],
		includeLocal: false,
	});

	assert.deepEqual(service.peek(), []);
	assert.equal(calls.calls, 0);

	await service.read();
	assert.equal(service.peek()[0]?.providerId, "codex");
	assert.equal(calls.calls, 1);
});

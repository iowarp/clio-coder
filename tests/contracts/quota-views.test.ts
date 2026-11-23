import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { CallEconomics } from "../../src/core/telemetry/economy.js";
import { callEconomicsOf } from "../../src/core/telemetry/economy.js";
import { foldDuplicateAccounts, footerQuotaSegment, primaryWindow } from "../../src/domains/quota/presentation.js";
import { quotaReadingFromSnapshot } from "../../src/domains/quota/reading.js";
import type { UsageSnapshot } from "../../src/domains/quota/types.js";
import { foldEconomy } from "../../src/domains/telemetry/economy-fold.js";
import { quotaAccountDetails } from "../../src/domains/telemetry/read-model.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	bindingQuotaWindow,
	bindingWindowPart,
	linkedQuotaAccounts,
	quotaMeter,
	quotaResetLabel,
	quotaWaitWords,
	renderQuotaAccounts,
	renderWorkerUsage,
	routeWeeklyQuota,
	workerQuotaLabel,
} from "../../src/interactive/quota-view.js";
import { economyEvidence, economyReceipt, receiptLine } from "../../src/interactive/usage-words.js";
import { runUsageOf } from "../harness/telemetry-view.js";

const now = Date.parse("2026-09-21T14:00:00Z");
const account: UsageSnapshot = {
	providerId: "antigravity",
	displayName: "Antigravity",
	status: "ok",
	plan: "Pro",
	windows: [
		{ key: "weekly", label: "Weekly", scope: "Gemini models", usedPct: 73, resetsAt: "2026-09-23T16:00:00Z" },
		{
			key: "group.1.weekly",
			label: "Weekly",
			scope: "Claude and GPT models",
			usedPct: 96,
			resetsAt: "2026-09-21T15:00:00Z",
		},
	],
	fetchedAt: "2026-09-21T13:59:00Z",
};
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

test("reset labels include a countdown, local wall time, timezone, and an honest elapsed state", () => {
	match(quotaResetLabel("2026-09-21T15:00:00Z", now, "America/Chicago"), /in 1h 0m.*Sep 21, 10:00 AM.*America\/Chicago/);
	match(quotaResetLabel("2026-09-23T16:00:00Z", now, "America/Chicago"), /in 2d 2h/);
	match(quotaResetLabel("2026-09-20T15:00:00Z", now, "America/Chicago"), /Reset time passed.*awaiting provider update/);
	strictEqual(quotaResetLabel(null, now), "Reset time not reported");
	strictEqual(quotaResetLabel("broken", now), "Reset time not reported");
	// A daylight-saving transition changes the wall clock, not elapsed time.
	match(
		quotaResetLabel("2026-11-01T08:00:00Z", Date.parse("2026-11-01T06:00:00Z"), "America/Chicago"),
		/in 2h 0m.*2:00 AM/,
	);
});

test("meters show consumed capacity consistently and remain bounded", () => {
	strictEqual(stripTerminalSequences(quotaMeter(0, 10)), "──────────");
	strictEqual(stripTerminalSequences(quotaMeter(50, 10)), "━━━━━─────");
	strictEqual(stripTerminalSequences(quotaMeter(120, 10)), "━━━━━━━━━━");
	strictEqual(visibleWidth(quotaMeter(-10, 10)), 10);
});

test("account cards retain all groups, local resets and stale status across terminal widths", () => {
	for (const width of [20, 40, 80, 120]) {
		const rows = renderQuotaAccounts(quotaRows([account]), width, { now, timeZone: "America/Chicago" });
		ok(rows.every((row) => visibleWidth(row) <= width));
		const text = plain(rows).replace(/\n/g, " ");
		match(text, /Gemini models/);
		match(text, /Claude and GPT/);
		match(text, /96% used/);
		match(text, /America\/Chicago/);
	}
	const stale = plain(renderQuotaAccounts(quotaRows([{ ...account, stale: true }]), 50, { compact: true }));
	match(stale, /STALE/);
	const compact = plain(renderQuotaAccounts(quotaRows([account]), 120, { compact: true }));
	ok(compact.indexOf("Claude and GPT") < compact.indexOf("Gemini"), "a binding scope must survive truncation first");
});

test("equal percentages across providers never merge unrelated accounts", () => {
	const codex = { ...account, providerId: "codex", displayName: "Codex" };
	deepStrictEqual(
		foldDuplicateAccounts([account, codex]).map((item) => item.providerId),
		["antigravity", "codex"],
	);
	const claude = { ...account, providerId: "claude-code" };
	const max = { ...account, providerId: "anthropic-max" };
	strictEqual(foldDuplicateAccounts([claude, max]).length, 1);
	strictEqual(
		foldDuplicateAccounts([
			claude,
			{
				...max,
				windows: max.windows.map((window) => ({
					...window,
					resetsAt: new Date(Date.parse(window.resetsAt ?? "") + 70).toISOString(),
				})),
			},
		]).length,
		1,
		"the live endpoint adds per-response milliseconds to reset times",
	);
	strictEqual(
		foldDuplicateAccounts([claude, { ...max, windows: max.windows.map((window) => ({ ...window, resetsAt: null })) }])
			.length,
		2,
	);
});

test("a binding scoped quota is surfaced even when the primary group has headroom", () => {
	match(footerQuotaSegment([account]) ?? "", /Claude and GPT models Weekly 96%/);
	strictEqual(primaryWindow(account)?.scope, "Claude and GPT models");
	const reported = {
		...account,
		windows: account.windows.map((window, index) => ({ ...window, severity: index === 0 ? "critical" : "normal" })),
	};
	strictEqual(primaryWindow(reported)?.scope, "Gemini models", "the provider's severity outranks percentage inference");
});

test("worker quota joins only known local credential owners and does not claim a per-worker share", () => {
	match(workerQuotaLabel({ runtimeId: "antigravity-code" }, quotaRows([account])), /Shared antigravity.*96% used/);
	match(
		workerQuotaLabel({ runtimeId: "antigravity-code", node: "remote-1" }, quotaRows([account])),
		/unavailable for remote/,
	);
	match(workerQuotaLabel({ runtimeId: "openai-codex" }, quotaRows([{ ...account, providerId: "codex" }])), /not linked/);
	match(workerQuotaLabel({ runtimeId: "litellm" }, quotaRows([account])), /not linked/);
	const row: DispatchBoardRow = {
		runId: "worker-1",
		agentId: "researcher",
		runtimeKind: "subprocess",
		runtimeId: "antigravity-code",
		targetId: "agy",
		wireModelId: "gemini-pro",
		status: "running",
		elapsedMs: 1000,
		usage: runUsageOf("run", [{ usage: { input: 1000, output: 234 }, usd: null }]),
		lastContextTokens: null,
		ttft: null,
	};
	const text = plain(renderWorkerUsage([row], [], quotaRows([account]), 100));
	// Token columns are headed once (6.5); cost is a detailed column, and an unmeasured cost is never a figure.
	match(text, /\bin\s+out\b/);
	match(text, /\b1\.0k {2}234\b/);
	doesNotMatch(text, /prompt|\$0/);
	match(text, /Shared antigravity/);
	doesNotMatch(text, /\$0.00|quota saved/);
	match(
		plain(renderWorkerUsage([{ ...row, usage: { kind: "unavailable" } }], [], quotaRows([account]), 80)),
		// No measured value is the dash in every cell, and the line under the table says what a dash means, once.
		/— {4}—[\s\S]*— not measured, or no calls yet/,
	);
	match(
		plain(renderWorkerUsage([{ ...row, usage: { kind: "pending" } }], [], quotaRows([account]), 80)),
		/researcher {2}1\.0s {3}— {4}—[\s\S]*— not measured, or no calls yet/,
	);
});

test("weekly badges select the model's own group and never infer another account's quota", () => {
	const route = { runtimeId: "antigravity-code", wireModelId: "gemini-3.8-flash" };
	strictEqual(routeWeeklyQuota(route, quotaRows([account]))?.label, "weekly 73% used");
	strictEqual(
		routeWeeklyQuota({ ...route, wireModelId: "claude-opus" }, quotaRows([account]))?.label,
		"weekly 96% used",
	);
	strictEqual(routeWeeklyQuota({ ...route, wireModelId: "gpt-oss" }, quotaRows([account]))?.label, "weekly 96% used");
	strictEqual(routeWeeklyQuota({ ...route, wireModelId: "auto" }, quotaRows([account])), null);
	strictEqual(routeWeeklyQuota({ ...route, node: "remote" }, quotaRows([account])), null);
	strictEqual(routeWeeklyQuota({ ...route, runtimeId: "litellm" }, quotaRows([account])), null);
	strictEqual(
		routeWeeklyQuota({ ...route, runtimeId: "openai-codex" }, quotaRows([{ ...account, providerId: "codex" }])),
		null,
	);
	strictEqual(routeWeeklyQuota(route, quotaRows([{ ...account, status: "expired" }])), null);
	strictEqual(
		routeWeeklyQuota(
			route,
			quotaRows([
				{
					...account,
					windows: [{ key: "model.gemini", label: "Model quota", scope: "gemini", usedPct: 73, resetsAt: null }],
				},
			]),
		),
		null,
	);
	strictEqual(routeWeeklyQuota(route, quotaRows([{ ...account, stale: true }]))?.label, "STALE · weekly 73% used");
	for (const [usedPct] of [
		[0, 100],
		[100, 0],
		[7, 93],
		[77, 23],
	]) {
		const claude: UsageSnapshot = {
			...account,
			providerId: "claude-code",
			windows: [{ key: "weekly", label: "Weekly", usedPct: usedPct ?? 0, resetsAt: null }],
		};
		strictEqual(
			routeWeeklyQuota({ runtimeId: "claude-code", wireModelId: "claude-opus" }, quotaRows([claude]))?.label,
			`weekly ${usedPct}% used`,
		);
	}
});

test("the receipt leads with the binding window, keeps sub-cent digits and leaves the period fee to the evidence", () => {
	const month = { kind: "month", start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" } as const;
	const covered: CallEconomics = {
		...callEconomicsOf({ disposition: "settled" }),
		additive: {
			...callEconomicsOf({ disposition: "settled" }).additive,
			marginalCharge: { currency: "USD", amount: { kind: "estimated", value: 0, method: "plan-coverage" } },
		},
		comparison: {
			apiEquivalent: {
				currency: "USD",
				amount: { kind: "estimated", value: 0.0004, method: "public-retail-tariff" },
				referenceRowId: "google/gemini-pro",
				asOf: "2026-09-01",
				basis: "served-model",
			},
		},
		funding: {
			kind: "snapshot",
			poolId: "agy-plan",
			scheme: { source: "declared", kind: "subscription" },
			payer: "personal",
			unit: "USD",
			period: month,
		},
	};
	const cut = { role: "main", model: "agy/gemini-pro", target: "agy" };
	const economy = foldEconomy(
		[
			{
				ref: { kind: "attempt", attemptId: "a1", callId: "c1" },
				at: "2026-09-21T13:00:00Z",
				economics: covered,
				settled: true,
				cut,
			},
			// A call settled before economics were captured stays unknown on the receipt, never $0.00.
			{
				ref: { kind: "attempt", attemptId: "a2", callId: "c2" },
				at: "2026-09-21T13:30:00Z",
				economics: callEconomicsOf({ disposition: "settled" }),
				settled: true,
				cut,
			},
		],
		{
			pools: {
				"agy-plan": { scheme: "declared", payer: "personal", fee: { amount: 20, currency: "USD", period: "month" } },
			},
			window: { from: Date.parse("2026-09-21T00:00:00Z"), to: Date.parse("2026-09-21T23:59:59Z") },
		},
	);
	const binding = bindingQuotaWindow(linkedQuotaAccounts(quotaRows([account]), { runtimeIds: ["antigravity-code"] }));
	ok(binding);
	const receipt = economyReceipt(economy.total, bindingWindowPart(binding, now));
	const line = receiptLine(receipt);
	match(
		line,
		/^Antigravity Claude and GPT models Weekly 96% used · resets in 1h 0m · included \(estimate\) \+\? · API equiv /,
	);
	match(line, /\$0\.0004/, "a sub-cent API equivalent keeps its digits");
	doesNotMatch(line, /\$0\.00\b|free|\$20/, "neither free nor the period fee on the receipt");
	deepStrictEqual(
		receipt.map((part) => part.unknown),
		[false, true, true],
		"the parts with an unknown take the neutral tone",
	);
	const evidence = economyEvidence(economy);
	deepStrictEqual(
		evidence.filter(([label]) => label === "fee").map(([, value, note]) => [value, note?.split(" · ")[0]]),
		[[economy.fees[0]?.display, "pool agy-plan"]],
		"the fee appears once, in the evidence",
	);
	match(evidence.find(([label]) => label === "priced from")?.[1] ?? "", /google\/gemini-pro as of 2026-09-01/);
	match(
		quotaWaitWords(binding, now),
		/^waiting for quota on Antigravity Claude and GPT models Weekly 96% used · resets in 1h 0m · read 1m00s ago$/,
	);
	match(quotaWaitWords(null, now), /window unknown/);

	// A window whose percent or reset went unreported takes the neutral tone and never reads as a known percentage.
	const unread = bindingWindowPart({ ...binding, pct: null, used: "unknown", resetsAt: null }, now);
	strictEqual(unread.unknown, true);
	match(unread.text, /Weekly use unknown · reset unknown$/);
	// A quota account links by the calls' runtime, whatever the target is called; a remote node's links none.
	const cli = quotaRows([{ ...account, providerId: "codex-cli" }]);
	strictEqual(linkedQuotaAccounts(cli, { targetIds: ["my-codex"] }).length, 0);
	strictEqual(linkedQuotaAccounts(cli, { runtimeIds: ["codex-cli"], targetIds: ["my-codex"] }).length, 1);
	strictEqual(linkedQuotaAccounts(cli, { runtimeIds: ["codex-cli"], node: "gpu-box" }).length, 0);
	// The seat debit the runtime reported wins over the listing estimate, and the evidence says whose word it is.
	const seat = foldEconomy([
		{
			ref: { kind: "attempt", attemptId: "a3", callId: "c3" },
			at: "2026-09-21T14:00:00Z",
			economics: callEconomicsOf({ disposition: "settled" }),
			settled: true,
			reportedNanoAiu: { kind: "measured", value: 2_000_000_000, source: "provider" },
			cut,
		},
	]);
	deepStrictEqual(
		economyEvidence(seat, "session")
			.filter(([label]) => label === "seat credits" || label === "period cash" || label === "declared fees")
			.map(([label, , note]) => [label, note]),
		[
			["seat credits", "provider-reported debit"],
			["declared fees", "clio-coder usage report lists each once"],
		],
		"a session's evidence carries no period cash, since its projection carries no declared fee",
	);
});

function quotaRows(
	snapshots: readonly UsageSnapshot[],
): import("../../src/core/telemetry/dto.js").QuotaStateV1["providers"] {
	return snapshots.map((snapshot) => ({
		provider: snapshot.providerId,
		...quotaAccountDetails(quotaReadingFromSnapshot(snapshot, snapshot.fetchedAt ?? new Date(0).toISOString())),
		source: "poll",
		observedAt: snapshot.fetchedAt,
		stale: snapshot.stale ?? false,
		windows: snapshot.windows.map((window) => ({
			key: window.key,
			scope: window.scope ?? null,
			label: `${window.scope ? `${window.scope} ` : ""}${window.label}`,
			usedPct: { fact: { kind: "measured", value: window.usedPct, source: "provider" }, display: `${window.usedPct}%` },
			resetsAt: window.resetsAt,
			unit: window.unit ?? null,
			durationSeconds: window.durationSeconds ?? null,
			access: window.access ?? "unknown",
		})),
	}));
}

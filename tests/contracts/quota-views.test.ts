import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { foldDuplicateAccounts, footerQuotaSegment, primaryWindow } from "../../src/domains/quota/presentation.js";
import type { UsageSnapshot } from "../../src/domains/quota/types.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { type DispatchBoardRow, formatTaskIslandLines } from "../../src/interactive/dispatch-board.js";
import {
	quotaMeter,
	quotaResetLabel,
	renderQuotaAccounts,
	renderWorkerUsage,
	routeWeeklyQuota,
	workerQuotaLabel,
} from "../../src/interactive/quota-view.js";

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
		const rows = renderQuotaAccounts([account], width, { now, timeZone: "America/Chicago" });
		ok(rows.every((row) => visibleWidth(row) <= width));
		const text = plain(rows).replace(/\n/g, " ");
		match(text, /Gemini models/);
		match(text, /Claude and GPT/);
		match(text, /96% used/);
		match(text, /America\/Chicago/);
	}
	const stale = plain(renderQuotaAccounts([{ ...account, stale: true }], 50, { compact: true }));
	match(stale, /STALE/);
	const compact = plain(renderQuotaAccounts([account], 120, { compact: true }));
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
	match(workerQuotaLabel({ runtimeId: "antigravity-code" }, [account]), /Shared Antigravity.*4% left/);
	match(workerQuotaLabel({ runtimeId: "antigravity-code", node: "remote-1" }, [account]), /unavailable for remote/);
	match(workerQuotaLabel({ runtimeId: "openai-codex" }, [{ ...account, providerId: "codex" }]), /not linked/);
	match(workerQuotaLabel({ runtimeId: "litellm" }, [account]), /not linked/);
	const row: DispatchBoardRow = {
		runId: "worker-1",
		agentId: "researcher",
		runtimeKind: "subprocess",
		runtimeId: "antigravity-code",
		targetId: "agy",
		wireModelId: "gemini-pro",
		status: "running",
		elapsedMs: 1000,
		tokenCount: 1234,
		inputTokens: 1000,
		outputTokens: 234,
		costUsd: 0,
		ttftMs: null,
	};
	const text = plain(renderWorkerUsage([row], [account], 100));
	match(text, /1.2k recorded tokens/);
	match(text, /cost not reported/);
	match(text, /Shared Antigravity/);
	doesNotMatch(text, /\$0.00|quota saved/);
	match(
		plain(renderWorkerUsage([{ ...row, tokenCount: 0, inputTokens: 0, outputTokens: 0 }], [account], 80)),
		/Token usage not reported/,
	);
});

test("weekly badges select the model's own group and never infer another account's quota", () => {
	const route = { runtimeId: "antigravity-code", wireModelId: "gemini-3.8-flash" };
	strictEqual(routeWeeklyQuota(route, [account])?.label, "weekly 27% left");
	strictEqual(routeWeeklyQuota({ ...route, wireModelId: "claude-opus" }, [account])?.label, "weekly 4% left");
	strictEqual(routeWeeklyQuota({ ...route, wireModelId: "gpt-oss" }, [account])?.label, "weekly 4% left");
	strictEqual(routeWeeklyQuota({ ...route, wireModelId: "auto" }, [account]), null);
	strictEqual(routeWeeklyQuota({ ...route, node: "remote" }, [account]), null);
	strictEqual(routeWeeklyQuota({ ...route, runtimeId: "litellm" }, [account]), null);
	strictEqual(routeWeeklyQuota({ ...route, runtimeId: "openai-codex" }, [{ ...account, providerId: "codex" }]), null);
	strictEqual(routeWeeklyQuota(route, [{ ...account, status: "expired" }]), null);
	strictEqual(
		routeWeeklyQuota(route, [
			{
				...account,
				windows: [{ key: "model.gemini", label: "Model quota", scope: "gemini", usedPct: 73, resetsAt: null }],
			},
		]),
		null,
	);
	strictEqual(routeWeeklyQuota(route, [{ ...account, stale: true }])?.label, "STALE · weekly 27% left");
	for (const [usedPct, remaining] of [
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
			routeWeeklyQuota({ runtimeId: "claude-code", wireModelId: "claude-opus" }, [claude])?.label,
			`weekly ${remaining}% left`,
		);
	}
	const row: DispatchBoardRow = {
		...route,
		agentAudience: "base",
		runId: "run",
		agentId: "worker",
		runtimeKind: "subprocess",
		targetId: "agy",
		status: "running",
		elapsedMs: 1000,
		tokenCount: 100,
		inputTokens: 80,
		outputTokens: 20,
		costUsd: 0,
		ttftMs: null,
	};
	const island = formatTaskIslandLines([row], 1, [account]);
	match(plain(island), /Shared account.*weekly 27% left/);
	doesNotMatch(plain(island), /4% left|96%|5h/);
	ok(island.every((line) => visibleWidth(line) <= 76));
	doesNotMatch(plain(formatTaskIslandLines([{ ...row, node: "remote" }], 1, [account])), /Shared account|weekly/);
});

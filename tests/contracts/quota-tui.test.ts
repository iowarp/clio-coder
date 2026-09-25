import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createCostTracker } from "../../src/domains/observability/cost.js";
import {
	emptyCostAggregate,
	type ObservabilityContract,
	type ObservabilitySnapshot,
} from "../../src/domains/observability/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { localQuotaSnapshot } from "../../src/domains/quota/presentation.js";
import { createQuotaSummaryFeed } from "../../src/domains/quota/summary-feed.js";
import type { UsageSnapshot } from "../../src/domains/quota/types.js";
import {
	type Component,
	type OverlayOptions,
	stripTerminalSequences,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { type OverlayKeyDeps, routeOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";
import { createWelcomeDashboard } from "../../src/interactive/welcome-dashboard.js";

function accounts(): UsageSnapshot[] {
	return [
		{
			providerId: "claude-code",
			displayName: "Claude Code",
			plan: "Max",
			status: "ok",
			windows: [
				{ key: "session", label: "5h", usedPct: 6, resetsAt: null },
				{ key: "weekly", label: "Weekly", usedPct: 9, resetsAt: "2026-09-27T15:00:00Z" },
			],
			credits: { display: "$30.41/$50.00", usedPct: 60.82 },
			fetchedAt: "2026-09-21T12:00:00Z",
		},
		{
			providerId: "codex",
			displayName: "Codex",
			plan: "Pro",
			status: "ok",
			windows: [{ key: "weekly", label: "Weekly", usedPct: 76, resetsAt: "2026-09-27T15:00:00Z" }],
			fetchedAt: "2026-09-21T12:00:00Z",
		},
		{
			providerId: "antigravity",
			displayName: "Antigravity",
			status: "ok",
			windows: [{ key: "weekly", label: "Weekly", usedPct: 73, resetsAt: null }],
			fetchedAt: "2026-09-21T12:00:00Z",
		},
		localQuotaSnapshot(),
	];
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("quota feed shares one lazy read, refreshes detail-only changes, and stops on disposal", async () => {
	let reads = 0;
	let updates = 0;
	let now = 0;
	let next = accounts();
	const feed = createQuotaSummaryFeed({
		service: {
			peek: () => [],
			detected: async () => [],
			read: async () => {
				reads++;
				return next;
			},
		},
		onUpdate: () => updates++,
		now: () => now,
		ttlMs: 100,
	});
	strictEqual(feed.peek(), null);
	deepStrictEqual(feed.peekSnapshots(), []);
	strictEqual(reads, 0, "render stack must not invoke a provider");
	await setImmediate();
	strictEqual(reads, 1);
	strictEqual(updates, 1);
	const summary = feed.peek();
	match(summary ?? "", /Antigravity.*Local \$0.00/);
	feed.peekSnapshots();
	await setImmediate();
	strictEqual(reads, 1, "clock zero is a valid successful read time");
	next = accounts().map((snapshot) => ({ ...snapshot, stale: true }));
	now = 101;
	feed.peek();
	feed.peekSnapshots();
	await setImmediate();
	strictEqual(reads, 2);
	strictEqual(feed.peek(), summary);
	strictEqual(updates, 2, "staleness must repaint even when the percentage summary is unchanged");
	ok(feed.peekSnapshots()[0]?.stale);
	now = 202;
	feed.peekSnapshots();
	feed.dispose();
	await setImmediate();
	strictEqual(reads, 2);
	strictEqual(updates, 2);
});

test("welcome subscriptions stay in the field list and wrap without dropping accounts or local cost", () => {
	let quota = "Claude 5h 6%/wk 9% · Codex wk 76% · Antigravity wk 73% · Local $0.00";
	const banner = createWelcomeDashboard({ providers: { list: () => [] }, getQuotaSummary: () => quota });
	try {
		for (const width of [40, 60, 80, 120, 160, 220]) {
			const rendered = banner.render(width);
			const text = plain(rendered);
			const fields = text
				.slice(text.indexOf("Subscriptions"))
				.replace(/[│█\n]/g, " ")
				.replace(/\s+/g, " ");
			for (const name of ["Claude", "Codex", "Antigravity", "Local $0.00"])
				ok(fields.includes(name), `${width}: ${fields}`);
			ok(text.indexOf("Targets") < text.indexOf("Subscriptions"));
			ok(text.indexOf("Subscriptions") < text.indexOf("Fleet"));
			ok(rendered.every((line) => visibleWidth(line) <= width));
		}
		quota = "Codex wk 81% · Local $0.00";
		match(plain(banner.render(120)), /81%/);
	} finally {
		banner.dispose();
	}
});

test("footer keeps unassociated accounts out of compact rows and supplies all accounts to Status", () => {
	let columns = 160;
	let notices: { key: string | null; id: string; level: "error"; text: string; addedAt: number; expiresAt: null }[] = [];
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		getQuotaSnapshots: accounts,
		getNotifications: () => notices,
		getTerminalColumns: () => columns,
		getTerminalRows: () => 48,
		resolveCurrentBranch: async () => null,
	});
	try {
		const compact = footer.view.render(160);
		strictEqual(compact.length, 2);
		doesNotMatch(plain(compact), /Claude|Codex|Antigravity|weekly/);
		ok(plain(compact).includes(basename(process.cwd())));
		columns = 50;
		footer.refresh();
		const narrow = footer.view.render(50);
		strictEqual(narrow.length, 1);
		doesNotMatch(plain(narrow), /Codex|weekly/);
		ok(narrow.every((line) => visibleWidth(line) <= 50));
		columns = 160;
		notices = [{ key: null, id: "error", level: "error", text: "Connection lost", addedAt: Date.now(), expiresAt: null }];
		footer.refresh();
		match(plain(footer.view.render(160)), /Connection lost/);
		footer.toggleExpanded();
		footer.toggleExpanded();
		footer.toggleExpanded();
		const status = plain(footer.view.render(160));
		match(status, /Claude Code \(Max\).*5h 6%.*Weekly 9%/);
		match(status, /Codex \(Pro\).*Weekly 76%/);
		match(status, /Local AI.*\$0.00/);
		doesNotMatch(status, /not reported by provider|\/cost/);
	} finally {
		footer.dispose();
	}
});

test("usage replaces cost in parsing, dispatch, autocomplete, and Escape routing", async () => {
	deepStrictEqual(parseSlashCommand("/usage"), { kind: "usage" });
	strictEqual(parseSlashCommand("/usage extra").kind, "usage-error");
	strictEqual(parseSlashCommand("/cost").kind, "unknown-command");
	let opened = 0;
	await dispatchSlashCommand(parseSlashCommand("/usage"), {
		openUsage: () => {
			opened++;
		},
	} as SlashCommandContext);
	strictEqual(opened, 1);
	const completions = createSlashCommandAutocompleteProvider({ fdPath: null });
	const result = await completions.getSuggestions(["/us"], 0, 3, { signal: new AbortController().signal });
	ok(result?.items.some((item) => item.value.includes("usage")));
	let closed = 0;
	const deps = {
		closeOverlay: () => {
			closed++;
		},
	} as OverlayKeyDeps;
	strictEqual(
		routeOverlayKey("\x1b[B", "usage", deps, () => false),
		false,
		"scroll keys reach the overlay",
	);
	strictEqual(
		routeOverlayKey("\x1b", "usage", deps, () => false),
		true,
	);
	strictEqual(closed, 1);
});

test("usage overlay shows account details and live session totals, scrolls, resizes, and releases ownership", () => {
	let frame: Component | undefined;
	let options: OverlayOptions | undefined;
	let listener: ((snapshot: ObservabilitySnapshot) => void) | undefined;
	let unsubscribed = 0;
	let hidden = 0;
	let renders = 0;
	const titles: string[] = [];
	let quota = accounts();
	const costs = createCostTracker();
	const snapshot = { session: { cost: emptyCostAggregate() } } as ObservabilitySnapshot;
	const observability = {
		snapshot: () => snapshot,
		costEntries: () => costs.entries(),
		sessionCostSummary: emptyCostAggregate,
		subscribe: (callback: typeof listener) => {
			listener = callback;
			callback?.(snapshot);
			return () => {
				unsubscribed++;
			};
		},
	} as unknown as ObservabilityContract;
	const tui = {
		terminal: { setTitle: (title: string) => titles.push(title) },
		requestRender: () => renders++,
		showOverlay: (component: Component, supplied: OverlayOptions) => {
			frame = component;
			options = supplied;
			return { hide: () => hidden++ };
		},
	} as unknown as TUI;
	const handle = openUsageOverlay(tui, observability, { getQuotaSnapshots: () => quota });
	const render = (width = 100, height = 100) => {
		options?.visible?.(width, height);
		const lines = frame?.render(width) ?? [];
		ok(lines.length <= height);
		ok(lines.every((line) => visibleWidth(line) <= width));
		return plain(lines);
	};
	try {
		match(titles.at(-1) ?? "", /modal:usage/);
		const text = render();
		match(text, /Claude Code \(Max\)/);
		match(text, /\$30.41\/\$50.00/);
		match(text, /76% used · 24% remaining/);
		match(text, /no subscription window consumed/);

		const codex = text.slice(text.indexOf("Codex"), text.indexOf("Antigravity"));
		// The row label, not any "5h": a weekly reset rendered as "4d 15h" also contains it.
		doesNotMatch(codex, /│ 5h · /);
		quota = accounts().map((entry) =>
			entry.providerId === "codex" ? { ...entry, stale: true, message: "refresh failed", retryAfterSeconds: 30 } : entry,
		);
		match(render(), /STALE · last good reading/);
		match(render(), /Retry after 30s/);
		const before = renders;
		listener?.(snapshot);
		ok(renders > before);
		frame?.handleInput?.("2");
		match(render(), /Session tokens & cost/);
		render(40, 12);
		frame?.handleInput?.("\x1b[F");
		match(render(40, 12), /no token usage recorded/);
		frame?.handleInput?.("\x1b[H");
		match(render(40, 12), /Session tokens/);
		frame?.handleInput?.("1");
		match(render(), /Account-wide limits/);
		frame?.handleInput?.("3");
		costs.accumulate("fixture", "model-a", 1234, 0.25, { input: 1000, output: 234, apiCalls: 1 }, "known");
		listener?.({ ...snapshot, session: { ...snapshot.session, cost: costs.sessionCost() } });
		const live = render();
		match(live, /attributed model model-a/);
		match(live, /1,234 tokens/);
		match(live, /\$0.25/);
		doesNotMatch(live, /no token usage recorded/);
		quota = [
			{
				providerId: "antigravity",
				displayName: "Antigravity",
				status: "expired",
				windows: [],
				fetchedAt: null,
				message: "run agy",
			},
		];
		frame?.handleInput?.("1");
		match(render(), /expired · run agy/);
		frame?.handleInput?.("4");
		match(render(), /No worker invocations/);
		frame?.handleInput?.("\t");
		match(render(), /Account-wide limits/);
	} finally {
		handle.hide();
	}
	strictEqual(unsubscribed, 1);
	strictEqual(hidden, 1);
	strictEqual(titles.at(-1), "clio");
});

test("footer producer follows selected runtime changes instead of picking the busiest account", () => {
	let target = "claude";
	const footer = buildFooterDashboard({
		providers: {
			list: () => [
				{
					target: { id: "claude", runtime: "claude-code", defaultModel: "claude-opus" },
					runtime: { id: "claude-code" },
					capabilities: EMPTY_CAPABILITIES,
				},
				{
					target: { id: "local", runtime: "ollama", defaultModel: "qwen" },
					runtime: { id: "ollama" },
					capabilities: EMPTY_CAPABILITIES,
				},
			],
			knowledgeBase: null,
		} as never,
		getSettings: () => ({ ...DEFAULT_SETTINGS, chat: { ...DEFAULT_SETTINGS.chat, target, model: null } }),
		getQuotaSnapshots: accounts,
		getTerminalColumns: () => 160,
		getTerminalRows: () => 48,
		resolveCurrentBranch: async () => null,
	});
	try {
		match(plain(footer.view.render(160)), /weekly 91% left/);
		doesNotMatch(plain(footer.view.render(160)), /Codex|Antigravity/);
		target = "local";
		footer.refresh();
		doesNotMatch(plain(footer.view.render(160)), /weekly|Claude|Codex|Antigravity/);
	} finally {
		footer.dispose();
	}
});

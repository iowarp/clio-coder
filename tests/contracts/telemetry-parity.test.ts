/**
 * Cross-surface parity (#434 §13.2, R11): one fixture on disk, read live the way the TUI and ACP read it and cold the
 * way the CLI's `--json` and the GUI's routes read it, shows one value and one provenance for each fact on every
 * surface. The footer, /usage, /context, the exit card, the dispatch board, ACP's v1 usage, its live totals and its
 * telemetry methods each take the live view; the CLI and the GUI serve the cold DTOs, which the GUI's own route test
 * compares with what it serves. Every DTO the surfaces read passes the §13.1 lie detectors.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Quantity } from "../../src/core/telemetry/dto.js";
import { renderCompactCount } from "../../src/core/telemetry/render.js";
import type { TelemetryView } from "../../src/domains/observability/contract.js";
import type { ObservabilityContract } from "../../src/domains/observability/index.js";
import type { LiveTelemetryModel } from "../../src/domains/observability/telemetry-live.js";
import { createLiveTelemetryModel } from "../../src/domains/observability/telemetry-live.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { sessionUsageTotals } from "../../src/engine/acp/live-telemetry.js";
import { telemetryRequestHandlers } from "../../src/engine/acp/telemetry-methods.js";
import { ACP_TELEMETRY_METHODS } from "../../src/engine/acp/types.js";
import { sessionUsageV1 } from "../../src/engine/acp/usage.js";
import type { TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { openContextOverlay } from "../../src/interactive/context-overlay.js";
import { dispatchRunUsage } from "../../src/interactive/dispatch-board.js";
import { dockTop } from "../../src/interactive/dock.js";
import { exitSpend } from "../../src/interactive/exit-summary-collector.js";
import { footerTelemetry } from "../../src/interactive/footer/spend.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";
import { dtoLies } from "../harness/telemetry-lies.js";
import { coldParityDtos, PARITY_RUN, PARITY_SESSION, seedParitySession } from "../harness/telemetry-view.js";

let stateDir = "";
let model: LiveTelemetryModel;
let view: TelemetryView;
let cold: ReturnType<typeof coldParityDtos>;

before(async () => {
	stateDir = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-parity-"));
	await seedParitySession(stateDir);
	cold = coldParityDtos(stateDir);
	model = createLiveTelemetryModel({ stateDir: () => stateDir });
	model.bind(PARITY_SESSION);
	const seeded = new Promise<void>((resolve) =>
		model.subscribe("session", () => {
			if (model.live()?.seeding === false) resolve();
		}),
	);
	model.live();
	await seeded;
	const live = model.live();
	ok(live);
	view = live;
});

after(() => {
	model?.stop();
	if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

const timeless = (dto: unknown) =>
	JSON.parse(JSON.stringify(dto, (key, value: unknown) => (key === "generatedAt" ? undefined : value))) as unknown;
/** What a number-only surface may carry of a quantity: its measured and estimated part. */
const knownPart = (quantity: Quantity) =>
	"kind" in quantity.fact
		? quantity.fact.kind === "measured" || quantity.fact.kind === "estimated"
			? quantity.fact.value
			: 0
		: quantity.fact.measured + quantity.fact.estimated;
const estimated = (quantity: Quantity) =>
	"kind" in quantity.fact ? quantity.fact.kind === "estimated" : quantity.fact.coverage.estimated > 0;
const partial = (quantity: Quantity) =>
	"kind" in quantity.fact ? quantity.fact.kind === "unknown" : quantity.fact.unknownCount > 0;

test("the fixture carries every provenance a surface must keep: measured, estimated, unknown and a lower bound", () => {
	const { tokens, usd } = cold.session.totals;
	ok(estimated(usd) && partial(usd), usd.display);
	ok(partial(tokens), tokens.display);
	ok(/~/.test(usd.display) && /\+\?|≥/.test(usd.display), usd.display);
	ok(cold.runs.some((row) => row.runId === PARITY_RUN));
});

test("the CLI's --json and the GUI's DTOs are the live view's DTOs, byte for byte in value", () => {
	deepStrictEqual(timeless(view.session()), timeless(cold.session));
	deepStrictEqual(timeless(view.cost("model")), timeless(cold.costByModel));
	deepStrictEqual(timeless(view.calls()), timeless(cold.calls));
	deepStrictEqual(timeless(view.runs()), timeless(cold.runs));
	deepStrictEqual(JSON.parse(JSON.stringify(cold.session)), cold.session, "the JSON a surface serves loses nothing");
	// The session total and the cost report's total are one fact under one reference.
	deepStrictEqual(cold.costByModel.total.usd, cold.session.totals.usd);
	deepStrictEqual(cold.costByLabel.total.usd, cold.session.totals.usd);
	deepStrictEqual(cold.costByModel.total.tokens, cold.session.totals.tokens);
});

test("the footer and the exit card show the session's tokens and cost as the read model words them", () => {
	const { tokens, usd } = cold.session.totals;
	const footer = footerTelemetry(view);
	ok(footer.kind === "ready");
	strictEqual(footer.tokens, renderCompactCount(tokens.fact));
	strictEqual(footer.cost, usd.display);
	const card = exitSpend(view, "1970-01-01T00:00:00.000Z");
	ok(card.kind === "ready");
	strictEqual(card.tokens, tokens.display);
	strictEqual(card.cost, usd.display);
	deepStrictEqual(
		card.models.map((row) => [row.key, row.calls, row.cost]),
		cold.costByModel.groups.map((group) => [group.key, group.calls.display, group.usd.display]),
	);
});

test("/usage shows the session's tokens and cost, and /context the newest main call's cache facts, as the CLI reads them", () => {
	const tui = {
		terminal: { rows: 40 },
		requestRender() {},
		showOverlay() {
			return { hide() {} };
		},
	} as unknown as TUI;
	const telemetry = { live: () => view, subscribe: () => () => {} };
	const usage = openUsageOverlay(tui, { subscribe: () => () => {}, telemetry } as unknown as ObservabilityContract);
	try {
		const text = stripTerminalSequences(dockTop(tui)?.frame.renderDockBody(200, 30).join("\n") ?? "");
		ok(text.includes(cold.session.totals.usd.display), text);
		ok(text.includes(cold.session.totals.tokens.display), text);
	} finally {
		usage.hide();
	}
	const ledger = () =>
		buildContextLedger({
			provider: "fixture",
			model: "fixture",
			contextWindow: 32768,
			systemPromptTokens: 1200,
			toolSchemaTokens: 800,
			messageTokens: 1000,
			compactionThreshold: 0.9,
			compactionAuto: true,
		});
	const context = openContextOverlay(tui, ledger, { telemetry });
	try {
		const text = stripTerminalSequences(dockTop(tui)?.frame.renderDockBody(200, 60).join("\n") ?? "");
		const [newest] = cold.calls.calls.filter((call) => call.label === "main").slice(-1);
		ok(newest?.usage, "the newest main call settled with usage");
		ok(text.includes(`cache read ${newest.usage.cacheRead.display}`), text);
		ok(text.includes(`uncached prefill ${newest.cache.uncachedPrefill.display}`), text);
	} finally {
		context.hide();
	}
});

test("the dispatch board shows a run's tokens and cost as the same quantities the run report holds", () => {
	const usage = dispatchRunUsage(view, PARITY_RUN);
	ok(usage.kind === "ready");
	const row = cold.runs.find((run) => run.runId === PARITY_RUN);
	ok(row);
	deepStrictEqual(usage.total, row.tokens);
	deepStrictEqual(usage.usd, row.usd);
	ok(partial(usage.total), "the unpriced worker call keeps the run's tokens a lower bound");
});

test("ACP's v1 usage, its live totals and its telemetry methods carry the same value and provenance", async () => {
	const total = cold.costByModel.total;
	const v1 = sessionUsageV1(view);
	strictEqual(v1.cost.display, total.usd.display);
	strictEqual(v1.cost.knownUsd, knownPart(total.usd));
	strictEqual(v1.cost.estimated, estimated(total.usd));
	strictEqual(v1.cost.unknown, partial(total.usd));
	strictEqual(v1.tokens, knownPart(total.tokens));
	const live = sessionUsageTotals(view);
	strictEqual(live.costDisplay, cold.session.totals.usd.display);
	strictEqual(live.costSummary.knownUsd, knownPart(cold.session.totals.usd));
	strictEqual(live.costSummary.hasEstimated, estimated(cold.session.totals.usd));
	strictEqual(live.costSummary.hasUnknown, partial(cold.session.totals.usd));
	strictEqual(live.totalTokens, knownPart(cold.session.totals.tokens));
	const handlers = telemetryRequestHandlers({
		model,
		params: (params) => params as Record<string, unknown>,
		session: (request) => ({ id: request.sessionId as string }),
	});
	const served = async (method: string, params: Record<string, unknown> = {}) =>
		timeless(await handlers[method]?.({ sessionId: PARITY_SESSION, ...params }));
	deepStrictEqual(await served(ACP_TELEMETRY_METHODS.session), timeless(cold.session));
	deepStrictEqual(await served(ACP_TELEMETRY_METHODS.cost, { groupBy: "model" }), timeless(cold.costByModel));
});

test("no DTO the surfaces read tells a lie the detectors know (§13.1)", () => {
	for (const [name, dto] of Object.entries({
		session: view.session(),
		calls: view.calls(),
		costByModel: view.cost("model"),
		costByLabel: view.cost("label"),
		costByTurn: view.cost("turn"),
		cache: view.cache(),
		timeline: view.timeline(),
		whyStopped: view.whyStopped(),
		runs: view.runs(),
	}))
		deepStrictEqual(dtoLies(dto), [], name);
});

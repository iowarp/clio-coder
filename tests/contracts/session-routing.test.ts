import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	listRecentModels,
	recentModelsPath,
	rememberRecentModel,
	resetRecentModelsCache,
} from "../../src/core/recent-models.js";
import {
	applyRoutingPatch,
	applySessionRouting,
	diffRouting,
	externalRoutingDivergence,
	mergeRoutingPatchIntoSettings,
	type RoutingPatch,
	restoreRoutingFields,
	routingChangeNotices,
	type SessionRoutingState,
	seedSessionRouting,
} from "../../src/core/session-routing.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { applySettingChange, buildSettingItems } from "../../src/interactive/overlays/settings.js";

function settingsWithTargets(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.endpoints = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	settings.orchestrator = { endpoint: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.workers.default = { endpoint: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.scope = ["target-a/model-a", "target-b/model-b"];
	return settings;
}

/**
 * Simulates one running interactive session: a routing store seeded from the
 * shared file plus the write paths the orchestrator entry uses. `file` stands
 * in for settings.yaml; both sessions share the same object reference, which
 * is exactly the coupling the production code has through config.get().
 */
function simulateSession(file: { current: ClioSettings }) {
	const routing: SessionRoutingState = seedSessionRouting(file.current);
	return {
		routing,
		view: (): ClioSettings => applySessionRouting(file.current, routing),
		updateRouting(patch: RoutingPatch): void {
			applyRoutingPatch(routing, patch);
			const saved = structuredClone(file.current);
			mergeRoutingPatchIntoSettings(saved, patch);
			file.current = saved;
		},
		applySettingsBlob(next: ClioSettings): void {
			const patch = diffRouting(applySessionRouting(file.current, routing), next);
			if (patch) applyRoutingPatch(routing, patch);
			const persisted = structuredClone(next);
			restoreRoutingFields(persisted, file.current);
			if (patch) mergeRoutingPatchIntoSettings(persisted, patch);
			file.current = persisted;
		},
	};
}

describe("contracts/session-routing", () => {
	it("seeds session routing from saved settings and overlays it on the shared snapshot", () => {
		const saved = settingsWithTargets();
		const routing = seedSessionRouting(saved);
		deepStrictEqual(routing.orchestrator, { endpoint: "target-a", model: "model-a", thinkingLevel: "off" });
		deepStrictEqual(routing.workersDefault, { endpoint: "target-a", model: "model-a", thinkingLevel: "off" });
		deepStrictEqual(routing.scope, ["target-a/model-a", "target-b/model-b"]);

		// Shared (non-routing) fields track the snapshot; routing tracks the session.
		const externallyEdited = structuredClone(saved);
		externallyEdited.theme = "midnight";
		externallyEdited.orchestrator.model = "model-b";
		const view = applySessionRouting(externallyEdited, routing);
		strictEqual(view.theme, "midnight");
		strictEqual(view.orchestrator.model, "model-a");
	});

	it("keeps two concurrent sessions' live routing independent while sharing saved defaults", () => {
		const file = { current: settingsWithTargets() };
		const sessionA = simulateSession(file);
		const sessionB = simulateSession(file);

		// Session B selects a different chat target/model (Alt+L picker path).
		sessionB.updateRouting({ orchestrator: { endpoint: "target-b", model: "model-b" } });

		// B's next turn routes to target-b; A is untouched.
		strictEqual(sessionB.view().orchestrator.endpoint, "target-b");
		strictEqual(sessionA.view().orchestrator.endpoint, "target-a");
		strictEqual(sessionA.view().orchestrator.model, "model-a");
		// New sessions inherit B's choice as the saved default.
		strictEqual(file.current.orchestrator.endpoint, "target-b");

		// Session B raises thinking (Shift+Tab path); A's thinking is untouched.
		sessionB.updateRouting({ orchestrator: { thinkingLevel: "high" } });
		strictEqual(sessionA.view().orchestrator.thinkingLevel, "off");
		strictEqual(sessionB.view().orchestrator.thinkingLevel, "high");

		// Session B rewires the fleet default (/settings fleet rows); A's /run
		// target is untouched.
		sessionB.updateRouting({ workersDefault: { endpoint: "target-b", model: "model-b" } });
		strictEqual(sessionA.view().workers.default.endpoint, "target-a");
		strictEqual(sessionB.view().workers.default.endpoint, "target-b");

		// Session B narrows the Alt+J / Alt+K cycle set; A keeps its own.
		sessionB.updateRouting({ scope: ["target-b/model-b"] });
		deepStrictEqual(sessionA.view().scope, ["target-a/model-a", "target-b/model-b"]);
		deepStrictEqual(sessionB.view().scope, ["target-b/model-b"]);
	});

	it("writes through only the patched fields so sessions cannot clobber each other's saved defaults", () => {
		const file = { current: settingsWithTargets() };
		const sessionA = simulateSession(file);
		const sessionB = simulateSession(file);

		// A saves a new default model; B (still on the seeded routing) then
		// changes only its thinking level. B's write must not regress A's model.
		sessionA.updateRouting({ orchestrator: { endpoint: "target-b", model: "model-b" } });
		sessionB.updateRouting({ orchestrator: { thinkingLevel: "medium" } });

		strictEqual(file.current.orchestrator.endpoint, "target-b");
		strictEqual(file.current.orchestrator.model, "model-b");
		strictEqual(file.current.orchestrator.thinkingLevel, "medium");
	});

	it("absorbs routing edits from a whole-settings blob without leaking session routing on unrelated edits", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);
		// Another process moved the saved default; the session keeps its routing.
		const external = structuredClone(file.current);
		external.orchestrator.endpoint = "target-b";
		external.orchestrator.model = "model-b";
		file.current = external;
		strictEqual(session.view().orchestrator.endpoint, "target-a");

		// /settings edit to a non-routing field: persisting the blob (derived
		// from the effective view) must not overwrite the saved routing default
		// (target-b) with the session's live routing (target-a).
		const nonRoutingEdit = session.view();
		nonRoutingEdit.retry.maxRetries = 7;
		session.applySettingsBlob(nonRoutingEdit);
		strictEqual(file.current.retry.maxRetries, 7);
		strictEqual(file.current.orchestrator.endpoint, "target-b");
		strictEqual(session.view().orchestrator.endpoint, "target-a");

		// /settings edit to a routing field: applies to the session and becomes
		// the saved default.
		const routingEdit = session.view();
		routingEdit.workers.default.endpoint = "target-b";
		routingEdit.workers.default.model = "model-b";
		session.applySettingsBlob(routingEdit);
		strictEqual(session.view().workers.default.endpoint, "target-b");
		strictEqual(file.current.workers.default.endpoint, "target-b");
		// The untouched chat routing still did not leak into the file.
		strictEqual(file.current.orchestrator.endpoint, "target-b");
	});

	it("flags external routing divergence but stays silent for a session's own write-through", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);

		// Own write-through: changed paths carry the session's values.
		const beforeOwnWrite = structuredClone(file.current);
		session.updateRouting({ orchestrator: { thinkingLevel: "high" } });
		const ownDiff = diffSettings(beforeOwnWrite, file.current);
		deepStrictEqual(externalRoutingDivergence(ownDiff.nextTurn, file.current, session.view()), []);

		// External write: another process changes chat model and the scope list.
		const beforeExternal = structuredClone(file.current);
		const external = structuredClone(file.current);
		external.orchestrator.model = "model-b";
		external.scope = ["target-b/model-b"];
		file.current = external;
		const externalDiff = diffSettings(beforeExternal, file.current);
		const diverged = externalRoutingDivergence(externalDiff.nextTurn, file.current, session.view());
		ok(diverged.includes("chat model"), `expected chat model divergence, got: ${diverged.join(", ")}`);
		ok(diverged.includes("Alt+J/Alt+K scope"), `expected scope divergence, got: ${diverged.join(", ")}`);
		// The session's live routing is still its own.
		strictEqual(session.view().orchestrator.model, "model-a");
	});

	it("keeps the session's routing reference when the active target is removed externally", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);
		const external = structuredClone(file.current);
		external.endpoints = external.endpoints.filter((entry) => entry.id !== "target-a");
		external.orchestrator = { endpoint: "target-b", model: "model-b", thinkingLevel: "off" };
		file.current = external;

		// The view still names the session's target so resolution can fail with
		// an actionable message instead of silently jumping targets.
		const view = session.view();
		strictEqual(view.orchestrator.endpoint, "target-a");
		strictEqual(
			view.endpoints.some((entry) => entry.id === "target-a"),
			false,
		);
	});

	it("lists models for the newly selected target inside /settings (target-then-model)", () => {
		const live = { current: settingsWithTargets() };
		const providers = {
			list: () =>
				live.current.endpoints.map((endpoint) => ({
					endpoint,
					runtime: null,
					available: true,
					reason: "",
					health: "ok",
					capabilities: { chat: true, tools: true, reasoning: false },
					discoveredModels: endpoint.id === "target-a" ? ["model-a"] : ["model-b"],
				})),
			getDetectedReasoning: () => null,
			getEndpoint: (id: string) => live.current.endpoints.find((entry) => entry.id === id) ?? null,
		} as unknown as ProvidersContract;

		const items = buildSettingItems(live.current, { providers, getSettings: () => live.current });
		const modelItem = items.find((item) => item.id === "orchestrator.model");
		ok(modelItem?.submenu, "orchestrator.model row should expose a submenu");

		// User changes the target row first; the live settings now point at
		// target-b. The model submenu must list models for target-b, not the
		// snapshot captured when the overlay opened.
		const updated = structuredClone(live.current);
		updated.orchestrator.endpoint = "target-b";
		live.current = updated;

		const submenu = modelItem.submenu?.("model-a", () => undefined);
		notStrictEqual(submenu, undefined);
		const rendered = (submenu as { render(width: number): string[] }).render(80).join("\n");
		ok(rendered.includes("Select model for target-b"), `expected target-b model list, got:\n${rendered}`);
		ok(rendered.includes("model-b"), `expected model-b in list, got:\n${rendered}`);
	});

	it("re-derives dependent /settings rows after a target change (model + thinking)", () => {
		// Simulates the overlay's refreshRows contract: editing the target row
		// rebases the model on the new target's default, and a rebuilt row set
		// shows the new model everywhere instead of the stale snapshot.
		const settings = settingsWithTargets();
		applySettingChange(settings, "orchestrator.endpoint", "target-b");
		strictEqual(settings.orchestrator.endpoint, "target-b");
		strictEqual(settings.orchestrator.model, "model-b");

		applySettingChange(settings, "workers.default.endpoint", "target-b");
		strictEqual(settings.workers.default.model, "model-b");

		// Unsetting a target clears the model rather than leaving a dangling ref.
		applySettingChange(settings, "orchestrator.endpoint", "(unset)");
		strictEqual(settings.orchestrator.endpoint, null);
		strictEqual(settings.orchestrator.model, null);

		// Rebuilt rows pick up the live values, so the in-place row merge the
		// overlay performs has fresh data for every row, not just the edited one.
		const live = settingsWithTargets();
		applySettingChange(live, "orchestrator.endpoint", "target-b");
		const rows = buildSettingItems(live, { getSettings: () => live });
		strictEqual(rows.find((row) => row.id === "orchestrator.endpoint")?.currentValue, "target-b");
		strictEqual(rows.find((row) => row.id === "orchestrator.model")?.currentValue, "model-b");
	});

	it("builds the same routing notices for the TUI and the ACP ledger from one helper", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);

		// External model + scope change: divergence notice, with the slash-command
		// hint only on surfaces that can run slash commands.
		const before = structuredClone(file.current);
		const external = structuredClone(file.current);
		external.orchestrator.model = "model-b";
		external.scope = ["target-b/model-b"];
		file.current = external;
		const diff = diffSettings(before, file.current);
		const tui = routingChangeNotices(diff.nextTurn, file.current, session.view(), { commandHints: true });
		const acp = routingChangeNotices(diff.nextTurn, file.current, session.view());
		strictEqual(tui.length, 1);
		strictEqual(acp.length, 1);
		strictEqual(tui[0]?.kind, "external-divergence");
		ok(tui[0]?.text.includes("/settings"), `expected command hint, got: ${tui[0]?.text}`);
		ok(!acp[0]?.text.includes("/settings"), `expected no command hint, got: ${acp[0]?.text}`);

		// A session's own write-through produces no notices.
		const beforeOwn = structuredClone(file.current);
		session.updateRouting({ orchestrator: { thinkingLevel: "high" } });
		const ownDiff = diffSettings(beforeOwn, file.current);
		deepStrictEqual(routingChangeNotices(ownDiff.nextTurn, file.current, session.view()), []);

		// Removing the active target yields the warning-level notice.
		const beforeRemoval = structuredClone(file.current);
		const removed = structuredClone(file.current);
		removed.endpoints = removed.endpoints.filter((entry) => entry.id !== "target-a");
		removed.orchestrator = { endpoint: "target-b", model: "model-b", thinkingLevel: "off" };
		file.current = removed;
		const removalDiff = diffSettings(beforeRemoval, file.current);
		const notices = routingChangeNotices(removalDiff.nextTurn, file.current, session.view());
		const removal = notices.find((notice) => notice.kind === "active-target-removed");
		ok(removal, `expected active-target-removed, got: ${notices.map((n) => n.kind).join(", ")}`);
		strictEqual(removal?.level, "warning");
		ok(removal?.text.includes("target-a"), `expected target id in text, got: ${removal?.text}`);
	});
});

describe("contracts/session-routing recents", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch = "";

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-recents-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		resetRecentModelsCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
		resetRecentModelsCache();
	});

	it("stores recents in the data dir and never touches settings.yaml", () => {
		rememberRecentModel("target-a/model-a", 12);
		rememberRecentModel("target-b/model-b", 12);
		deepStrictEqual(listRecentModels(), ["target-b/model-b", "target-a/model-a"]);
		const onDisk = JSON.parse(readFileSync(recentModelsPath(), "utf8")) as string[];
		deepStrictEqual(onDisk, ["target-b/model-b", "target-a/model-a"]);
		// No settings.yaml was created or written by remembering a model.
		strictEqual(
			existsSync(join(scratch, "config", "settings.yaml")),
			false,
			"recents write must not create settings.yaml",
		);
	});

	it("migrates legacy state.recentModels once and keeps reading after", () => {
		const legacy = ["target-a/model-a", "target-b/model-b"];
		// First read with the legacy list and no data file seeds the file.
		deepStrictEqual(listRecentModels({ migrateFrom: legacy, limit: 12 }), legacy);
		const onDisk = JSON.parse(readFileSync(recentModelsPath(), "utf8")) as string[];
		deepStrictEqual(onDisk, legacy);
		// Later reads prefer the data file even when the (stale) legacy list differs.
		resetRecentModelsCache();
		deepStrictEqual(listRecentModels({ migrateFrom: ["target-a/other"], limit: 12 }), legacy);
	});

	it("enforces the recency limit and dedupes re-selected refs", () => {
		rememberRecentModel("a/1", 2);
		rememberRecentModel("a/2", 2);
		rememberRecentModel("a/1", 2);
		deepStrictEqual(listRecentModels({ limit: 2 }), ["a/1", "a/2"]);
		rememberRecentModel("a/3", 2);
		deepStrictEqual(listRecentModels({ limit: 2 }), ["a/3", "a/1"]);
	});

	it("treats a corrupted recents file as empty instead of resurrecting the legacy list", () => {
		rememberRecentModel("a/1", 12);
		writeFileSync(recentModelsPath(), "{not json", "utf8");
		resetRecentModelsCache();
		deepStrictEqual(listRecentModels({ migrateFrom: ["target-a/model-a"], limit: 12 }), []);
	});
});

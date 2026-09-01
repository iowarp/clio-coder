import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	applyOverrides,
	applyRoutingPatch,
	applySessionRouting,
	diffRouting,
	externalRoutingDivergence,
	getAtPath,
	isRoutingPath,
	mergeRoutingPatchIntoSettings,
	type RoutingPatch,
	restoreRoutingFields,
	routingChangeNotices,
	routingPatchForId,
	type SessionOverrides,
	type SessionRoutingState,
	seedSessionRouting,
	setAtPath,
} from "../../src/core/session-routing.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { applySettingChange, buildSettingItems } from "../../src/interactive/overlays/settings.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

function settingsWithTargets(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	Object.assign(settings.chat, { target: "target-a", model: "model-a", thinkingLevel: "off" });
	Object.assign(settings.context.memory, { target: "target-a", model: "model-a" });
	settings.fleet.default = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.chat.modelPicker.cycleSet = ["target-a/model-a", "target-b/model-b"];
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
		/**
		 * The scoped commit `/model` now goes through: "session" moves the live
		 * route only, "global" is the historical write-through.
		 */
		updateRoutingAtScope(patch: RoutingPatch, scope: "session" | "global"): void {
			if (scope === "global") {
				this.updateRouting(patch);
				return;
			}
			applyRoutingPatch(routing, patch);
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
		deepStrictEqual(routing.orchestrator, { target: "target-a", model: "model-a", thinkingLevel: "off" });
		deepStrictEqual(routing.background, { target: "target-a", model: "model-a" });
		deepStrictEqual(routing.workersDefault, { target: "target-a", model: "model-a", thinkingLevel: "off" });
		deepStrictEqual(routing.scope, ["target-a/model-a", "target-b/model-b"]);

		// Shared (non-routing) fields track the snapshot; routing tracks the session.
		const externallyEdited = structuredClone(saved);
		externallyEdited.interface.desktopNotifications = true;
		externallyEdited.chat.model = "model-b";
		const view = applySessionRouting(externallyEdited, routing);
		strictEqual(view.interface.desktopNotifications, true);
		strictEqual(view.chat.model, "model-a");
	});

	it("keeps two concurrent sessions' live routing independent while sharing saved defaults", () => {
		const file = { current: settingsWithTargets() };
		const sessionA = simulateSession(file);
		const sessionB = simulateSession(file);

		// Session B selects a different chat target/model (Alt+L picker path).
		sessionB.updateRouting({ orchestrator: { target: "target-b", model: "model-b" } });

		// B's next turn routes to target-b; A is untouched.
		strictEqual(sessionB.view().chat.target, "target-b");
		strictEqual(sessionA.view().chat.target, "target-a");
		strictEqual(sessionA.view().chat.model, "model-a");
		// New sessions inherit B's choice as the saved default.
		strictEqual(file.current.chat.target, "target-b");

		// Session B raises thinking (Shift+Tab path); A's thinking is untouched.
		sessionB.updateRouting({ orchestrator: { thinkingLevel: "high" } });
		strictEqual(sessionA.view().chat.thinkingLevel, "off");
		strictEqual(sessionB.view().chat.thinkingLevel, "high");

		// Session B rewires the fleet default (/settings fleet rows); A's /run
		// target is untouched.
		sessionB.updateRouting({ workersDefault: { target: "target-b", model: "model-b" } });
		strictEqual(sessionA.view().fleet.default.target, "target-a");
		strictEqual(sessionB.view().fleet.default.target, "target-b");

		// Background routing is a third independent role, not an alias for chat
		// or the fleet default.
		sessionB.updateRouting({ background: { target: "target-b", model: "model-b" } });
		strictEqual(sessionA.view().context.memory.target, "target-a");
		strictEqual(sessionB.view().context.memory.target, "target-b");
		strictEqual(sessionB.view().chat.target, "target-b");

		// Session B narrows the Alt+J / Alt+K cycle set; A keeps its own.
		sessionB.updateRouting({ scope: ["target-b/model-b"] });
		deepStrictEqual(sessionA.view().chat.modelPicker.cycleSet, ["target-a/model-a", "target-b/model-b"]);
		deepStrictEqual(sessionB.view().chat.modelPicker.cycleSet, ["target-b/model-b"]);
	});

	// G3 from smoke pass 2: a mid-conversation `/model` rewrote the orchestrator
	// role in settings.yaml with no prompt, so the next launch came up on a dead
	// endpoint. Session scope has to be a route that dies with the session.
	it("keeps a session-scoped model swap out of saved settings and applies a global one", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);

		session.updateRoutingAtScope({ orchestrator: { target: "target-b", model: "model-b" } }, "session");
		strictEqual(session.view().chat.target, "target-b", "the session routes to the new target");
		strictEqual(file.current.chat.target, "target-a", "settings.yaml is untouched");
		strictEqual(file.current.chat.model, "model-a");

		session.updateRoutingAtScope({ orchestrator: { target: "target-b", model: "model-b" } }, "global");
		strictEqual(session.view().chat.target, "target-b");
		strictEqual(file.current.chat.target, "target-b", "a global save is the next launch's default");
		strictEqual(file.current.chat.model, "model-b");
	});

	it("writes through only the patched fields so sessions cannot clobber each other's saved defaults", () => {
		const file = { current: settingsWithTargets() };
		const sessionA = simulateSession(file);
		const sessionB = simulateSession(file);

		// A saves a new default model; B (still on the seeded routing) then
		// changes only its thinking level. B's write must not regress A's model.
		sessionA.updateRouting({ orchestrator: { target: "target-b", model: "model-b" } });
		sessionB.updateRouting({ orchestrator: { thinkingLevel: "medium" } });

		strictEqual(file.current.chat.target, "target-b");
		strictEqual(file.current.chat.model, "model-b");
		strictEqual(file.current.chat.thinkingLevel, "medium");
	});

	it("absorbs routing edits from a whole-settings blob without leaking session routing on unrelated edits", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);
		// Another process moved the saved default; the session keeps its routing.
		const external = structuredClone(file.current);
		external.chat.target = "target-b";
		external.chat.model = "model-b";
		file.current = external;
		strictEqual(session.view().chat.target, "target-a");

		// /settings edit to a non-routing field: persisting the blob (derived
		// from the effective view) must not overwrite the saved routing default
		// (target-b) with the session's live routing (target-a).
		const nonRoutingEdit = session.view();
		nonRoutingEdit.chat.retry.maxRetries = 7;
		session.applySettingsBlob(nonRoutingEdit);
		strictEqual(file.current.chat.retry.maxRetries, 7);
		strictEqual(file.current.chat.target, "target-b");
		strictEqual(session.view().chat.target, "target-a");

		// /settings edit to a routing field: applies to the session and becomes
		// the saved default.
		const routingEdit = session.view();
		routingEdit.fleet.default.target = "target-b";
		routingEdit.fleet.default.model = "model-b";
		session.applySettingsBlob(routingEdit);
		strictEqual(session.view().fleet.default.target, "target-b");
		strictEqual(file.current.fleet.default.target, "target-b");
		// The untouched chat routing still did not leak into the file.
		strictEqual(file.current.chat.target, "target-b");
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
		external.chat.model = "model-b";
		external.chat.modelPicker.cycleSet = ["target-b/model-b"];
		file.current = external;
		const externalDiff = diffSettings(beforeExternal, file.current);
		const diverged = externalRoutingDivergence(externalDiff.nextTurn, file.current, session.view());
		ok(diverged.includes("chat model"), `expected chat model divergence, got: ${diverged.join(", ")}`);
		ok(diverged.includes("Alt+J/Alt+K cycle set"), `expected scope divergence, got: ${diverged.join(", ")}`);
		// The session's live routing is still its own.
		strictEqual(session.view().chat.model, "model-a");
	});

	it("keeps the session's routing reference when the active target is removed externally", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);
		const external = structuredClone(file.current);
		external.targets = external.targets.filter((entry) => entry.id !== "target-a");
		Object.assign(external.chat, { target: "target-b", model: "model-b", thinkingLevel: "off" });
		file.current = external;

		// The view still names the session's target so resolution can fail with
		// an actionable message instead of silently jumping targets.
		const view = session.view();
		strictEqual(view.chat.target, "target-a");
		strictEqual(
			view.targets.some((entry) => entry.id === "target-a"),
			false,
		);
	});

	it("lists models for the newly selected target inside /settings (target-then-model)", () => {
		const live = { current: settingsWithTargets() };
		const providers = {
			list: () =>
				live.current.targets.map((target) => ({
					target,
					runtime: null,
					available: true,
					reason: "",
					health: "ok",
					capabilities: { chat: true, tools: true, reasoning: false },
					discoveredModels: target.id === "target-a" ? ["model-a"] : ["model-b"],
				})),
			getDetectedReasoning: () => null,
			getTarget: (id: string) => live.current.targets.find((entry) => entry.id === id) ?? null,
		} as unknown as ProvidersContract;

		const items = buildSettingItems(live.current, { providers, getSettings: () => live.current });
		const modelItem = items.find((item) => item.id === "orchestrator.model");
		ok(modelItem?.submenu, "orchestrator.model row should expose a submenu");

		// User changes the target row first; the live settings now point at
		// target-b. The model submenu must list models for target-b, not the
		// snapshot captured when the overlay opened.
		const updated = structuredClone(live.current);
		updated.chat.target = "target-b";
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
		applySettingChange(settings, "orchestrator.target", "target-b");
		strictEqual(settings.chat.target, "target-b");
		strictEqual(settings.chat.model, "model-b");

		applySettingChange(settings, "workers.default.target", "target-b");
		strictEqual(settings.fleet.default.model, "model-b");

		// Unsetting a target clears the model rather than leaving a dangling ref.
		applySettingChange(settings, "orchestrator.target", "(unset)");
		strictEqual(settings.chat.target, null);
		strictEqual(settings.chat.model, null);

		// Rebuilt rows pick up the live values, so the in-place row merge the
		// overlay performs has fresh data for every row, not just the edited one.
		const live = settingsWithTargets();
		applySettingChange(live, "orchestrator.target", "target-b");
		const rows = buildSettingItems(live, { getSettings: () => live });
		strictEqual(rows.find((row) => row.id === "orchestrator.target")?.currentValue, "target-b");
		strictEqual(rows.find((row) => row.id === "orchestrator.model")?.currentValue, "model-b");
	});

	it("builds the same routing notices for the TUI and the ACP ledger from one helper", () => {
		const file = { current: settingsWithTargets() };
		const session = simulateSession(file);

		// External model + scope change: divergence notice, with the slash-command
		// hint only on surfaces that can run slash commands.
		const before = structuredClone(file.current);
		const external = structuredClone(file.current);
		external.chat.model = "model-b";
		external.chat.modelPicker.cycleSet = ["target-b/model-b"];
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
		removed.targets = removed.targets.filter((entry) => entry.id !== "target-a");
		Object.assign(removed.chat, { target: "target-b", model: "model-b", thinkingLevel: "off" });
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

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-recents-");
		resetRecentModelsCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
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

	it("treats an absent recents file as an empty list", () => {
		deepStrictEqual(listRecentModels({ limit: 12 }), []);
	});

	it("enforces the recency limit and dedupes re-selected refs", () => {
		rememberRecentModel("a/1", 2);
		rememberRecentModel("a/2", 2);
		rememberRecentModel("a/1", 2);
		deepStrictEqual(listRecentModels({ limit: 2 }), ["a/1", "a/2"]);
		rememberRecentModel("a/3", 2);
		deepStrictEqual(listRecentModels({ limit: 2 }), ["a/3", "a/1"]);
	});

	it("treats a corrupted recents file as empty", () => {
		rememberRecentModel("a/1", 12);
		writeFileSync(recentModelsPath(), "{not json", "utf8");
		resetRecentModelsCache();
		deepStrictEqual(listRecentModels({ limit: 12 }), []);
	});
});

describe("contracts/session-routing overrides", () => {
	it("reads and writes leaves by dotted object path and deletes on undefined", () => {
		const settings = settingsWithTargets();
		strictEqual(getAtPath(settings, "context.compaction.threshold"), settings.context.compaction.threshold);
		strictEqual(getAtPath(settings, "integrations.externalAgents.defaults.connectTimeoutMs"), 30000);
		strictEqual(getAtPath(settings, "missing.key"), undefined);

		setAtPath(settings, "fleet.concurrency", 4);
		strictEqual(settings.fleet.concurrency, 4);
		settings.context.compaction.model = "x/y";
		setAtPath(settings, "context.compaction.model", undefined);
		strictEqual("model" in settings.context.compaction, false);
	});

	it("marks only the routing surface as routing paths", () => {
		for (const path of ["chat.target", "context.memory.model", "fleet.default.model", "chat.modelPicker.cycleSet"]) {
			ok(isRoutingPath(path), `${path} is routing`);
		}
		for (const path of ["fleet.retry.maxRetries", "fleet.concurrency", "context.compaction.auto", "safety.autonomy"]) {
			ok(!isRoutingPath(path), `${path} is not routing`);
		}
	});

	it("overlays session overrides on the shared snapshot without mutating it", () => {
		const base = settingsWithTargets();
		const overrides: SessionOverrides = new Map<string, unknown>([
			["safety.autonomy", "full-auto"],
			["chat.retry.maxRetries", 8],
		]);
		const view = applyOverrides(base, overrides);
		strictEqual(view.safety.autonomy, "full-auto");
		strictEqual(view.chat.retry.maxRetries, 8);
		// the shared snapshot is untouched: the override is session-local
		strictEqual(base.safety.autonomy, "auto-edit");
		strictEqual(base.chat.retry.maxRetries, DEFAULT_SETTINGS.chat.retry.maxRetries);
	});

	it("returns the base object unchanged when there are no overrides", () => {
		const base = settingsWithTargets();
		strictEqual(applyOverrides(base, new Map()), base);
	});

	it("derives a minimal routing patch per edited id, carrying a rebased model on target change", () => {
		const settings = settingsWithTargets();
		Object.assign(settings.chat, { target: "target-b", model: "model-b", thinkingLevel: "high" });
		deepStrictEqual(routingPatchForId("chat.target", settings), {
			orchestrator: { target: "target-b", model: "model-b" },
		});
		deepStrictEqual(routingPatchForId("chat.thinkingLevel", settings), {
			orchestrator: { thinkingLevel: "high" },
		});
		Object.assign(settings.context.memory, { target: "target-b", model: "model-b" });
		deepStrictEqual(routingPatchForId("context.memory.target", settings), {
			background: { target: "target-b", model: "model-b" },
		});
		deepStrictEqual(routingPatchForId("chat.modelPicker.cycleSet", settings), {
			scope: settings.chat.modelPicker.cycleSet,
		});
		strictEqual(routingPatchForId("safety.autonomy", settings), null);
	});

	it("globalizes a routing edit even after it was applied to the session", () => {
		// Mirrors the orchestrator commit path: a session-only apply moves the
		// routing state first, so a later diff would be empty; routingPatchForId
		// must still produce the patch that the global save persists.
		const file = { current: settingsWithTargets() };
		const routing: SessionRoutingState = seedSessionRouting(file.current);
		const next = structuredClone(file.current);
		Object.assign(next.chat, { target: "target-b", model: "model-b", thinkingLevel: "off" });

		// session apply
		const patch = routingPatchForId("chat.target", next);
		ok(patch, "routing id yields a patch");
		applyRoutingPatch(routing, patch);
		strictEqual(applySessionRouting(file.current, routing).chat.target, "target-b");
		// the file (global default) is still untouched
		strictEqual(file.current.chat.target, "target-a");

		// global save of the same edit, after the session already moved
		const saved = structuredClone(file.current);
		mergeRoutingPatchIntoSettings(saved, routingPatchForId("chat.target", next) as RoutingPatch);
		file.current = saved;
		strictEqual(file.current.chat.target, "target-b");
		strictEqual(file.current.chat.model, "model-b");
	});

	it("a global save supersedes a prior session override on the same leaf", () => {
		// Session-only override, then global save of the same leaf: the override
		// is cleared and the file becomes authoritative.
		const overrides: SessionOverrides = new Map<string, unknown>([["chat.retry.maxRetries", 8]]);
		const file = { current: settingsWithTargets() };
		// global save path: persist the leaf, drop the override
		setAtPath(file.current, "chat.retry.maxRetries", 5);
		overrides.delete("chat.retry.maxRetries");
		const view = applyOverrides(file.current, overrides);
		strictEqual(view.chat.retry.maxRetries, 5);
		strictEqual(overrides.size, 0);
	});
});

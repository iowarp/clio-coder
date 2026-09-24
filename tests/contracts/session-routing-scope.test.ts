import assert from "node:assert/strict";
import { test } from "node:test";
import { type ClioSettings, updateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { loadDomains } from "../../src/core/domain-loader.js";
import {
	commitRoutingPatch,
	createRoutingGestures,
	planResumedRouting,
	type RoutingPatch,
	routingPatchForId,
	seedSessionRouting,
} from "../../src/core/session-routing.js";
import { ConfigDomainModule } from "../../src/domains/config/index.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { createProvidersDomainModule, type ProvidersContract } from "../../src/domains/providers/index.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { resumedSessionRoute } from "../../src/domains/session/resumed-route.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function twoTargetSettings(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "alpha", runtime: "openai-compat", url: "http://127.0.0.1:1/v1", defaultModel: "alpha-default" },
		{ id: "beta", runtime: "openai-compat", url: "http://127.0.0.1:2/v1", defaultModel: "beta-default" },
	];
	settings.chat.target = "alpha";
	settings.chat.model = "alpha-default";
	settings.chat.thinkingLevel = "off";
	settings.context.memory.target = "alpha";
	settings.context.memory.model = "alpha-default";
	settings.fleet.default.target = "alpha";
	settings.fleet.default.model = "alpha-default";
	return settings;
}

function entry(fields: Record<string, unknown>): SessionEntry {
	return { turnId: `t-${Math.random()}`, parentTurnId: null, timestamp: "2026-09-23T00:00:00.000Z", ...fields } as never;
}

test("a model-only settings save carries the target the model was picked on", () => {
	const settings = twoTargetSettings();
	settings.chat.target = "beta";
	settings.chat.model = "beta-large";
	settings.context.memory.target = "beta";
	settings.context.memory.model = "beta-small";
	settings.fleet.default.target = "beta";
	settings.fleet.default.model = "beta-worker";
	// A global save merges only the patched fields into settings.yaml, so a
	// model without its target paired the file's target with a model it never had.
	assert.deepEqual(routingPatchForId("chat.model", settings), {
		orchestrator: { target: "beta", model: "beta-large" },
	});
	assert.deepEqual(routingPatchForId("context.memory.model", settings), {
		background: { target: "beta", model: "beta-small" },
	});
	assert.deepEqual(routingPatchForId("fleet.default.model", settings), {
		workersDefault: { target: "beta", model: "beta-worker" },
	});
	assert.deepEqual(
		routingPatchForId("chat.thinkingLevel", { ...settings, chat: { ...settings.chat, thinkingLevel: "high" } }),
		{
			orchestrator: { thinkingLevel: "high" },
		},
	);
});

test("a global save that fails leaves the live route where it was", () => {
	const routing = seedSessionRouting(twoTargetSettings());
	const before = structuredClone(routing);
	const changes: string[] = [];
	const patch: RoutingPatch = { orchestrator: { target: "beta", model: "beta-default", thinkingLevel: "high" } };
	assert.throws(
		() =>
			commitRoutingPatch(
				routing,
				patch,
				() => {
					changes.push(`persist:${routing.orchestrator.target}`);
					throw new Error("a higher-precedence project setting prevents this settings update");
				},
				() => changes.push(`change:${routing.orchestrator.target}`),
			),
		/higher-precedence project setting/,
	);
	assert.deepEqual(routing, before);
	// Consumers see the move and then the rollback, so a projection refreshed in
	// between never keeps the route nothing saved.
	assert.deepEqual(changes, ["change:beta", "persist:beta", "change:alpha"]);

	commitRoutingPatch(
		routing,
		patch,
		() => {},
		() => {},
	);
	assert.equal(routing.orchestrator.target, "beta");
	assert.equal(routing.orchestrator.thinkingLevel, "high");
});

test("keyboard routing gestures move only the session that pressed them", () => {
	const applied: Array<{ patch: RoutingPatch; scope: string }> = [];
	const gestures = createRoutingGestures({
		nextThinkingLevel: () => "high",
		nextScopedTarget: (direction) =>
			direction === "forward" ? { target: "beta", model: "beta-default" } : { target: "alpha", model: null },
		apply: (patch, scope) => applied.push({ patch, scope }),
	});
	gestures.cycleThinking();
	assert.equal(gestures.cycleScopedModel("forward"), true);
	assert.equal(gestures.cycleScopedModel("backward"), true);
	assert.deepEqual(applied, [
		{ patch: { orchestrator: { thinkingLevel: "high" } }, scope: "session" },
		{ patch: { orchestrator: { target: "beta", model: "beta-default" } }, scope: "session" },
		{ patch: { orchestrator: { target: "alpha", model: null } }, scope: "session" },
	]);

	const empty = createRoutingGestures({
		nextThinkingLevel: () => "off",
		nextScopedTarget: () => null,
		apply: () => assert.fail("an empty scope list must not move the route"),
	});
	assert.equal(empty.cycleScopedModel("forward"), false);
});

test("a resumed session's route is the last one it recorded", () => {
	const meta = { target: "alpha", model: "alpha-default" };
	assert.deepEqual(resumedSessionRoute(meta, []), { target: "alpha", model: "alpha-default" });
	assert.deepEqual(
		resumedSessionRoute(meta, [
			entry({ kind: "message", role: "user", payload: { text: "hi" } }),
			entry({ kind: "modelChange", provider: "openai-compat", modelId: "alpha-large", target: "alpha" }),
			entry({ kind: "thinkingLevelChange", thinkingLevel: "medium" }),
			entry({ kind: "modelChange", provider: "openai-compat", modelId: "beta-default", target: "beta" }),
			entry({ kind: "thinkingLevelChange", thinkingLevel: "high" }),
		]),
		{ target: "beta", model: "beta-default", thinkingLevel: "high" },
	);
	// A pre-target row names a runtime, not a target, so it cannot say which
	// target the model belonged to; it is skipped rather than guessed at.
	assert.deepEqual(
		resumedSessionRoute(meta, [
			entry({ kind: "modelChange", provider: "openai-compat", modelId: "orphan-model" }),
			entry({ kind: "thinkingLevelChange", thinkingLevel: "not-a-level" }),
		]),
		{ target: "alpha", model: "alpha-default" },
	);
	assert.deepEqual(resumedSessionRoute({ target: null, model: null }, []), { target: null, model: null });
});

test("resume plans a session-only route change and names a target that is gone", () => {
	const settings = twoTargetSettings();
	assert.deepEqual(planResumedRouting({ target: "beta", model: "beta-default", thinkingLevel: "high" }, settings), {
		patch: { orchestrator: { target: "beta", model: "beta-default", thinkingLevel: "high" } },
		notice: null,
	});
	assert.deepEqual(planResumedRouting({ target: "alpha", model: "alpha-default" }, settings), {
		patch: null,
		notice: null,
	});
	assert.deepEqual(planResumedRouting({ target: null, model: null }, settings), { patch: null, notice: null });

	const gone = planResumedRouting({ target: "gamma", model: "gamma-model", thinkingLevel: "low" }, settings);
	assert.deepEqual(gone.patch, { orchestrator: { thinkingLevel: "low" } });
	assert.match(gone.notice ?? "", /gamma\/gamma-model/);
	assert.match(gone.notice ?? "", /alpha\/alpha-default/);

	// Explicit CLI flags beat the recorded route, field by field.
	assert.deepEqual(
		planResumedRouting({ target: "beta", model: "beta-default", thinkingLevel: "high" }, settings, {
			route: true,
		}),
		{ patch: { orchestrator: { thinkingLevel: "high" } }, notice: null },
	);
	assert.deepEqual(
		planResumedRouting({ target: "beta", model: "beta-default", thinkingLevel: "high" }, settings, {
			thinking: true,
		}),
		{ patch: { orchestrator: { target: "beta", model: "beta-default" } }, notice: null },
	);
});

test("a thinking change is recorded in the session it took effect in", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	assert.ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	settings.chat.thinkingLevel = "off";
	const appended: Array<Record<string, unknown>> = [];
	let current: SessionMeta | null = null;
	let turns = 0;
	const session = {
		current: () => current,
		create: (input?: { cwd?: string; model?: string; target?: string }) => {
			current = {
				id: "session-thinking",
				cwd: input?.cwd ?? process.cwd(),
				cwdHash: "hash",
				createdAt: "2026-09-23T00:00:00.000Z",
				endedAt: null,
				model: input?.model ?? null,
				target: input?.target ?? null,
			} as SessionMeta;
			return current;
		},
		append: (turn: Record<string, unknown>) => ({ ...turn, id: `turn-${++turns}`, at: "2026-09-23T00:00:00.000Z" }),
		appendEntry: (entry: Record<string, unknown>) => {
			appended.push(entry);
			return entry;
		},
		checkpoint: async () => {},
		flushAppends: () => {},
		replaceEntries: () => {},
		tree: () => ({ leafId: null, nodes: [] }),
	} as unknown as SessionContract;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			agent: {
				state: options?.initialState,
				subscribe: () => () => {},
				abort() {},
				async prompt() {},
			},
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	const thinkingRows = (): unknown[] =>
		appended.filter((row) => row.kind === "thinkingLevelChange").map((row) => row.thinkingLevel);
	try {
		await loop.submit("first");
		// The level a session started at is the one it was created under; only a
		// change needs a row, exactly like modelChange.
		assert.deepEqual(thinkingRows(), []);
		settings.chat.thinkingLevel = "high";
		await loop.submit("second");
		assert.deepEqual(thinkingRows(), ["high"]);
		await loop.submit("third");
		assert.deepEqual(thinkingRows(), ["high"]);
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
});

test("a live probe exercises the session's chat model, not the one another session saved", async () => {
	const env = await isolateClioEnv("clio-coder-probe-route-");
	const registry = getRuntimeRegistry();
	const previous = registry.list();
	const probed: string[] = [];
	try {
		registry.register({
			id: "route-probe-fixture",
			displayName: "Route probe fixture",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { chat: true },
			probe: async () => ({ ok: true }),
			probeReasoning: async (_target: unknown, modelId: string) => {
				probed.push(modelId);
				return { reasoning: false };
			},
			synthesizeModel: (_target: unknown, wireModelId: string) => ({ id: wireModelId }),
		} as never);
		ensureClioState();
		updateSettings((settings) => {
			settings.targets = [
				{ id: "probe", runtime: "route-probe-fixture", url: "http://127.0.0.1:9/v1", defaultModel: "probe-default" },
			];
			settings.chat.target = "probe";
			settings.chat.model = "saved-by-another-session";
		});
		let session: ClioSettings | undefined;
		const loaded = await loadDomains([ConfigDomainModule, createProvidersDomainModule({ getSettings: () => session })]);
		try {
			const providers = loaded.getContract<ProvidersContract>("providers");
			assert.ok(providers);
			session = structuredClone(loaded.getContract<{ get(): ClioSettings }>("config")?.get());
			assert.ok(session);
			session.chat.model = "this-session-model";
			await providers.probeTarget("probe", { reasoning: true });
			assert.deepEqual(probed, ["this-session-model"]);
		} finally {
			await loaded.stop();
		}
	} finally {
		registry.clear();
		for (const descriptor of previous) registry.register(descriptor);
		env.restore();
	}
});

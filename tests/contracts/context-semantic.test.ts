import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { installDiagnosticSink } from "../../src/core/diagnostics.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SemanticHit, SemanticRecord, SemanticSearchResult } from "../../src/domains/semantic/index.js";
import { SemanticIndex, sourceHash } from "../../src/domains/semantic/index.js";
import { createSemanticBackgroundRefresh } from "../../src/domains/semantic-app/background.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import type { ContextSemanticRequest } from "../../src/tools/context/index.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { commitObservationReservation, releaseObservation, reserveObservation } from "../../src/tools/observation.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let isolated: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	isolated = await isolateClioEnv("context-semantic-");
});
afterEach(() => isolated.restore());
function result(hits: SemanticHit[] = []): SemanticSearchResult {
	return {
		hits,
		generation: "generation",
		profileKey: sourceHash("fixture-profile"),
		indexedAt: "2026-10-07T00:00:00Z",
		pending: false,
		truncated: false,
	};
}
function hit(id: string): SemanticHit {
	return {
		id,
		sourceId: id,
		kind: "code",
		path: join(isolated.dir, `${id}.ts`),
		location: { line: 7 },
		excerpt: "retry after checkpoint",
		score: 1,
		method: "hybrid",
		mediaType: "text/plain",
	};
}

test("background failures before checkpoint report diagnostics, coalesce work and retain the generation", {
	timeout: 5000,
}, async (t) => {
	const { openSemanticApp, statusSemantic } = await import("../../src/domains/semantic-app/index.js");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "embedding", runtime: "litellm", url: "http://fixture.invalid" }];
	Object.assign(settings.context.semantic, {
		enabled: true,
		background: true,
		target: "embedding",
		model: "gemma",
		assetIdentity: "fixture",
	});
	t.mock.method(globalThis, "fetch", () => {
		throw new Error("background regression must not call a provider");
	});
	const options = { projectRoot: isolated.dir, settings, offline: true };
	const app = await openSemanticApp(options);
	await app.index.refresh([]);
	const before = await statusSemantic(options);
	const unavailable = { ...settings, targets: [] };
	const background = createSemanticBackgroundRefresh(() => unavailable);
	t.after(() => background.stop());
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const diagnostics: Array<{ text: string; level: string }> = [];
	let reported!: () => void;
	const reporting = new Promise<void>((resolve) => {
		reported = resolve;
	});
	const missingRoot = join(isolated.dir, "missing-project");
	const uninstall = installDiagnosticSink((text, level) => {
		diagnostics.push({ text, level });
		if (diagnostics.length === 1) {
			background.schedule(isolated.dir);
			background.schedule(missingRoot);
		} else reported();
	});
	t.after(uninstall);
	background.schedule(isolated.dir);
	t.mock.timers.tick(750);
	await reporting;
	await background.stop();
	assert.equal(diagnostics.length, 2);
	assert.match(
		diagnostics[0]?.text ?? "",
		/Semantic background refresh failed: Semantic target embedding is not configured/,
	);
	assert.match(diagnostics[1]?.text ?? "", /ENOENT/);
	assert((diagnostics[1]?.text ?? "").includes(missingRoot));
	assert(diagnostics.every(({ level }) => level === "warning"));
	assert.deepEqual(await statusSemantic(options), before);
	const cancelled = createSemanticBackgroundRefresh(() => unavailable);
	cancelled.schedule(isolated.dir);
	t.mock.timers.tick(750);
	await cancelled.stop();
	cancelled.schedule(missingRoot);
	t.mock.timers.tick(750);
	assert.equal(diagnostics.length, 2, "shutdown cancellation and post-stop edits stay quiet");
	const racing = createSemanticBackgroundRefresh(() => unavailable);
	let stopped!: Promise<void>;
	const routeReached = new Promise<void>((resolve) => {
		unavailable.targets.find = () => {
			queueMicrotask(() => {
				stopped = racing.stop();
				resolve();
			});
			return undefined;
		};
	});
	racing.schedule(isolated.dir);
	t.mock.timers.tick(750);
	await routeReached;
	await stopped;
	assert.equal(diagnostics.length, 3, "shutdown after a route failure cannot hide that failure");
	assert.match(diagnostics[2]?.text ?? "", /Semantic target embedding is not configured/);
});

test("disabled and unbound semantic mode is inert, including core-bootstrap's settings gate", async () => {
	let loads = 0;
	const tool = createContextTool({
		getCwd: () => {
			throw new Error("disabled cwd must stay unread");
		},
		semantic: {
			isEnabled: () => false,
			loadSearch: async () => {
				loads++;
				return async () => result();
			},
		},
	});
	const disabled = await tool.run({ scope: "semantic", query: "retry" }, {});
	assert.equal(disabled.kind, "error");
	if (disabled.kind === "error") assert.match(disabled.message, /disabled.*code_nav/);
	assert.equal(loads, 0);
	assert.equal((await createContextTool().run({ scope: "semantic", query: "retry" }, {})).kind, "error");
	const registry = createRegistry({ safety: createWorkerSafety() });
	registerCoreTools(registry, { getSettings: () => DEFAULT_SETTINGS });
	const registered = registry.get(ToolNames.Context);
	assert(registered);
	assert.equal((await registered.run({ scope: "semantic", query: "retry" }, {})).kind, "error");
});

test("enabled searches load lazily and forward only narrowed filters, trusted cwd and cancellation", async () => {
	let loads = 0;
	let received: ContextSemanticRequest | undefined;
	const tool = createContextTool({
		getCwd: () => isolated.dir,
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => {
				loads++;
				return async (request, context) => {
					received = request;
					assert.equal(context.cwd, isolated.dir);
					assert(context.signal instanceof AbortSignal);
					assert.equal(typeof context.allowsPath, "function");
					return result([hit("retry")]);
				};
			},
		},
	});
	assert.equal(loads, 0);
	await tool.run({ scope: "budget" }, {});
	assert.equal(loads, 0);
	const searched = await tool.run(
		{
			scope: "semantic",
			query: " retry ",
			limit: 3,
			kinds: ["code"],
			run_id: "run-7",
			media_type: "text/plain",
			after: "2026-10-01",
			before: "2026-10-07",
		},
		{},
	);
	assert.equal(loads, 1);
	assert.deepEqual(received, {
		query: "retry",
		limit: 3,
		kinds: ["code"],
		runId: "run-7",
		mediaType: "text/plain",
		after: "2026-10-01T00:00:00.000Z",
		before: "2026-10-07T23:59:59.999Z",
	});
	assert.equal(searched.kind, "ok");
	if (searched.kind === "ok") {
		const payload = JSON.parse(searched.output);
		assert.equal(payload.hits[0].location.line, 7);
		assert.match(payload.followUp, /Inspect originals/);
	}
});

test("semantic validation rejects ownership overrides, invalid bounds and dates before resolving the bridge", async () => {
	let loads = 0;
	const tool = createContextTool({
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => {
				loads++;
				return async () => result();
			},
		},
	});
	for (const invalid of [
		{},
		{ query: " " },
		{ query: "x".repeat(2001) },
		{ query: "retry", limit: 0 },
		{ query: "retry", limit: 21 },
		{ query: "retry", limit: 1.5 },
		{ query: "retry", kinds: ["credentials"] },
		{ query: "retry", projectId: "foreign" },
		{ query: "retry", includeGlobal: true },
		{ query: "retry", includePrivate: true },
		{ query: "retry", eligibleMemoryIds: ["revoked"] },
		{ query: "retry", after: "2026-02-30" },
		{ query: "retry", after: "2026-10-07", before: "2026-10-01" },
	])
		assert.equal((await tool.run({ scope: "semantic", ...invalid }, {})).kind, "error");
	assert.equal(loads, 0);
});

test("bootstrap preserves an injected lazy semantic bridge and does not load it at registration", async () => {
	let loads = 0;
	const registry = createRegistry({ safety: createWorkerSafety() });
	registerCoreTools(registry, {
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => {
				loads++;
				return async () => result([hit("registered")]);
			},
		},
	});
	assert.equal(loads, 0);
	const tool = registry.get(ToolNames.Context);
	assert(tool);
	const searched = await tool.run({ scope: "semantic", query: "retry" }, {});
	assert.equal(searched.kind, "ok");
	assert.equal(loads, 1);
});

test("shared observation exhaustion prevents loading or inference, and backend errors are retryable", async () => {
	let loads = 0;
	const tool = createContextTool({
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => {
				loads++;
				if (loads === 1) throw new Error("index unavailable");
				return async () => result();
			},
		},
	});
	const options = { sessionId: isolated.dir, turnId: "exhausted" };
	const reservation = reserveObservation(Number.MAX_SAFE_INTEGER, options);
	commitObservationReservation(reservation);
	try {
		await tool.run({ scope: "semantic", query: "retry" }, options);
		assert.equal(loads, 0);
	} finally {
		releaseObservation(reservation);
	}
	const failed = await tool.run({ scope: "semantic", query: "retry" }, {});
	assert.equal(failed.kind, "error");
	if (failed.kind === "error") assert.match(failed.message, /index unavailable/);
	assert.equal((await tool.run({ scope: "semantic", query: "retry" }, {})).kind, "ok");
	assert.equal(loads, 2);
});

test("cancellation aborts a pending search and disabling during search prevents disclosure", async () => {
	let enabled = true;
	let entered: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let complete: ((value: SemanticSearchResult) => void) | undefined;
	const pending = new Promise<SemanticSearchResult>((resolve) => {
		complete = resolve;
	});
	const tool = createContextTool({
		semantic: {
			isEnabled: () => enabled,
			loadSearch: async () => async () => {
				entered?.();
				return pending;
			},
		},
	});
	const searching = tool.run({ scope: "semantic", query: "retry" }, {});
	await started;
	enabled = false;
	complete?.(result([hit("revoked")]));
	const revoked = await searching;
	assert.equal(revoked.kind, "error");
	assert(!JSON.stringify(revoked).includes("revoked.ts"));
	let searchSignal: AbortSignal | undefined;
	let enteredAbort: (() => void) | undefined;
	const abortStarted = new Promise<void>((resolve) => {
		enteredAbort = resolve;
	});
	const cancellable = createContextTool({
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => async (_request, context) => {
				searchSignal = context.signal;
				enteredAbort?.();
				return new Promise(() => {});
			},
		},
	});
	const controller = new AbortController();
	const running = cancellable.run({ scope: "semantic", query: "retry" }, { signal: controller.signal });
	await abortStarted;
	controller.abort();
	assert.equal((await running).kind, "error");
	assert.equal(searchSignal?.aborted, true);
});

test("bridge scope and current memory eligibility protect results; registry path policy is repeated before output", async () => {
	const profile = { id: "fixture", dimensions: 2, profileIdentity: sourceHash("fixture"), identity: { fixture: true } };
	const index = new SemanticIndex({
		projectId: "project-a",
		profile,
		cacheDir: isolated.dir,
		embed: async (inputs) => ({ profileKey: profile.profileIdentity, vectors: inputs.map(() => [1, 0]) }),
	});
	const record = (id: string): SemanticRecord => ({
		...hit(id),
		projectId: "project-a",
		scope: "project",
		visibility: "project",
		text: "retry",
		input: { kind: "text", text: "retry" },
		contentHash: sourceHash(id),
		extractionVersion: "fixture",
	});
	await index.refresh([
		record("visible"),
		record("protected"),
		{ ...record("global"), scope: "global", visibility: "global" },
		{ ...record("private"), visibility: "private" },
		{ ...record("memory"), kind: "memory", memoryId: "revoked" },
	]);
	const generation = index.status().generation;
	let appends = 0;
	const tool = createContextTool({
		getCwd: () => isolated.dir,
		session: {
			hasSession: () => true,
			readEntries: () => [],
			activeLeafTurnId: () => undefined,
			appendEntry: () => {
				appends++;
				throw new Error("no prompt/session injection");
			},
		},
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => async (request) =>
				index.searchVector(request.query, undefined, { ...request, projectId: "project-a", eligibleMemoryIds: [] }),
		},
	});
	const searched = await tool.run(
		{ scope: "semantic", query: "retry", limit: 20 },
		{ allowsObservationPath: (path) => !path.endsWith("protected.ts") },
	);
	assert.equal(searched.kind, "ok");
	if (searched.kind === "ok")
		assert.deepEqual(
			JSON.parse(searched.output).hits.map((item: SemanticHit) => item.id),
			["visible"],
		);
	assert.equal(index.status().generation, generation);
	assert.equal(appends, 0);
});

test("evidence candidates tell the agent which authorized bundle to inspect", async () => {
	const tool = createContextTool({
		getCwd: () => isolated.dir,
		semantic: {
			isEnabled: () => true,
			loadSearch: async () => async () =>
				result([
					{
						...hit("historical"),
						kind: "evidence",
						evidenceId: "run-history",
						path: join(isolated.dir, "evidence", "run-history", "transcript.md"),
					},
				]),
		},
	});
	const searched = await tool.run({ scope: "semantic", query: "checkpoint" }, { allowsObservationPath: () => true });
	assert.equal(searched.kind, "ok");
	if (searched.kind === "ok") {
		const payload = JSON.parse(searched.output);
		assert.equal(payload.hits[0].evidenceId, "run-history");
		assert.match(payload.followUp, /evidence\(mode=inspect,id=hit\.evidenceId\)/);
	}
});

test("tool projects only bounded candidate fields and preserves valid JSON when output is capped", async () => {
	const hits = Array.from({ length: 20 }, (_, i) => ({
		...hit(`candidate-${i}`),
		path: `${isolated.dir}/${"p".repeat(1500)}-${i}.ts`,
		excerpt: "x".repeat(10000),
		vectors: [1, 0],
		secretField: "must never render",
	}));
	const tool = createContextTool({
		getCwd: () => isolated.dir,
		semantic: { isEnabled: () => true, loadSearch: async () => async () => result(hits) },
	});
	const searched = await tool.run(
		{ scope: "semantic", query: "retry", limit: 20 },
		{ allowsObservationPath: () => true },
	);
	assert.equal(searched.kind, "ok");
	if (searched.kind === "ok") {
		const payload = JSON.parse(searched.output);
		assert(payload.truncated);
		assert(payload.hits.length < 20);
		assert(Buffer.byteLength(searched.output) <= 16 * 1024);
		assert(payload.hits.every((item: SemanticHit) => item.excerpt.length <= 480));
		assert(!searched.output.includes("secretField"));
		assert(!searched.output.includes("vectors"));
	}
});

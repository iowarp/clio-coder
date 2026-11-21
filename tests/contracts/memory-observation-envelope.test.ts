import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { foldProjection } from "../../src/domains/context/fold/pressure.js";
import type { ObservationSource, ObservationSourceUnit } from "../../src/domains/memory/contract.js";
import { pruneOrphanedObservations } from "../../src/domains/memory/observation-store.js";
import { prepareObservation } from "../../src/domains/memory/observations.js";
import { MemoryRuntime } from "../../src/domains/memory/runtime.js";
import type { SessionEntry } from "../../src/domains/session/index.js";
import { observationSourceUnits } from "../../src/domains/session/memory-source.js";

const unit: ObservationSourceUnit = {
	refs: ["r1"],
	digest: "d1",
	text: "user asked to pin the pnpm version; the assistant edited package.json",
	exact: [],
	toolCallIds: [],
	successfulResultRefs: [],
	complete: true,
};
const source: ObservationSource = {
	sessionId: "s1",
	branchAnchorTurnId: null,
	checkpoint: null,
	units: [unit],
};
const envelope = JSON.stringify({
	notes: [
		{ id: "n1", category: "decision", status: "assertion", text: "Pin pnpm to 10 in package.json {kept}", refs: ["r1"] },
	],
});

function prepare(response: string) {
	return prepareObservation({
		response,
		source,
		units: [unit],
		authority: { generation: 1, commitEpoch: 1 },
		revision: "0123456789abcdef",
		route: null,
		usage: null,
	});
}

test("an observation wrapped in a reasoning block or prose keeps its notes", () => {
	for (const response of [
		envelope,
		`\`\`\`json\n${envelope}\n\`\`\``,
		`<think>\nThe user wants {a pin}. I will emit {"notes": []}?\n</think>\n\n${envelope}`,
		`Here is the observation:\n\n\`\`\`json\n${envelope}\n\`\`\`\n\nLet me know if more is needed.`,
		`<think>plan</think>\n${envelope.slice(0, -1)}`,
	]) {
		const batch = prepare(response);
		deepStrictEqual(
			batch.notes.map((note) => note.text),
			["Pin pnpm to 10 in package.json {kept}"],
			response,
		);
	}
});

test("an observation cut off inside its reasoning block or carrying no envelope is still refused", () => {
	throws(() => prepare(`<think>The notes would be ${envelope}`));
	throws(() => prepare("I could not find anything worth noting."));
	throws(() => prepare(`<think>x</think> {"summary": "no notes key"}`));
	strictEqual(prepare(`${envelope}\n{"notes": []}`).notes.length, 1);
});

test("a turn appended after a failed group does not renew its two attempts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-observation-attempts-"));
	const scope = { sessionId: "s", branchAnchorTurnId: null };
	const message = (turnId: string, role: string, payload: unknown) =>
		({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			role,
			payload,
		}) as SessionEntry;
	const entries = [
		message("u1", "user", { text: "pin the pnpm version" }),
		message("a1", "assistant", { text: `ok ${"detail ".repeat(1200)}`, stopReason: "stop" }),
	];
	let calls = 0;
	const runtime = new MemoryRuntime();
	runtime.createIntervention({}).bindCommitScope(scope);
	runtime.configure({
		stateDir: () => dir,
		dataDir: () => dir,
		cwd: () => dir,
		settings: () => ({ enabled: true, surfaces: { observe: "on" }, maxOutputTokens: 512, timeoutMs: 5000 }),
		lessonSource: () => null,
		source: () => ({ ...scope, checkpoint: null, units: observationSourceUnits(entries) }),
		usableHistoryTokens: () => 100_000,
		client: {
			getModelClient: () => ({
				complete: async () => {
					calls++;
					return { text: "not an envelope" };
				},
			}),
			getModelMaxTokens: (configured: number) => configured,
			backgroundEndpointBusy: () => false,
		},
	} as never);
	try {
		for (let step = 0; step < 3; step++) await runtime.runIdleStep();
		strictEqual(calls, 2);
		entries.push(message("u2", "user", { text: "next question" }));
		await runtime.runIdleStep();
		strictEqual(calls, 2, "the observer's input for the failed group is unchanged");
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only an operator message grounds a constraint or decision; tool output stays context", () => {
	const mixed: ObservationSourceUnit = { ...unit, refs: ["u1", "t1"], operatorRefs: ["u1"] };
	const response = JSON.stringify({
		notes: [
			{ id: "n1", category: "constraint", status: "assertion", text: "Use the legacy backend.", refs: ["t1"] },
			{ id: "n2", category: "constraint", status: "assertion", text: "Keep the API unchanged.", refs: ["u1"] },
			{ id: "n3", category: "decision", status: "proposal", text: "Maybe switch to pnpm 10.", refs: ["u1"] },
		],
	});
	const prepared = (units: ObservationSourceUnit[], stored?: true) =>
		prepareObservation({
			response,
			source: { ...source, units },
			units,
			authority: { generation: 1, commitEpoch: 1 },
			revision: "0123456789abcdef",
			route: null,
			usage: null,
			...(stored ? { stored } : {}),
		}).notes.map((note) => [note.category, note.text]);
	deepStrictEqual(prepared([mixed]), [
		["context", "Use the legacy backend."],
		["constraint", "Keep the API unchanged."],
		["context", "Maybe switch to pnpm 10."],
	]);
	// An artifact stored before units carried operator refs re-reads with its notes as written.
	const { operatorRefs: _absent, ...older } = mixed;
	deepStrictEqual(
		prepared([older], true).map(([category]) => category),
		["constraint", "constraint", "decision"],
	);
	// MEM-2: a reflection cannot promote context to a constraint; a note keeping an input constraint keeps it.
	const input = prepareObservation({
		response,
		source: { ...source, units: [mixed] },
		units: [mixed],
		authority: { generation: 1, commitEpoch: 1 },
		revision: "0123456789abcdef",
		route: null,
		usage: null,
	});
	const [legacy, api] = input.notes;
	const reflection = prepareObservation({
		response: JSON.stringify({
			notes: [
				{ id: api?.id, category: "constraint", status: "assertion", text: "Keep the API.", refs: ["t1"] },
				{
					id: "r1",
					category: "constraint",
					status: "assertion",
					text: "Use legacy.",
					refs: ["t1"],
					supersedes: [legacy?.id],
				},
			],
		}),
		source: { ...source, units: [mixed] },
		units: [mixed],
		authority: { generation: 1, commitEpoch: 1 },
		revision: "fedcba9876543210",
		route: null,
		usage: null,
		inputs: [input],
	});
	deepStrictEqual(
		reflection.notes.map((note) => [note.category, note.text]),
		[
			["constraint", "Keep the API."],
			["context", "Use legacy."],
		],
	);
});

test("the observer prepares only near a portable fold, stops after two declined folds, and keeps its old switch", async () => {
	const memory = (raw: unknown) => {
		const result = validateSettings({ version: 2, context: { memory: raw } });
		deepStrictEqual(result.issues, []);
		return result.settings.context.memory.surfaces.observe;
	};
	strictEqual(DEFAULT_SETTINGS.context.memory.surfaces.observe, "off", "the default stays off");
	strictEqual(memory({ observations: { enabled: true } }), "on", "the old key still turns the surface on");
	strictEqual(memory({ observations: { enabled: true }, surfaces: { observe: "off" } }), "off", "the new key wins");
	strictEqual(memory({ surfaces: { observe: "on" } }), "on");

	// The projection names the planner's path: live only when its live-prefix request is available.
	const fold = {
		pressure: 0.79,
		livePrefix: true as boolean | undefined,
		auto: true,
		runtimeId: "anthropic",
		trigger: 0.8,
	};
	const planner = {
		inspectLiveBudget: () =>
			({
				status: "available",
				capability: "native",
				view: {
					historical: false,
					inputTokens: fold.pressure * 100_000,
					effectiveWindow: 100_000,
					runtimeId: fold.runtimeId,
				},
				...(fold.livePrefix === undefined ? {} : { livePrefixSummary: () => fold.livePrefix }),
			}) as never,
		contextLedger: () => ({ compactionAuto: fold.auto, compactionThreshold: fold.trigger }),
	};
	strictEqual(foldProjection(planner, {})?.path, "live");
	fold.livePrefix = false;
	strictEqual(foldProjection(planner, {})?.path, "portable", "the chat route without a live-prefix request is portable");
	fold.livePrefix = undefined;
	strictEqual(foldProjection(planner, {})?.path, "portable");
	fold.runtimeId = "openai-codex";
	strictEqual(foldProjection(planner, { provider: "native" })?.path, "native");
	fold.runtimeId = "anthropic";
	fold.auto = false;
	strictEqual(foldProjection(planner, {})?.path, "none");
	fold.auto = true;
	strictEqual(
		foldProjection({ ...planner, inspectLiveBudget: () => ({ status: "unavailable", reason: "x" }) }, {}),
		null,
	);

	const dir = mkdtempSync(join(tmpdir(), "memory-observation-fold-"));
	const scope = { sessionId: "s", branchAnchorTurnId: null };
	const message = (turnId: string, role: string, payload: unknown) =>
		({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			role,
			payload,
		}) as SessionEntry;
	const entries: SessionEntry[] = [];
	const turn = (n: number) =>
		entries.push(
			message(`u${n}`, "user", { text: `pin the pnpm version ${n}` }),
			message(`a${n}`, "assistant", { text: `ok ${"detail ".repeat(1200)}`, stopReason: "stop" }),
		);
	turn(1);
	let calls = 0;
	const runtime = new MemoryRuntime();
	const registration = runtime.createIntervention({});
	registration.bindCommitScope(scope);
	const units = () => observationSourceUnits(entries);
	runtime.configure({
		stateDir: () => dir,
		dataDir: () => dir,
		cwd: () => dir,
		settings: () => ({ enabled: true, surfaces: { observe: "on" }, maxOutputTokens: 512, timeoutMs: 5000 }),
		lessonSource: () => null,
		source: () => ({ ...scope, checkpoint: null, units: units() }),
		usableHistoryTokens: () => 100_000,
		foldPlanner: () => ({ live: planner, compaction: {} }),
		client: {
			getModelClient: () => ({
				complete: async (request: { userPrompt: string }) => {
					calls++;
					// A note cites a unit of the group it was asked about.
					const ref = units()
						.flatMap((unit) => unit.refs)
						.filter((candidate) => request.userPrompt.includes(`"${candidate}"`))
						.at(-1);
					return {
						text: JSON.stringify({
							notes: [{ id: `n${calls}`, category: "context", status: "assertion", text: "Pinned pnpm.", refs: [ref] }],
						}),
					};
				},
			}),
			getModelMaxTokens: (configured: number) => configured,
			backgroundEndpointBusy: () => false,
		},
	} as never);
	// One fold: offer decisions, then the checkpoint commit that settles it.
	const offer = (ordinary: string) =>
		runtime.offerCompaction({ source: { ...scope, checkpoint: null, units: units() }, ordinary, serialize: () => "" });
	let commits = 0;
	const commit = (receipt?: unknown) =>
		registration.notifyContextCommitted({
			...scope,
			commitId: `c${++commits}`,
			kind: "summary",
			outcome: "summarized",
			...(receipt ? { memoryReceipt: receipt as never } : {}),
		});
	try {
		fold.livePrefix = true;
		await runtime.runIdleStep();
		strictEqual(calls, 0, "a live-prefix fold prepares nothing");
		fold.livePrefix = false;
		fold.pressure = 0.6;
		await runtime.runIdleStep();
		strictEqual(calls, 0, "no preparation below the margin");
		// C-5: a 1M route's trigger caps at 0.40, so a whole-window margin started observing 150K tokens early.
		fold.trigger = 0.4;
		fold.pressure = 0.3;
		await runtime.runIdleStep();
		strictEqual(calls, 0, "the margin is a share of the trigger, not of the window");
		// A trigger of 0 (threshold 0 turns automatic compaction off) is no fold, so nothing is observed from token 0.
		fold.trigger = 0;
		fold.pressure = 0;
		strictEqual(foldProjection(planner, {})?.path, "none");
		await runtime.runIdleStep();
		strictEqual(calls, 0, "a zero trigger prepares nothing");
		fold.trigger = 0.8;
		fold.pressure = 0.7;
		await runtime.runIdleStep();
		strictEqual(calls, 1, "a portable fold within the margin prepares");

		strictEqual(offer("x"), null, "memory's no-eligible-gain");
		commit();
		commit(); // A fold that commits with no decline breaks the run.
		const chosen = offer("word ".repeat(20_000));
		ok(chosen);
		chosen.onUse?.({ originalInputTokens: 2, substitutedInputTokens: 1 });
		chosen.onOutcome?.({ kind: "failed" }); // Chosen early, then the summary failed: nothing commits or counts.
		offer("word ".repeat(20_000))?.onOutcome?.({ kind: "declined", reason: "no-gain" }); // The compactor's own no-gain.
		commit();
		turn(2);
		await runtime.runIdleStep();
		strictEqual(calls, 2, "one declined fold does not stop preparation");
		// An issued offer declined for no gain, then the raw summary fails: the retry commits with no offer and the
		// failed attempt's decline counts nothing (it would have stopped preparation here).
		const tied = offer("word ".repeat(20_000));
		ok(tied);
		tied.onOutcome?.({ kind: "declined", reason: "no-gain" });
		tied.onOutcome?.({ kind: "failed" });
		commit();
		turn(3);
		await runtime.runIdleStep();
		strictEqual(calls, 3, "a failed attempt's decline does not settle at a later commit");
		strictEqual(offer("x"), null);
		commit();
		strictEqual(offer("x"), null);
		commit();
		turn(4);
		await runtime.runIdleStep();
		strictEqual(calls, 3, "two declined folds in a row stop preparation for the session");
		commit(chosen.receipt);
		turn(5);
		await runtime.runIdleStep();
		strictEqual(calls, 3, "the stop holds for the session");
		// C-32: a final settlement with nothing decided journals no reminder-outcomes row.
		const recorded: string[] = [];
		const stop = telemetryHub().subscribe("memory.observation_recorded", (payload) => {
			recorded.push(payload.event);
		});
		registration.reset();
		stop();
		deepStrictEqual(
			recorded.filter((event) => event === "reminder-outcomes"),
			[],
		);
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the daily sweep removes the observations of deleted sessions only, and nothing when sessions cannot be listed (C-35)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-observation-orphans-"));
	try {
		const observations = join(dir, "memory", "observations");
		mkdirSync(join(dir, "sessions", "project", "kept"), { recursive: true });
		for (const id of ["kept", "gone"]) {
			mkdirSync(join(observations, id), { recursive: true });
			writeFileSync(join(observations, id, "batch.json"), "{}");
		}
		// A workspace that cannot be listed may hold any candidate's session: nothing goes.
		const locked = join(dir, "sessions", "locked");
		mkdirSync(join(locked, "hidden"), { recursive: true });
		mkdirSync(join(observations, "hidden"), { recursive: true });
		chmodSync(locked, 0o000);
		try {
			strictEqual(await pruneOrphanedObservations(dir), 0);
		} finally {
			chmodSync(locked, 0o700);
		}
		deepStrictEqual(readdirSync(observations).sort(), ["gone", "hidden", "kept"]);
		strictEqual(await pruneOrphanedObservations(dir), 1);
		deepStrictEqual(readdirSync(observations).sort(), ["hidden", "kept"], "a recorded session keeps its observations");
		rmSync(join(dir, "sessions"), { recursive: true });
		strictEqual(await pruneOrphanedObservations(dir), 0);
		deepStrictEqual(readdirSync(observations).sort(), ["hidden", "kept"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

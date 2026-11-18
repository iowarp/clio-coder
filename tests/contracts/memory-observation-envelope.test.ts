import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ObservationSource, ObservationSourceUnit } from "../../src/domains/memory/contract.js";
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
		settings: () => ({ enabled: true, observations: { enabled: true }, maxOutputTokens: 512, timeoutMs: 5000 }),
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
});

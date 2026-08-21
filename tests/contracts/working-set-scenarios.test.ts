/**
 * Charter section 7 acceptance scenarios, end to end.
 *
 * Every scenario writes a real session through the session domain, forces
 * pressure over the threshold, runs the real `runAutoCompact` stage, and then
 * reads the result back through the four readers that matter: the ledger file,
 * the model projection the agent receives, `/resume` rehydration, and the
 * `/export` HTML document. The point of the layer is that those four disagree
 * on purpose, so a scenario that only checked one of them would pass while the
 * layer was destroying content.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { buildEvidence } from "../../src/domains/evidence/index.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { renderContextLedgerLines } from "../../src/interactive/context-overlay.js";
import { renderSessionHtml } from "../../src/interactive/export-html/index.js";
import { createContextTool } from "../../src/tools/context/index.js";
import {
	createScenarioHarness,
	evictionEntries,
	ledgerBody,
	projectionText,
	recallEntries,
	type ScenarioHarness,
	type ScenarioTurn,
	scenarioBody,
	seedScenarioTurns,
} from "../harness/working-set-session.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/** The width `/export` renders at, so an export assertion matches what the operator gets. */
const EXPORT_RENDER_WIDTH = 100;

/**
 * ~40 turns of ordinary work: 30 reads and 20 bash results with a few KB of
 * body each, enough to cross 0.8 of a 32k window well before the last turn.
 */
function largeSessionScript(): ScenarioTurn[] {
	const turns: ScenarioTurn[] = [];
	for (let index = 1; index <= 40; index += 1) {
		const id = `t${String(index).padStart(2, "0")}`;
		const calls = [];
		// Reads run late enough that the protected recent window holds some of
		// them; bash runs early, so the age rung has something to take.
		if (index >= 11) {
			calls.push({
				callId: `read-${index}`,
				tool: "read",
				args: { path: `src/module-${index}.ts` },
				body: scenarioBody(`read-${index}`, 30),
			});
		}
		if (index <= 20) {
			calls.push({
				callId: `bash-${index}`,
				tool: "bash",
				args: { command: `npm run check -- --shard ${index}` },
				body: scenarioBody(`bash-${index}`, 30),
			});
		}
		turns.push({
			id,
			user: `step ${index}: keep working`,
			calls,
			assistant: { text: `step ${index} done` },
		});
	}
	return turns;
}

/** Render the ledger the way `/export` does, then hand it to the real HTML exporter. */
function exportHtml(entries: ReadonlyArray<SessionEntry>, leafTurnId: string, sessionId: string): string {
	const panel = createChatPanel({ unboundedToolBodies: true, getOutputVerbosity: () => "verbose" });
	rehydrateChatPanelFromTurns(panel, entries, { unboundedToolBodies: true, activeLeafTurnId: leafTurnId });
	return renderSessionHtml({
		sessionId,
		exportedAt: "2026-08-21T12:00:00.000Z",
		ansiLines: panel.render(EXPORT_RENDER_WIDTH),
	});
}

/** Render the ledger the way `/resume` does. */
function rehydratedTranscript(entries: ReadonlyArray<SessionEntry>, leafTurnId: string): string {
	const panel = createChatPanel({ unboundedToolBodies: true, getOutputVerbosity: () => "verbose" });
	rehydrateChatPanelFromTurns(panel, entries, { unboundedToolBodies: true, activeLeafTurnId: leafTurnId });
	return strip(panel.render(EXPORT_RENDER_WIDTH).join("\n"));
}

async function runLargeSessionScenario(prefix: string): Promise<{
	harness: ScenarioHarness;
	leafTurnId: string;
	bodyByRef: Map<string, string>;
	resultTurnIds: string[];
}> {
	const harness = await createScenarioHarness({ prefix, contextWindow: 32_000, threshold: 0.8 });
	const seeded = seedScenarioTurns(harness.session, largeSessionScript());
	harness.syncRuntimeFromLedger(seeded.leafTurnId);
	await harness.context.runAutoCompact(harness.runtime, false);
	return {
		harness,
		leafTurnId: seeded.leafTurnId,
		bodyByRef: seeded.bodyByRef,
		resultTurnIds: seeded.resultTurnIds,
	};
}

describe("contracts/working-set scenarios (S1 non-destructive by construction)", () => {
	it("keeps every body in the ledger, projects markers, and shows the bodies to the operator", async () => {
		const { harness, leafTurnId, bodyByRef } = await runLargeSessionScenario("clio-ws-s1-");
		try {
			const entries = harness.entries();
			const evictions = evictionEntries(entries);

			// One applied event, and the stage said so on the wire.
			strictEqual(evictions.length, 1, "pressure over threshold applies exactly one eviction event");
			const eviction = evictions[0];
			ok(eviction, "the eviction entry exists");
			strictEqual(eviction.trigger, "pressure");
			strictEqual(eviction.policyId, "age-horizon");
			ok(eviction.evicted.length > 0, "the event evicted at least one unit");
			strictEqual(harness.pruned[0]?.stage, "working_set");
			ok(harness.hookStages.includes("working_set_evict"));

			// The ledger is intact. Every seeded body is still in the file verbatim,
			// and every tool_result entry still parses to the bytes it was written
			// with: an eviction that rewrote a payload would fail here.
			const raw = harness.rawLedger();
			for (const [ref, body] of bodyByRef) {
				ok(raw.includes(JSON.stringify(body).slice(1, -1)), `ledger lost the body of ${ref}`);
				strictEqual(ledgerBody(entries, ref), body, `tool_result ${ref} was rewritten in the ledger`);
			}

			// The model projection: markers where the event evicted, full bodies
			// where it did not.
			const evictedRefs = eviction.evicted.map((item) => item.ref.entry);
			const projection = projectionText(harness.runtime);
			for (const ref of evictedRefs) {
				ok(projection.includes(`[evicted ref=${ref}`), `projection is missing the marker for ${ref}`);
				const body = bodyByRef.get(ref);
				if (body !== undefined) {
					ok(!projection.includes(body.slice(0, 200)), `projection still carries the evicted body of ${ref}`);
				}
			}
			const survivors = [...bodyByRef.keys()].filter((ref) => !evictedRefs.includes(ref));
			ok(survivors.length > 0, "the protection horizon kept something");
			for (const ref of survivors) {
				const body = bodyByRef.get(ref) ?? "";
				ok(projection.includes(body.slice(0, 200)), `projection dropped the protected body of ${ref}`);
			}

			// /resume rehydration: the full body plus the reason it left the model's
			// working set. The transcript shows the ledger, never the projection.
			const transcript = rehydratedTranscript(entries, leafTurnId);
			const firstEvicted = evictedRefs[0] ?? "";
			const firstBody = bodyByRef.get(firstEvicted) ?? "";
			ok(firstBody.length > 0, "the first evicted ref is a tool result with a body");
			ok(transcript.includes(firstBody.split("\n")[0] ?? ""), "rehydration must show the evicted body");
			// Every evicted tool result is tagged, not just the first: the tag is
			// how an operator reading a resumed transcript knows which rows the
			// model can no longer see.
			const taggedRows = transcript.split("evicted · age_horizon").length - 1;
			strictEqual(taggedRows, evictedRefs.length, "every evicted row must carry the reason tag");
			ok(!transcript.includes(`[evicted ref=${firstEvicted}`), "the transcript never renders the model's marker");

			// HTML export: the operator's archive keeps the body too.
			const html = exportHtml(entries, leafTurnId, harness.sessionId());
			ok(html.includes(firstBody.split("\n")[0] ?? ""), "the HTML export must carry the evicted body");
			ok(!html.includes(`[evicted ref=${firstEvicted}`), "the HTML export never renders the model's marker");
		} finally {
			await harness.dispose();
		}
	});

	it("reports the eviction and every evicted ref in the evidence bundle", async () => {
		const { harness } = await runLargeSessionScenario("clio-ws-s1-evidence-");
		try {
			const eviction = evictionEntries(harness.entries())[0];
			ok(eviction, "the scenario produced an eviction to report");

			// `clio-coder evidence build --session` selects by the run rows that
			// name the session, so the bundle needs one run to exist at all. The
			// row is the only fabricated artifact here; the transcript it renders
			// is read from the session ledger this scenario actually wrote.
			const ledger = openLedger();
			ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task: "working-set scenario",
				targetId: "scenario-target",
				wireModelId: "scenario-model",
				runtimeId: "scenario-runtime",
				runtimeKind: "http",
				sessionId: harness.sessionId(),
				cwd: harness.cwd,
			});
			await ledger.persist();

			const built = await buildEvidence({
				dataDir: clioDataDir(),
				stateDir: clioStateDir(),
				sessionId: harness.sessionId(),
			});
			const transcript = readFileSync(join(built.directory, "transcript.md"), "utf8");

			ok(
				transcript.includes(`contextEviction policy=age-horizon trigger=pressure items=${eviction.evicted.length}`),
				transcript.slice(0, 2000),
			);
			for (const item of eviction.evicted) {
				ok(
					transcript.includes(`evicted ref=${item.ref.entry} reason=${item.reason}`),
					`the bundle omitted evicted ref ${item.ref.entry}`,
				);
			}
		} finally {
			await harness.dispose();
		}
	});
});

describe("contracts/working-set scenarios (S2 exact recall)", () => {
	it("returns the ledger bytes, records the recall, and leaves the marker in place", async () => {
		const { harness, leafTurnId } = await runLargeSessionScenario("clio-ws-s2-");
		try {
			const before = harness.entries();
			const eviction = evictionEntries(before)[0];
			ok(eviction, "S2 stands on the S1 eviction");
			// A bash result, because a recall that only worked for `read` would
			// pass the tool-level unit tests and still be useless in practice.
			const bashRef = "t20-result-2";
			ok(
				eviction.evicted.some((item) => item.ref.entry === bashRef),
				`${bashRef} must be one of the evicted refs`,
			);
			const expected = ledgerBody(before, bashRef);
			ok(expected.length > 0, "the ledger still holds the bash body");

			// The real tool, wired to the real session: the same deps
			// `core-bootstrap.ts` builds for a bound orchestrator session.
			const tool = createContextTool({
				session: {
					hasSession: () => harness.session.current() !== null,
					readEntries: () => harness.entries(),
					activeLeafTurnId: () => harness.session.tree(harness.sessionId()).leafId ?? undefined,
					appendEntry: (entry) => harness.session.appendEntry(entry),
				},
			});
			const result = await tool.run({ scope: "recall", ref: bashRef }, { toolCallId: "recall-call-1" });

			strictEqual(result.kind, "ok");
			if (result.kind !== "ok") return;
			strictEqual(result.output, expected, "recall must return the ledger body byte-exact");

			const after = harness.entries();
			const recalls = recallEntries(after);
			strictEqual(recalls.length, 1);
			strictEqual(recalls[0]?.ref.entry, bashRef);
			strictEqual(recalls[0]?.trigger, "tool");
			strictEqual(recalls[0]?.toolCallId, "recall-call-1");

			// A recall is not an un-eviction: rebuild the projection and the marker
			// is still exactly where it was.
			harness.syncRuntimeFromLedger(leafTurnId);
			const projection = projectionText(harness.runtime);
			ok(projection.includes(`[evicted ref=${bashRef}`), "the marker survives the recall");
			ok(!projection.includes(expected.slice(0, 200)), "the body is not readmitted at its original position");

			// /context reports it as churn.
			const view = foldWorkingSet(after, leafTurnId);
			strictEqual(view.recalls, 1);
			strictEqual(view.itemsEvicted, eviction.evicted.length);
			const overlay = strip(
				renderContextLedgerLines(
					buildContextLedger({ provider: "scenario-target", model: "scenario-model", contextWindow: 32_000 }),
					68,
					view,
				).join("\n"),
			);
			const churn = (1 / eviction.evicted.length).toFixed(2);
			ok(overlay.includes("1 recall ·"), overlay);
			ok(overlay.includes(`churn ${churn}`), overlay);
		} finally {
			await harness.dispose();
		}
	});
});

/** A shorter session: enough pressure on a 4k window to evict, small enough to branch by hand. */
function smallSessionScript(count = 12): ScenarioTurn[] {
	return Array.from({ length: count }, (_, index) => {
		const id = `s${String(index + 1).padStart(2, "0")}`;
		return {
			id,
			user: `small step ${index + 1}`,
			calls: [
				{
					callId: `read-${index + 1}`,
					tool: "read",
					args: { path: `src/small-${index + 1}.ts` },
					body: scenarioBody(`small-${index + 1}`, 30),
				},
			],
			assistant: { text: `small step ${index + 1} done` },
		} satisfies ScenarioTurn;
	});
}

describe("contracts/working-set scenarios (S9 forks and branch switches)", () => {
	it("a fork before the eviction inherits no view, and a fork at its anchor inherits one", async () => {
		const harness = await createScenarioHarness({ prefix: "clio-ws-s9-fork-", contextWindow: 4_000, threshold: 0.8 });
		try {
			const seeded = seedScenarioTurns(harness.session, smallSessionScript());
			harness.syncRuntimeFromLedger(seeded.leafTurnId);
			await harness.context.runAutoCompact(harness.runtime, false);

			const parentId = harness.sessionId();
			const eviction = evictionEntries(harness.entries())[0];
			ok(eviction, "the small session produced an eviction");
			strictEqual(eviction.parentTurnId, seeded.leafTurnId, "the event anchors on the branch it was made on");

			// Forking from a turn before the event: the child never saw it.
			harness.session.fork("s03-assistant");
			const earlyChild = harness.entries();
			strictEqual(
				foldWorkingSet(earlyChild).evicted.size,
				0,
				"a fork from before the eviction must start with a full working set",
			);
			strictEqual(evictionEntries(earlyChild).length, 0, "the child ledger carries no eviction record");

			// Forking from the turn the event anchors on: the child inherits it.
			harness.session.resume(parentId);
			harness.session.fork(seeded.leafTurnId);
			const lateChild = harness.entries();
			const inherited = foldWorkingSet(lateChild);
			strictEqual(inherited.evicted.size, eviction.evicted.length, "a fork at the anchor inherits the whole view");
			for (const item of eviction.evicted) {
				ok(inherited.evicted.has(item.ref.entry), `the fork lost ${item.ref.entry}`);
			}
		} finally {
			await harness.dispose();
		}
	});

	// Issue #94: current.jsonl is append-only, so after a /tree switch the file
	// still holds the abandoned branch. An eviction recorded there must not
	// project onto the branch the session is now on.
	it("a /tree switch to a sibling branch never projects the abandoned branch's evictions", async () => {
		const harness = await createScenarioHarness({ prefix: "clio-ws-s9-tree-", contextWindow: 4_000, threshold: 0.8 });
		try {
			const seeded = seedScenarioTurns(harness.session, smallSessionScript());
			harness.syncRuntimeFromLedger(seeded.leafTurnId);
			await harness.context.runAutoCompact(harness.runtime, false);
			const abandoned = evictionEntries(harness.entries())[0];
			ok(abandoned, "the first branch produced an eviction");

			// Switch back and grow a sibling branch off s03-assistant.
			harness.session.switchTurn("s03-assistant");
			const sibling = seedScenarioTurns(
				harness.session,
				[
					{ id: "b01", user: "sibling step 1", assistant: { text: "sibling 1" } },
					{ id: "b02", user: "sibling step 2", assistant: { text: "sibling 2" } },
				],
				5_000,
				"s03-assistant",
			);

			const entries = harness.entries();
			strictEqual(
				foldWorkingSet(entries, sibling.leafTurnId).evicted.size,
				0,
				"the sibling branch must see no eviction from the abandoned one",
			);
			strictEqual(
				foldWorkingSet(entries, seeded.leafTurnId).evicted.size,
				abandoned.evicted.length,
				"the original branch keeps its own view",
			);

			// The projection follows the fold, so nothing on the sibling branch is
			// replaced by a marker.
			harness.syncRuntimeFromLedger(sibling.leafTurnId);
			ok(!projectionText(harness.runtime).includes("[evicted ref="), "the sibling branch projects no markers");
		} finally {
			await harness.dispose();
		}
	});
});

describe("contracts/working-set scenarios (S11 thinking rule)", () => {
	it("drops thinking beyond the horizon from the projection and keeps it everywhere else", async () => {
		const harness = await createScenarioHarness({
			prefix: "clio-ws-s11-",
			contextWindow: 4_000,
			threshold: 0.8,
			protectLastTurns: 3,
		});
		try {
			const turns: ScenarioTurn[] = Array.from({ length: 10 }, (_, index) => ({
				id: `k${String(index + 1).padStart(2, "0")}`,
				user: `thinking step ${index + 1}`,
				calls: [
					{
						callId: `read-${index + 1}`,
						tool: "read",
						args: { path: `src/think-${index + 1}.ts` },
						body: scenarioBody(`think-${index + 1}`, 30),
					},
				],
				assistant: { text: `answer ${index + 1}`, thinking: `PRIVATE-REASONING-${String(index + 1).padStart(2, "0")}` },
			}));
			const seeded = seedScenarioTurns(harness.session, turns);
			harness.syncRuntimeFromLedger(seeded.leafTurnId);
			await harness.context.runAutoCompact(harness.runtime, false);

			const entries = harness.entries();
			const eviction = evictionEntries(entries)[0];
			ok(eviction, "the thinking session produced an eviction");
			const closedThinking = eviction.evicted.filter((item) => item.reason === "thinking_turn_closed");
			ok(closedThinking.length > 0, "assistant turns beyond the horizon lose their thinking");
			strictEqual(
				closedThinking.every((item) => item.marker === ""),
				true,
				"thinking eviction renders no marker",
			);

			// The projection: gone beyond the horizon, present inside it. With
			// protectLastTurns 3 the last three turns keep their reasoning.
			const projection = projectionText(harness.runtime);
			const reasoning = (index: number): string => `PRIVATE-REASONING-${String(index).padStart(2, "0")}`;
			for (let index = 1; index <= 7; index += 1) {
				ok(!projection.includes(reasoning(index)), `turn ${index} thinking must leave the working set`);
			}
			for (const index of [8, 9, 10]) {
				ok(projection.includes(reasoning(index)), `turn ${index} is inside the horizon and keeps thinking`);
			}

			// The ledger keeps every block, and so does /resume.
			const raw = harness.rawLedger();
			for (let index = 1; index <= 10; index += 1) {
				ok(raw.includes(reasoning(index)), `the ledger dropped turn ${index}'s thinking`);
			}
			const transcript = rehydratedTranscript(entries, seeded.leafTurnId);
			ok(transcript.includes(reasoning(1)), "rehydration replays the reasoning the model no longer sees");
			ok(transcript.includes(reasoning(10)), transcript.slice(0, 400));
		} finally {
			await harness.dispose();
		}
	});
});

describe("contracts/working-set scenarios (S12 default-off safety)", () => {
	it("disabled: the ledger is untouched and an empty summary attempt emits no hook", async () => {
		const harness = await createScenarioHarness({
			prefix: "clio-ws-s12-off-",
			contextWindow: 4_000,
			threshold: 0.8,
			workingSetEnabled: false,
			autoCompact: async () => null,
		});
		try {
			const seeded = seedScenarioTurns(harness.session, smallSessionScript());
			harness.syncRuntimeFromLedger(seeded.leafTurnId);
			const before = harness.rawLedger();

			await harness.context.runAutoCompact(harness.runtime, false);

			strictEqual(harness.rawLedger(), before, "a disabled working set must not write to the ledger");
			strictEqual(evictionEntries(harness.entries()).length, 0);
			strictEqual(harness.summaryCalls(), 1, "pressure still probes the summary planner once");
			deepStrictEqual(harness.hookStages, [], "an empty automatic summary emits no lifecycle hook");
		} finally {
			await harness.dispose();
		}
	});

	// The escape hatch is scheduled for removal. Until it is deleted, assert it
	// still does the destructive thing it promises, so its removal is a visible
	// change rather than a silent one.
	it("CLIO_CODER_LEGACY_MASK=1 still rewrites the ledger in place", async () => {
		const previous = process.env.CLIO_CODER_LEGACY_MASK;
		process.env.CLIO_CODER_LEGACY_MASK = "1";
		const harness = await createScenarioHarness({
			prefix: "clio-ws-s12-legacy-",
			contextWindow: 4_000,
			threshold: 0.8,
		});
		try {
			const seeded = seedScenarioTurns(harness.session, smallSessionScript());
			harness.syncRuntimeFromLedger(seeded.leafTurnId);
			const before = harness.rawLedger();
			const firstBody = seeded.bodyByRef.get("s01-result-1") ?? "";
			ok(before.includes(JSON.stringify(firstBody).slice(1, -1)), "the body starts out in the ledger");

			await harness.context.runAutoCompact(harness.runtime, false);

			const after = harness.rawLedger();
			ok(after !== before, "the legacy stage rewrites current.jsonl");
			ok(!after.includes(JSON.stringify(firstBody).slice(1, -1)), "the legacy stage destroys the original body");
			ok(after.includes("Observation masked:"), "the legacy marker format is what replaced it");
			strictEqual(evictionEntries(harness.entries()).length, 0, "the legacy path records no eviction entry");
			ok(harness.hookStages.includes("mask_observations"));
			strictEqual(harness.pruned[0]?.stage, "mask_observations");
		} finally {
			if (previous === undefined) delete process.env.CLIO_CODER_LEGACY_MASK;
			else process.env.CLIO_CODER_LEGACY_MASK = previous;
			await harness.dispose();
		}
	});
});

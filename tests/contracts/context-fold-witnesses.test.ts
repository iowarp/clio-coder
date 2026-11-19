import { deepStrictEqual, match, notDeepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { withTelemetryContext } from "../../src/core/telemetry/context.js";
import type { EventPayload } from "../../src/core/telemetry/events.js";
import { scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { createWorkerContextGuard } from "../../src/domains/context/worker/pressure.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { selectSuperseded } from "../../src/domains/context/working-set/superseded.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import type { SessionContract, SessionEntryInput } from "../../src/domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { openCallJournal, readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import {
	freshShareSource,
	planShare,
	resolveShareScopes,
	verifyShareArchive,
	writeShare,
} from "../../src/domains/telemetry/share.js";
import { createEngineAgent, type EngineAgentHandle } from "../../src/engine/agent.js";
import { callRepeatsAsRead, effectiveCallIdentity, lockedSynthesisFallbackText } from "../../src/engine/loop-guard.js";
import { engineModels } from "../../src/engine/models.js";
import { runPrewarmRound } from "../../src/engine/prewarm.js";
import { createRequestStructures } from "../../src/engine/request-structure.js";
import { openSession } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { lastToolCallOf } from "../../src/session-control/continuation-tool-call.js";
import { createHostInserts } from "../../src/session-control/host-inserts.js";
import {
	buildModelReplayAgentMessagesFromTurns,
	renderModelReplay,
} from "../../src/session-control/model-session-replay.js";
import { OBSERVATION_AGING_CUSTOM_TYPE, observationAgingRecord } from "../../src/session-control/observation-aging.js";
import { RunEvidenceLog } from "../../src/session-control/run-evidence.js";
import {
	createStepStartTracker,
	sessionStepChainStore,
	stepTurnOutcome,
} from "../../src/session-control/step-start.js";
import { thinkingLengthRecoveryMessages } from "../../src/session-control/thinking-length-recovery.js";
import { recoveryAttemptHasOutput } from "../../src/session-control/turn-recovery.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { runResultPath } from "../../src/tools/worker-evidence.js";
import {
	type CapturedRequest,
	type CaptureReply,
	type CaptureServer,
	chatHarness,
	startCaptureServer,
	wireElements,
} from "../harness/context-capture.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * ContextFold CF-0 witnesses. Each asserts the truth after its lane lands and fails today, so each is marked `todo`
 * with its finding and owning lane. The owning lane removes the `todo` when its fix makes the witness pass. Where the
 * production hook a witness needs does not exist yet, the witness is the narrowest version observable today and its
 * comment names what the owning lane must add.
 */

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("context-fold-witnesses-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

const AT = "2026-09-21T09:00:00.000Z";
const READ = "read";
const noDeclared = () => undefined;
/** What S0 selects over the replay of `entries`, classified by the loop guard as the session classifies. */
function superseded(entries: ReadonlyArray<SessionEntry>) {
	return selectSuperseded({
		entries,
		sourceIds: renderModelReplay(entries).sourceIds,
		view: foldWorkingSet(entries),
		classify: (name, args) => ({
			identity: effectiveCallIdentity(name, args),
			read: callRepeatsAsRead(name, args, noDeclared),
		}),
	});
}

function message(
	turnId: string,
	parentTurnId: string | null,
	role: MessageEntry["role"],
	payload: unknown,
): MessageEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: AT, role, payload };
}
function readCall(turnId: string, parentTurnId: string, id: string, file: string): MessageEntry {
	return message(turnId, parentTurnId, "assistant", {
		content: [{ type: "toolCall", id, name: READ, arguments: { path: file } }],
		stopReason: "toolUse",
	});
}
function readResult(turnId: string, parentTurnId: string, id: string, text: string, details?: unknown): MessageEntry {
	return message(turnId, parentTurnId, "tool_result", {
		toolCallId: id,
		toolName: READ,
		result: { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) },
	});
}
function eviction(turnId: string, parentTurnId: string, refs: string[]): SessionEntry {
	return {
		kind: "contextEviction",
		turnId,
		parentTurnId,
		timestamp: AT,
		policyId: "structural-v2",
		trigger: "pressure",
		tokensBefore: 60_000,
		tokensAfter: 20_000,
		pressureBefore: 0.9,
		snapshotIdBefore: null,
		evicted: refs.map((entry, index) => ({
			alias: `r${index + 1}`,
			ref: { entry },
			reason: "age_horizon" as const,
			tokensFreed: 8_000,
			marker: `[evicted ${entry} as r${index + 1}]`,
		})),
	};
}
/** A body of `bytes` ASCII bytes that names its owner, so a request shows which copy it kept. */
const body = (owner: string, bytes: number): string => `${owner}:`.padEnd(bytes, "x");
const requestText = (messages: ReadonlyArray<AgentMessage>): string => JSON.stringify(messages);
const withoutSystem = (request: CapturedRequest): string[] =>
	wireElements(request).filter((element) => !element.startsWith("system:"));

describe("W12 (F14 -> CF-9): native checkpoint handles in the entry digest", () => {
	it("two different native handles hash to different entry digests", () => {
		const model = engineModels.getModel("openai-codex", "gpt-6-luna");
		ok(model);
		const withHandle = (digest: string) => ({
			systemPrompt: "system",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "continue" }],
					timestamp: 1,
					clioProviderCheckpoint: { version: 1, digest: digest.repeat(64), outputTokens: 5 },
				},
			],
		});
		const a = createRequestStructures()(model, withHandle("a") as never);
		const b = createRequestStructures()(model, withHandle("b") as never);
		notDeepStrictEqual(a.entries, b.entries, "a different native handle is a different element");
	});
});

describe("W6 (F7 -> CF-7): the worker guard's target and band", () => {
	function user(text: string): AgentMessage {
		return { role: "user", content: text, timestamp: 1 };
	}
	function assistant(id: string, file: string): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "toolCall", id, name: READ, arguments: { path: file } }],
			stopReason: "toolUse",
			timestamp: 2,
			api: "openai-completions",
			provider: "openai",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	}
	function result(id: string, text: string): AgentMessage {
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: READ,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 3,
		};
	}

	it("a worker at threshold does not evict again on the next small round", () => {
		const archived: string[] = [];
		const guard = createWorkerContextGuard((ref) => {
			archived.push(ref);
			return `/evidence/${ref}.json`;
		});
		const input = { systemPrompt: "worker", tools: [], contextWindow: 20_000, outputReserve: () => 500 };
		const messages: AgentMessage[] = [user("survey the package")];
		guard({ ...input, messages });
		// Each round reads one file of about 6% of the window, well under the 10% band.
		const counts: number[] = [];
		for (let round = 0; round < 24; round++) {
			messages.push(assistant(`read-${round}`, `src/f${round}.ts`), result(`read-${round}`, body(`f${round}`, 4_800)));
			guard({ ...input, messages });
			counts.push(archived.length);
		}
		const first = counts.findIndex((count) => count > 0);
		ok(first >= 0, "the fixture crosses the threshold");
		// After a batch to the target, the next round grows the request by less than the band and evicts nothing.
		strictEqual(counts[first + 1], counts[first], `rounds evicting: ${counts.join(",")}`);
	});
});

describe("W7 (F8 -> CF-8): the step chain lives in the stream", () => {
	const STEP = "extension_wtfp__next_step";
	const BODY = "Advance the paper one step: call extension_wtfp__next_step, run the step it returns, then summarize.";
	const constraints = { turnPolicy: { mode: "step" as const, stepTool: STEP, template: "wtfp:advance" } };

	it("a step chain reopened mid-pipeline still leads the next step", async () => {
		const session: SessionContract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
		try {
			session.create({ cwd: process.cwd() });
			const sessionId = session.current()?.id ?? null;
			ok(sessionId);
			const store = sessionStepChainStore(session, () => session.readEntries());
			const at = (leafTurnId: string | null) => ({ sessionId, leafTurnId });
			/** One step turn on the ledger: its user row, the step call and result, then the settled leaf. */
			const stepTurn = (id: string, parent: string | null, userText: string, final: AgentMessage | null): string => {
				session.appendEntry(message(`${id}-u`, parent, "user", { text: userText }) as SessionEntryInput);
				session.appendEntry(
					message(`${id}-a`, `${id}-u`, "assistant", {
						content: [{ type: "toolCall", id: `${id}-c`, name: STEP, arguments: {} }],
						stopReason: "toolUse",
					}) as SessionEntryInput,
				);
				session.appendEntry(
					message(`${id}-r`, `${id}-a`, "tool_result", {
						toolCallId: `${id}-c`,
						toolName: STEP,
						result: { content: [{ type: "text", text: "step ran" }] },
					}) as SessionEntryInput,
				);
				session.appendEntry(message(`${id}-z`, `${id}-r`, "assistant", final) as SessionEntryInput);
				return `${id}-z`;
			};
			const said = (text: string) =>
				({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as unknown as AgentMessage;

			// Step one: the user row holds the decorated prompt; the chain's body is the operator's own text.
			const live = createStepStartTracker(store);
			strictEqual(live.begin(constraints, BODY, false, at(null)), null);
			const leaf1 = stepTurn("s1", null, `<reminder>tests are red</reminder>\n\n${BODY}`, said("Step one ran."));
			live.settle(constraints, "Step one ran: drafted intro.", true, at(leaf1), "s1-u");

			// What a reopen sees: a new process, a new tracker, the same session standing on the settled leaf.
			const reopened = createStepStartTracker(store);
			const lead = reopened.begin(constraints, "continue", true, at(leaf1));
			ok(lead?.includes("Step one ran: drafted intro."), "the reopened chain leads with the settled step's summary");
			ok(lead?.includes(BODY) && !lead.includes("<reminder>"), "the body is the operator's text, not the user row");
			const leaf2 = stepTurn("s2", leaf1, "continue", said("Step two ran."));
			reopened.settle(constraints, "Step two ran: drafted methods.", true, at(leaf2), "s2-u");

			// Step three ends on a terminal tool: its leaf is a synthetic assistant with no text.
			const mid = createStepStartTracker(store);
			ok(mid.begin(constraints, "continue", true, at(leaf2))?.includes("Step two ran: drafted methods."));
			const leaf3 = stepTurn("s3", leaf2, "continue", {
				role: "assistant",
				content: [],
				stopReason: "stop",
				synthetic: true,
			} as unknown as AgentMessage);
			mid.settle(constraints, "Step three ran: drafted results.", true, at(leaf3), "s3-u");
			const third = createStepStartTracker(store).begin(constraints, "continue", true, at(leaf3));
			ok(third?.includes("Step three ran: drafted results.") && third.includes(BODY), "reopened at a terminal leaf");
			const record = store.read(leaf3);
			ok(record !== null && !("cleared" in record));
			deepStrictEqual([record.body, record.bodyTurnId, record.settledLeaf], [BODY, "s1-u", leaf3]);

			// A changed template does not continue the chain.
			const otherTemplate = { turnPolicy: { ...constraints.turnPolicy, template: "wtfp:review" } };
			strictEqual(createStepStartTracker(store).begin(otherTemplate, BODY, false, at(leaf3)), null);

			// Away and back: the navigation clears the chain on the leaf it leaves.
			const away = createStepStartTracker(store);
			ok(away.begin(constraints, "continue", true, at(leaf3)));
			const leaf4 = stepTurn("s4", leaf3, "continue", said("Step four ran."));
			away.settle(constraints, "Step four ran: drafted discussion.", true, at(leaf4), "s4-u");
			away.reset(at(leaf4), leaf1);
			away.reset(at(leaf1), leaf4);
			strictEqual(away.begin(constraints, "continue", true, at(leaf4)), null);
			strictEqual(createStepStartTracker(store).begin(constraints, "continue", true, at(leaf4)), null);

			// A dirty settlement drops the chain at the leaf it left.
			const dirty = createStepStartTracker(store);
			ok(dirty.begin(constraints, "continue", true, at(leaf3)));
			const leaf5 = stepTurn("s5", leaf3, "continue", said("Stopped mid-step."));
			dirty.settle(constraints, "Stopped mid-step.", false, at(leaf5), "s5-u");
			strictEqual(createStepStartTracker(store).begin(constraints, "continue", true, at(leaf5)), null);

			/** A live tracker that just settled step `id` after step three. */
			const settledStep = (id: string) => {
				const tracker = createStepStartTracker(store);
				ok(tracker.begin(constraints, "continue", true, at(leaf3)));
				const leaf = stepTurn(id, leaf3, "continue", said(`Step ${id} ran.`));
				tracker.settle(constraints, `Step ${id} ran.`, true, at(leaf), `${id}-u`);
				return { tracker, leaf };
			};
			/** What a reopen does first: replay the session onto its leaf. */
			const reopen = (leaf: string) => {
				const tracker = createStepStartTracker(store);
				tracker.reset({ sessionId, leafTurnId: null }, leaf);
				return tracker;
			};
			// m2b-D1: /tree away from a settled step leaf and back runs on full history, live and after a reopen alike.
			const awayAndBack = (tracker: ReturnType<typeof createStepStartTracker>, leaf: string) => {
				tracker.reset(at(leaf), leaf1);
				tracker.reset(at(leaf1), leaf);
				return tracker.begin(constraints, "continue", true, at(leaf));
			};
			const settled = settledStep("s6");
			const reopenedLeaf = settledStep("s7").leaf;
			deepStrictEqual(
				[awayAndBack(settled.tracker, settled.leaf), awayAndBack(reopen(reopenedLeaf), reopenedLeaf)],
				[null, null],
			);

			// A session switch writes nothing into the session left: returning resumes its chain, as a reopen does.
			const switchedLeaf = settledStep("s8").leaf;
			const switched = reopen(switchedLeaf);
			// chat-loop resets after the switch: the session is already the new one, the leaf still the one left.
			switched.reset({ sessionId: "other-session", leafTurnId: switchedLeaf }, "other-leaf");
			switched.reset({ sessionId, leafTurnId: "other-leaf" }, switchedLeaf);
			const resumed = switched.begin(constraints, "continue", true, at(switchedLeaf));
			ok(resumed?.includes("Step s8 ran."));
			strictEqual(reopen(switchedLeaf).begin(constraints, "continue", true, at(switchedLeaf)), resumed);

			// /tree draws a step checkpoint on the path it compacted, not as a sibling of the next step's turn.
			const checkpointId = "s9-checkpoint";
			session.appendEntry({
				kind: "compactionSummary",
				turnId: checkpointId,
				parentTurnId: reopenedLeaf,
				summary: "Step checkpoint.",
				tokensBefore: 100,
				firstKeptTurnId: "",
				messagesSummarized: 4,
				isSplitTurn: false,
				trigger: "step",
			} as SessionEntryInput);
			stepTurn("s9", reopenedLeaf, "continue", said("Step nine ran."));
			const tree = session.tree();
			deepStrictEqual(tree.nodesById[reopenedLeaf]?.children, [checkpointId]);
			strictEqual(tree.nodesById["s9-u"]?.parentId, checkpointId);
		} finally {
			await session.close();
		}
	});
});

describe("W3 (F11 -> CF-2): a historical render and a historical fork see the earlier state", () => {
	const BODY_A = body("A", 2_000);
	/** Send 1 at leaf r2 carries r1's body; an eviction at r2, then send 2 at r2 carries the marker. */
	function twoSendsAtOneLeaf(): SessionEntry[] {
		return [
			message("u1", null, "user", { text: "read both" }),
			readCall("a1", "u1", "c1", "src/a.ts"),
			readResult("r1", "a1", "c1", BODY_A),
			readCall("a2", "r1", "c2", "src/b.ts"),
			readResult("r2", "a2", "c2", "B"),
			eviction("ev", "r2", ["r1"]),
			message("a3", "r2", "assistant", { content: [{ type: "text", text: "done" }] }),
			message("u3", "a3", "user", { text: "next" }),
			message("a4", "u3", "assistant", { content: [{ type: "text", text: "ok" }] }),
		];
	}

	it("a render at a past position does not fold a later eviction", () => {
		const entries = twoSendsAtOneLeaf();
		const now = requestText(buildModelReplayAgentMessagesFromTurns(entries));
		ok(!now.includes(BODY_A) && now.includes("[evicted r1 as r1]"), "the tip renders the marker");
		// The position of send 1: the ledger through r2. The eviction was written after it.
		const historical = requestText(
			buildModelReplayAgentMessagesFromTurns(entries, { cursor: { hwm: "r2", leaf: "r2" } }),
		);
		ok(historical.includes(BODY_A), "the historical render keeps the body send 1 carried");
		ok(!historical.includes("[evicted r1 as r1]"), "and not the later marker");
	});

	/** An eviction anchored at a2 but written after a3: a fork at a2 is the state at a2's file position. */
	function laterEvictionOnAncestor(): SessionEntry[] {
		return [
			message("u1", null, "user", { text: "read it" }),
			readCall("a1", "u1", "c1", "src/a.ts"),
			readResult("r1", "a1", "c1", BODY_A),
			message("a2", "r1", "assistant", { content: [{ type: "text", text: "noted" }] }),
			message("u2", "a2", "user", { text: "next" }),
			message("a3", "u2", "assistant", { content: [{ type: "text", text: "ok" }] }),
			eviction("ev", "a2", ["r1"]),
		];
	}

	it("a fork at a2 copies only the display records written before a2's successor", async () => {
		const session: SessionContract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
		let childId: string;
		try {
			session.create({ cwd: process.cwd() });
			for (const entry of laterEvictionOnAncestor()) session.appendEntry(entry as SessionEntryInput);
			childId = session.fork("a2").id;
		} finally {
			await session.close();
		}
		const child = openSession(childId).turns() as SessionEntry[];
		strictEqual(
			child.filter((entry) => entry.kind === "contextEviction").length,
			0,
			"the eviction was written after u2, a2's successor on the path",
		);
		ok(requestText(buildModelReplayAgentMessagesFromTurns(child)).includes(BODY_A), "the child renders r1's body");
	});
});

describe("W4 and W5 (F2 -> CF-5): superseded selection over the rendered history", () => {
	const SIZE = 33 * 1024;

	it("W4: two identical 33 KB reads, the newer evicted: the request keeps the older body", {
		timeout: 30_000,
	}, async (t) => {
		const OLDER = body("OLDER", SIZE);
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		const seed = chatHarness({ server, route: { caching: false } });
		let id: string;
		try {
			id = seed.session.create({ cwd: process.cwd() }).id;
			for (const entry of [
				message("u1", null, "user", { text: "read it twice" }),
				readCall("a1", "u1", "c1", "src/big.ts"),
				readResult("r1", "a1", "c1", OLDER),
				readCall("a2", "r1", "c2", "src/big.ts"),
				readResult("r2", "a2", "c2", body("NEWER", SIZE)),
				message("a3", "r2", "assistant", { content: [{ type: "text", text: "read" }] }),
				eviction("ev", "a3", ["r2"]),
			])
				seed.session.appendEntry(entry as SessionEntryInput);
		} finally {
			await seed.close();
		}
		const reopened = chatHarness({ server, route: { caching: false } });
		try {
			reopened.reopen(id);
			await reopened.submit("go on");
		} finally {
			await reopened.close();
		}
		const request = server.requests.at(-1);
		ok(request);
		const sent = JSON.stringify(request.body);
		ok(sent.includes("[evicted r2 as r1]"), "the newer read is its marker");
		ok(sent.includes(OLDER), "a marker covers nothing: the older body stays");
	});

	/** An older full read and a newer identical read whose delivery `details` says how much it showed. */
	function repeated(newer: string, details: unknown): SessionEntry[] {
		return [
			message("u1", null, "user", { text: "read it twice" }),
			readCall("a1", "u1", "c1", "src/big.ts"),
			readResult("r1", "a1", "c1", body("OLDER", 40 * 1024)),
			readCall("a2", "r1", "c2", "src/big.ts"),
			readResult("r2", "a2", "c2", newer, details),
			message("a3", "r2", "assistant", { content: [{ type: "text", text: "read" }] }),
		];
	}
	/** The request a rebuild sends once S0 has committed what it selects over the ledger's replay. */
	const aged = (entries: SessionEntry[]): string => {
		const selected = superseded(entries);
		const record: SessionEntry[] =
			selected.length === 0
				? []
				: [
						{
							kind: "contextEviction",
							turnId: "s0",
							parentTurnId: entries.at(-1)?.turnId ?? null,
							timestamp: AT,
							policyId: "superseded-v1",
							trigger: "superseded",
							tokensBefore: 20_000,
							tokensAfter: 10_000,
							pressureBefore: null,
							snapshotIdBefore: null,
							evicted: selected.map((candidate, index) => ({
								alias: `r${index + 1}`,
								ref: candidate.ref,
								reason: candidate.reason,
								by: candidate.by,
								tokensFreed: 8_000,
								marker: `[evicted ${candidate.ref.entry} by ${candidate.by}]`,
							})),
						},
					];
		return requestText(buildModelReplayAgentMessagesFromTurns([...entries, ...record]));
	};

	it("W5: a clipped repeat is not a full cover after a rebuild", () => {
		const clipped = repeated(body("CLIPPED", 2_000), {
			observation: { truncated: true, shownCount: 1, shownBytes: 2_000 },
		});
		// The rebuilt request is the replay of the ledger; its results no longer carry `details`.
		ok(aged(clipped).includes(body("OLDER", 40 * 1024)), "a 2 KB slice does not stand in for a 40 KB read");
	});

	it("W5: a filtered repeat that showed nothing is not a cover after a rebuild", () => {
		const filtered = repeated("[read: output budget exhausted; nothing shown]", {
			observation: { truncated: true, shownCount: 0, shownBytes: 0 },
		});
		ok(aged(filtered).includes(body("OLDER", 40 * 1024)), "an empty delivery covers nothing");
	});

	it("W5: parallel identical calls completed in reverse: the earlier call's result is the one superseded", () => {
		const entries: SessionEntry[] = [
			message("u1", null, "user", { text: "read it twice at once" }),
			message("a1", "u1", "assistant", {
				content: [
					{ type: "toolCall", id: "c1", name: READ, arguments: { path: "src/big.ts" } },
					{ type: "toolCall", id: "c2", name: READ, arguments: { path: "src/big.ts" } },
				],
				stopReason: "toolUse",
			}),
			// The ledger holds c2's result first; render orders results by call, so c1's comes first in the request.
			readResult("r2", "a1", "c2", body("SECOND", 40 * 1024)),
			readResult("r1", "r2", "c1", body("FIRST", 40 * 1024)),
			message("a2", "r1", "assistant", { content: [{ type: "text", text: "read" }] }),
		];
		deepStrictEqual(
			superseded(entries).map((candidate) => [candidate.ref.entry, candidate.by]),
			[["r1", "r2"]],
		);
		const sent = aged(entries);
		ok(sent.includes(body("SECOND", 40 * 1024)), "the later call's copy stays");
		ok(!sent.includes(body("FIRST", 40 * 1024)), "the earlier call's copy leaves");
	});
});

describe("W11 (F2, F5 -> CF-5): a v6 aging record meets the fold", () => {
	const OLDER = body("OLDER", 33 * 1024);
	/** c1 was aged under cover of r2; r2 was evicted later, and that eviction also names r3. */
	function v6Ledger(): SessionEntry[] {
		return [
			message("u1", null, "user", { text: "read it three times" }),
			readCall("a1", "u1", "c1", "src/big.ts"),
			readResult("r1", "a1", "c1", OLDER),
			readCall("a2", "r1", "c2", "src/big.ts"),
			readResult("r2", "a2", "c2", body("MIDDLE", 33 * 1024)),
			{
				kind: "custom",
				turnId: "aging-1",
				parentTurnId: "r2",
				timestamp: AT,
				customType: OBSERVATION_AGING_CUSTOM_TYPE,
				data: observationAgingRecord(["c1"]),
			} as SessionEntry,
			readCall("a3", "r2", "c3", "src/other.ts"),
			readResult("r3", "a3", "c3", body("OTHER", 33 * 1024)),
			message("a4", "r3", "assistant", { content: [{ type: "text", text: "read" }] }),
			eviction("ev", "a4", ["r2", "r3"]),
		];
	}
	/** What a chat loop reopening session `id` sends on an uncached route. */
	async function open(server: CaptureServer, id: string): Promise<string> {
		const reopened = chatHarness({ server, route: { caching: false } });
		try {
			reopened.reopen(id);
			await reopened.submit("go on");
		} finally {
			await reopened.close();
		}
		const request = server.requests.at(-1);
		ok(request);
		return JSON.stringify(request.body);
	}

	it("first open, second open and a fork keep the body whose cover was lost", { timeout: 30_000 }, async (t) => {
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		const seed = chatHarness({ server, route: { caching: false } });
		let id: string;
		let childId: string;
		try {
			id = seed.session.create({ cwd: process.cwd() }).id;
			for (const entry of v6Ledger()) seed.session.appendEntry(entry as SessionEntryInput);
			childId = seed.session.fork("ev").id;
		} finally {
			await seed.close();
		}
		ok((await open(server, id)).includes(OLDER), "first open: the aged id's cover is a marker, so its body returns");
		ok((await open(server, id)).includes(OLDER), "second open: the same");
		ok((await open(server, childId)).includes(OLDER), "a fork at the tip: the same");
	});

	it("an id prepared for a request that is never sent is not recorded", { timeout: 30_000 }, async (t) => {
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		let handle: EngineAgentHandle | undefined;
		const harness = chatHarness({
			server,
			route: { caching: false },
			createAgent: (options) => {
				handle = createEngineAgent(options);
				return handle;
			},
		});
		try {
			// The chat loop builds its agent on the first submit.
			await harness.submit("hello");
			ok(handle);
			const agent = handle.agent;
			const leaf = harness.session.readEntries().at(-1)?.turnId;
			ok(leaf);
			for (const entry of [
				message("u1", leaf, "user", { text: "read it twice" }),
				readCall("a1", "u1", "c1", "src/big.ts"),
				readResult("r1", "a1", "c1", OLDER),
				readCall("a2", "r1", "c2", "src/big.ts"),
				readResult("r2", "a2", "c2", OLDER),
			])
				harness.session.appendEntry(entry as SessionEntryInput);
			const entries = harness.session.readEntries() as SessionEntry[];
			deepStrictEqual(
				superseded(entries).map((candidate) => candidate.toolCallId),
				["c1"],
				"S0 would select c1",
			);
			const prepared: string[] = [];
			const convert = agent.convertToLlm;
			agent.convertToLlm = async (messages) => {
				prepared.push(requestText(messages));
				return await convert(messages);
			};
			// The prewarm round prepares the request and then declines to send it (src/engine/prewarm.ts).
			const warm = await runPrewarmRound({
				model: agent.state.model,
				state: { ...agent.state, messages: buildModelReplayAgentMessagesFromTurns(entries) },
				agent,
				canSend: () => false,
			});
			strictEqual(warm.invoked, false);
			ok(
				prepared.some((text) => text.includes(OLDER)),
				"the prepared request carried c1",
			);
			const after = harness.session.readEntries() as SessionEntry[];
			deepStrictEqual(
				after
					.filter((entry) => entry.kind === "contextEviction" || entry.kind === "custom")
					.filter((entry) => JSON.stringify(entry).includes('"r1"') || JSON.stringify(entry).includes('"c1"')),
				[],
				"nothing is recorded before an attempt is dispatched",
			);
		} finally {
			await harness.close();
		}
	});
});

describe("W9 (F12 -> CF-3): a run judges its own evidence, not the projected array", () => {
	it("the step outcome survives a cut inside the submit", () => {
		const STEP = "extension_wtfp__next_step";
		const entries: SessionEntry[] = [
			message("u1", null, "user", { text: "/wtfp:advance" }),
			message("a1", "u1", "assistant", {
				content: [{ type: "toolCall", id: "s1", name: STEP, arguments: {} }],
				stopReason: "toolUse",
			}),
			message("r1", "a1", "tool_result", {
				toolCallId: "s1",
				toolName: STEP,
				result: { content: [{ type: "text", text: "step: draft intro" }] },
			}),
			readCall("a2", "r1", "c2", "src/intro.md"),
			readResult("r2", "a2", "c2", "intro"),
			{
				kind: "compactionSummary",
				turnId: "cut",
				parentTurnId: "r2",
				timestamp: AT,
				summary: "The step drafted the intro.",
				tokensBefore: 60_000,
				firstKeptTurnId: "a2",
			} as SessionEntry,
		];
		// The submit's runs settled these messages before the cut; the cut rebuilds only the projected array.
		const log = new RunEvidenceLog();
		const submit = log.beginSubmit();
		log.beginAttempt();
		for (const settled of buildModelReplayAgentMessagesFromTurns(entries.slice(0, 5))) log.record(settled);
		const projected = buildModelReplayAgentMessagesFromTurns(entries);
		strictEqual(lastToolCallOf(projected)?.tool, READ);
		strictEqual(stepTurnOutcome(projected, STEP), null, "the projection lost the step call");
		deepStrictEqual(stepTurnOutcome(submit.messages(), STEP), { pipelineDone: false }, "the submit ran its step");
		// A later attempt that fails before any output judges only itself; the submit still holds the step.
		log.beginAttempt();
		log.record({ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } as never);
		strictEqual(recoveryAttemptHasOutput(log.attempt()), false);
		ok(recoveryAttemptHasOutput(submit.messages()));
	});

	it("a machine turn retries a later run that dropped before output and counts each call once", {
		timeout: 30_000,
	}, async (t) => {
		// A tool round, a reply cut off while thinking (dropped from the array and re-run), a connection dropped
		// before output on that re-run, then the answer.
		const server = await startCaptureServer((_request, index) =>
			index === 0
				? { calls: [{ id: "c1", name: READ, arguments: { path: "src/intro.md" } }] }
				: index === 1
					? { thinkingOnlyLength: "deliberating" }
					: index === 2
						? { drop: true }
						: { text: "intro drafted" },
		);
		t.after(() => server.close());
		const harness = chatHarness({ server });
		harness.settings.chat.retry = { ...harness.settings.chat.retry, baseDelayMs: 0, maxDelayMs: 0 };
		try {
			const sessionId = harness.session.create({ cwd: process.cwd() }).id;
			const result = await harness.loop.submitMachineTurn?.({
				jobId: "job-1",
				executionId: "run-1",
				text: "draft the intro",
				origin: "job job-1 run-1",
				sessionId,
				isAdmissionCurrent: () => true,
				signal: new AbortController().signal,
				onStarting: () => true,
			});
			strictEqual(server.requests.length, 4, "the dropped re-run was retried");
			ok(harness.events.some((event) => event.type === "retry_status"));
			strictEqual(result?.status, "succeeded", result?.reason);
			strictEqual(result?.text, "intro drafted");
			// Three calls answered at 12 tokens each, the cut-off reply among them though the array dropped it, and the
			// dropped call unmeasured.
			strictEqual(result?.usage?.tokens.measured, 36);
			strictEqual(result?.usage?.tokens.unknownCount, 1);
		} finally {
			await harness.close();
		}
	});

	it("a machine turn whose ladder is exhausted settles on the failed attempt, not an earlier round's text (#445)", {
		timeout: 30_000,
	}, async (t) => {
		// A tool round with text, a reply cut off while thinking (re-run), then two drops before output against one retry.
		const server = await startCaptureServer((_request, index) =>
			index === 0
				? { text: "Reading the intro first.", calls: [{ id: "c1", name: READ, arguments: { path: "src/intro.md" } }] }
				: index === 1
					? { thinkingOnlyLength: "deliberating" }
					: { drop: true },
		);
		t.after(() => server.close());
		const harness = chatHarness({ server });
		harness.settings.chat.retry = { ...harness.settings.chat.retry, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 };
		try {
			const sessionId = harness.session.create({ cwd: process.cwd() }).id;
			const result = await harness.loop.submitMachineTurn?.({
				jobId: "job-1",
				executionId: "run-1",
				text: "draft the intro",
				origin: "job job-1 run-1",
				sessionId,
				isAdmissionCurrent: () => true,
				signal: new AbortController().signal,
				onStarting: () => true,
			});
			strictEqual(server.requests.length, 4, "the dropped re-run was retried once, then the ladder gave up");
			match(JSON.stringify(server.requests[1]), /Reading the intro first\./u, "an earlier round has text");
			ok(harness.events.some((event) => event.type === "retry_status" && event.status.phase === "exhausted"));
			strictEqual(result?.status, "failed");
			match(result?.reason ?? "", /^Connection error\./u);
			// The final message is the failed attempt, though the exhausted ladder pruned it from the array.
			strictEqual(result?.text, "");
			// The job summary (job-runtime.ts) is the reply text or else the reason: here the reason.
			strictEqual(result?.text || result?.reason, result?.reason);
		} finally {
			await harness.close();
		}
	});
});

describe("W10 (F10 -> CF-10): the council peer briefing", () => {
	it("five seats, an oversized original briefing, multibyte answers and a failed seat: every peer is labeled", {
		timeout: 30_000,
	}, async (t) => {
		const labels = ["a", "b", "c", "d", "e"];
		const seated: DispatchRequest[] = [];
		// The clips are read back from the session's own journal on disk, written through the real producer and sink:
		// the dispatch tool runs under a gate host run whose journal opens only at its seal (bt-47 m2c-1).
		const sessionId = "w10-session";
		const root = await mkdtemp(path.join(tmpdir(), "w10-journal-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const directory = telemetrySessionDirectory(path.join(root, "state"), sessionId);
		const writer = { clioCoderVersion: "0.0.0-test", piVersion: "test" };
		const journal = await openCallJournal({
			directory,
			context: { sessionId, agent: { role: "main", id: sessionId } },
			writer,
		});
		const PROVIDER_CAUSE =
			"exit code 1; stderr: [worker] provider answered http 400\n400: Invalid model name passed in model=mini/zz";
		let next = 0;
		const tool = createDispatchTool({
			dispatch: {
				dispatch: async (request: DispatchRequest) => {
					seated.push(request);
					next += 1;
					const label = request.council?.label ?? "member";
					const runId = `run-${next}-${label}`;
					// Seat c fails every round, so the judge as well as the second round sees a failed seat.
					const failed = label === "c";
					const answer = `${label} answers: ${"é".repeat(1_500)}`;
					const receipt = {
						...fixtureReceiptDraft(fixtureEnvelope(runId)),
						agentId: request.agentId,
						exitCode: failed ? 1 : 0,
						outcome: failed ? "failed" : "succeeded",
						outcomeDetail: failed ? PROVIDER_CAUSE : null,
						...(request.council ? { council: request.council } : {}),
						...(request.gate ? { gate: request.gate } : {}),
					} as RunResultDraft;
					// A settled seat's result object sits in its run scope, where the council profile's read reaches it.
					if (!failed) {
						const resultPath = runResultPath(receipt);
						mkdirSync(path.dirname(resultPath), { recursive: true });
						writeFileSync(resultPath, JSON.stringify({ output: { text: answer } }));
					}
					const events = (async function* () {
						yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } };
					})();
					return { runId, events, finalPromise: Promise.resolve(receipt) };
				},
				abort() {},
				getRun: () => undefined,
			} as unknown as DispatchContract,
			getAgentSpecs: () => [{ id: "scout" }] as never,
			getAutonomy: () => "yolo",
		});
		try {
			await withTelemetryContext({ sessionId, agent: { role: "main", id: sessionId } }, () =>
				tool.run(
					{
						mode: "council",
						members: labels.map((label) => ({ label, target: "mini" })),
						rounds: 2,
						synthesis: "judge",
						briefing: `Background: ${"context ".repeat(1_400)}`.slice(0, 11_500),
						task: "Which module owns the clock?",
					},
					{ sessionId, hostRun: { runId: "w10-host-run", lineage: { rootRunId: "w10-host-run", depth: 0 } } } as never,
				),
			);
		} finally {
			await journal.close();
		}
		const first = seated.filter((request) => request.council?.round === 1 && request.gate?.role === "member");
		strictEqual(first.length, labels.length, "every seat sits a first round");
		for (const request of first) {
			const briefing = request.briefing ?? "";
			ok(Buffer.byteLength(briefing, "utf8") <= 8 * 1024, "the round-1 briefing is within the cap");
			match(
				briefing,
				/^\[council\] [\s\S]*\n\nBackground: context[\s\S]*\[clio: \d+ of \d+ bytes omitted from this excerpt\]/u,
			);
		}
		const second = seated.filter((request) => request.council?.round === 2 && request.gate?.role === "member");
		strictEqual(second.length, labels.length, "every seat sits a second round");
		for (const request of second) {
			const briefing = request.briefing ?? "";
			for (const peer of labels.filter((label) => label !== request.council?.label))
				ok(briefing.includes(`[${peer}]`), `${request.council?.label}'s briefing names peer ${peer}`);
		}
		const judge = seated.filter((request) => request.gate?.role === "synthesis");
		strictEqual(judge.length, 1, "the judge is dispatched once");
		const COUNCIL_BRIEFING_CAP = 8 * 1024;
		for (const request of [...second, ...judge]) {
			const recipient = request.council?.label;
			const briefing = request.briefing ?? "";
			ok(Buffer.byteLength(briefing, "utf8") <= COUNCIL_BRIEFING_CAP, `${recipient}'s briefing is within the cap`);
			ok(!briefing.includes("\uFFFD"), `${recipient}'s briefing carries no replacement character`);
			// Both paths give the failed seat its provider cause on one line.
			const failedStatus = `${
				request.gate?.role === "synthesis"
					? "[c] failed; no final answer contributed."
					: "[c] failed in prior round; no answer contributed."
			} Reason: outcome=failed: ${PROVIDER_CAUSE.replace("\n", " ")}`;
			for (const peer of labels.filter((label) => label !== recipient)) {
				strictEqual(briefing.split(`[${peer}]`).length, 2, `${recipient}'s briefing shows seat ${peer} exactly once`);
				if (peer === "c") ok(briefing.includes(failedStatus), `${recipient}'s briefing gives seat c its failure status`);
				else {
					const excerpt = briefing.split("\n\n").find((segment) => segment.startsWith(`[${peer}] `)) ?? "";
					ok(
						excerpt.startsWith(`[${peer}] ${peer} answers: ${"é".repeat(16)}`) && excerpt.endsWith("é".repeat(16)),
						`${recipient}'s excerpt of seat ${peer} keeps whole é runs at its head and tail`,
					);
					const pointer = /; read output\.text in (\S+) for the whole answer\]/u.exec(excerpt);
					ok(
						pointer?.[1] !== undefined && existsSync(pointer[1]),
						`${recipient}'s notice for ${peer} names a path that exists`,
					);
				}
			}
		}
		for (const request of second)
			ok(
				(request.briefing ?? "").includes("[original briefing] Background: context"),
				"the member path counts the original briefing",
			);
		ok(!(judge[0]?.briefing ?? "").includes("[original briefing]"), "the judge carries the task outside its briefing");
		match(judge[0]?.task ?? "", /Which module owns the clock\?/u);
		const clipped = (await readCallJournal(directory)).records
			.filter(({ record }) => record.k === "context.briefing_clipped")
			.map(({ record }) => record.data as EventPayload<"context.briefing_clipped">);
		deepStrictEqual(
			clipped.map((event) => `${event.role}:${event.round}`).sort(),
			[...first.map(() => "member:1"), ...second.map(() => "member:2"), "synthesis:2"].sort(),
			"each clipped briefing is journaled in the session that convened the council",
		);
		// A report share of the live session keeps each clip's parts and hashes its run and group ids.
		const { scopes, skipped } = resolveShareScopes(path.join(root, "state"), {
			sessions: [sessionId],
			runs: [],
			repo: null,
			since: null,
			until: null,
			live: "snapshot",
		});
		const report = planShare({ scopes, skipped, profile: "report", source: freshShareSource(), writer });
		const archivePath = path.join(root, "report.tar.gz");
		await writeShare(report, archivePath);
		strictEqual(verifyShareArchive(await readFile(archivePath)).failure, null, "the report share verifies");
		const shared = scanTelemetrySegment(report.scopes[0]?.journal ?? Buffer.alloc(0)).rows.flatMap((row) =>
			row.kind === "record" && row.record.k === "context.briefing_clipped"
				? [row.record.data as EventPayload<"context.briefing_clipped">]
				: [],
		);
		strictEqual(shared.length, clipped.length, "every clip reaches the share");
		for (const [index, event] of clipped.entries()) {
			const copy = shared[index];
			ok(copy, `clip ${index} is shared`);
			deepStrictEqual(copy.parts, event.parts, "the share keeps the clip's parts");
			ok(copy.runId.startsWith("anon_") && copy.runId !== event.runId, "the share hashes the clip's run id");
			ok(copy.group.startsWith("anon_") && copy.group !== event.group, "the share hashes the clip's group");
		}
		for (const event of clipped) {
			strictEqual(event.capBytes, COUNCIL_BRIEFING_CAP);
			ok(event.bytes <= COUNCIL_BRIEFING_CAP && event.parts.length > 0);
			ok(event.parts.every((part) => part.bytesAfter < part.bytesBefore));
		}
	});

	/**
	 * The seed assertion (SPEC §3.3 "Seeds", F1: a worker seed carries bodies the parent's request stubs). The parent
	 * sends c1, an older 33 KB read that an identical newer read supersedes, as a stub; a forked seat's seed must carry
	 * c1 as the parent's request did. S0 rewrites the agent history the seed is captured from, so the stub reaches the
	 * seed. S0 acts only on an uncached route, so the setup pins the parent's route to `promptCaching: false`; on a
	 * cached route the parent keeps c1's body and so must the seed.
	 */
	it("a forked seat's seed carries c1 as the parent's request sent it", { timeout: 30_000 }, async (t) => {
		const SIZE = 33 * 1024;
		const OLDER = body("OLDER", SIZE);
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		const seed = chatHarness({ server, route: { caching: false } });
		let id: string;
		try {
			id = seed.session.create({ cwd: process.cwd() }).id;
			for (const entry of [
				message("u1", null, "user", { text: "read it twice" }),
				readCall("a1", "u1", "c1", "src/big.ts"),
				readResult("r1", "a1", "c1", OLDER),
				readCall("a2", "r1", "c2", "src/big.ts"),
				readResult("r2", "a2", "c2", body("NEWER", SIZE)),
				message("a3", "r2", "assistant", { content: [{ type: "text", text: "read" }] }),
			])
				seed.session.appendEntry(entry as SessionEntryInput);
		} finally {
			await seed.close();
		}
		const parent = chatHarness({ server, route: { caching: false } });
		const seated: DispatchRequest[] = [];
		try {
			const parentRoute = resolveRuntimeTarget(parent.context.getContract("providers") as ProvidersContract, {
				targetId: parent.settings.chat.target,
			});
			ok(parentRoute.ok, "the parent's route resolves");
			strictEqual(
				parentRoute.target.promptCaching,
				false,
				"S0 acts only on an uncached route; a cached parent keeps c1's body and the seed must too",
			);
			parent.reopen(id);
			await parent.submit("go on");
			const tool = createDispatchTool({
				dispatch: {
					dispatch: async (request: DispatchRequest) => {
						seated.push(request);
						const runId = `run-seed-${seated.length}`;
						const events = (async function* () {})();
						return {
							runId,
							events,
							finalPromise: Promise.resolve({ runId, agentId: request.agentId, exitCode: 0, outcome: "succeeded" }),
						};
					},
					abort() {},
					getRun: () => undefined,
				} as unknown as DispatchContract,
				getAgentSpecs: () => [{ id: "scout" }] as never,
				getAutonomy: () => "yolo",
				captureWorkerContext: () => parent.loop.captureWorkerContext?.() ?? null,
			});
			await tool.run({ agent: "scout", task: "Which module owns the clock?", context: { mode: "fork" } }, {} as never);
		} finally {
			await parent.close();
		}
		const request = server.requests.at(-1);
		ok(request);
		const sentMessages = (
			request.body as { messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }> }
		).messages;
		const sent = sentMessages?.find((entry) => entry.role === "tool" && entry.tool_call_id === "c1");
		ok(sent, "the parent's request carries c1");
		const sentText = typeof sent.content === "string" ? sent.content : JSON.stringify(sent.content);
		ok(!sentText.includes(OLDER), "the parent's request stubs the superseded read");
		const seedMessages = seated[0]?.contextSeed?.messages ?? [];
		ok(seedMessages.length > 0, "the seat is seeded from the parent's history");
		const seeded = seedMessages.find(
			(entry) => entry.role === "toolResult" && (entry as { toolCallId?: string }).toolCallId === "c1",
		) as { content?: Array<{ type: string; text?: string }> } | undefined;
		ok(seeded, "the seed carries c1");
		const seededText = (seeded.content ?? []).map((block) => block.text ?? "").join("");
		ok(!seededText.includes(OLDER), "a worker seed carries no body the parent's request stubbed");
		strictEqual(seededText, sentText, "the seed carries c1 as the parent's request sent it");
	});
});

const probeTool = (run: () => void): ToolSpec => ({
	name: "probe" as ToolSpec["name"],
	description: "Moves host state between two requests of one turn",
	parameters: Type.Object({}),
	baseActionClass: "read",
	run: async () => {
		run();
		return { kind: "ok", output: "probed" };
	},
});

describe("W1 and W2 (F6 -> CF-4): host inserts are records", () => {
	const PINS = ["Milestone 3: results. Next: verify", "Milestone 4: review. Next: submit"];
	const OLD = "old ".repeat(25_000);
	/**
	 * Two large turns a compaction can cut, then one turn whose tool moves the pinned block twice, so two later
	 * requests of the turn each carry a host insert. The forced compaction keeps that turn as its suffix.
	 */
	async function liveTurn(server: CaptureServer) {
		const pins = [{ extensionId: "desk", text: "Milestone 2: methods. Next: plan-section" }];
		let moves = 0;
		const harness = chatHarness({
			server,
			autoCompact: true,
			pinnedContext: () => pins,
			tools: [probeTool(() => pins.splice(0, 1, { extensionId: "desk", text: PINS[moves++] ?? "" }))],
		});
		const id = harness.session.create({ cwd: process.cwd() }).id;
		await harness.submit("survey the field");
		await harness.submit("survey it again");
		await harness.submit("draft the results");
		await harness.submit("keep going");
		return { harness, pins, id };
	}
	/** Rebuilds the live history from the ledger the way a compaction does, then sends one more request. */
	async function rebuild(harness: Awaited<ReturnType<typeof liveTurn>>["harness"]) {
		const before = harness.counter.summaries;
		await harness.loop.compact();
		await harness.loop.whenSettled();
		ok(harness.counter.summaries > before, "the compaction ran");
		await harness.submit("after a rebuild");
	}
	const script = (_request: CapturedRequest, index: number) =>
		index < 2
			? { text: OLD }
			: index < 4
				? { calls: [{ id: `p${index}`, name: "probe", arguments: {} }] }
				: { text: `answer ${index}` };
	/** The standalone host-insert elements a request carries; a pin re-rendered into a new prompt is not one. */
	const inserts = (request: CapturedRequest | undefined): string[] =>
		request === undefined
			? []
			: withoutSystem(request).filter(
					(element) => element.startsWith("user:<system-reminder>") && element.endsWith("</system-reminder>"),
				);
	/** The insert turn and its follow-up as the request carries them: the suffix every compaction here keeps. */
	const kept = (request: CapturedRequest | undefined): string[] => {
		if (request === undefined) return [];
		const elements = withoutSystem(request);
		const start = elements.indexOf("user:draft the results");
		const end = elements.indexOf("user:keep going");
		return start < 0 || end < start ? [] : elements.slice(start, end + 1);
	};

	it("W1, W2: the kept element sequence with both inserts is the same live, rebuilt and reopened", {
		timeout: 60_000,
	}, async (t) => {
		const server = await startCaptureServer(script);
		t.after(() => server.close());
		const { harness, pins, id } = await liveTurn(server);
		strictEqual(inserts(server.requests.at(-1)).length, 2, "the live history holds both inserts");
		const expected = kept(server.requests.at(-1));
		ok(expected.length > 4, "the live request carries the insert turn");
		try {
			await rebuild(harness);
		} finally {
			await harness.close();
		}
		deepStrictEqual(kept(server.requests.at(-1)), expected, "a rebuild keeps the live sequence");
		const reopened = chatHarness({ server, pinnedContext: () => pins });
		try {
			reopened.reopen(id);
			await reopened.submit("after a reopen");
		} finally {
			await reopened.close();
		}
		deepStrictEqual(kept(server.requests.at(-1)), expected, "a reopen keeps it too");
	});
});

describe("W2 (F6 -> CF-4): the full element sequence with inserts", () => {
	const REMINDER: AgentMessage = { role: "user", content: "<system-reminder>pending</system-reminder>", timestamp: 1 };
	const RESTORATION: AgentMessage = {
		role: "user",
		content: "<system-reminder>restored</system-reminder>",
		timestamp: 2,
	};
	const flat = (messages: ReadonlyArray<AgentMessage>): string[] =>
		messages.map((item) => {
			const content = (item as { content?: unknown }).content;
			const blocks = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
			const text =
				typeof content === "string"
					? content
					: blocks.every((block) => block.type === "text")
						? blocks.map((block) => block.text).join("")
						: JSON.stringify(content);
			return `${item.role}:${text}`;
		});
	const once = (elements: string[], insert: AgentMessage): number => {
		const [text] = flat([insert]);
		strictEqual(elements.filter((element) => element === text).length, 1, `${text} renders once`);
		return elements.indexOf(text ?? "");
	};
	/** One session the way the loop keeps it: each row converted onto the live history as it is written. */
	function ledger() {
		const session: SessionContract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
		const id = session.create({ cwd: process.cwd() }).id;
		let leaf: string | null = null;
		const runtime = { agent: { state: { messages: [] as AgentMessage[] } } };
		const inserts = createHostInserts({ session, readSessionEntries: () => session.readEntries(), leaf: () => leaf });
		const render = (entries: ReadonlyArray<SessionEntry>) =>
			flat(buildModelReplayAgentMessagesFromTurns(entries, leaf ? { activeLeafTurnId: leaf } : {}));
		const write = (...rows: MessageEntry[]) => {
			for (const row of rows) session.appendEntry(row as SessionEntryInput);
			leaf = rows.at(-1)?.turnId ?? leaf;
		};
		const row = (...rows: MessageEntry[]) => {
			write(...rows);
			runtime.agent.state.messages.push(...buildModelReplayAgentMessagesFromTurns(rows));
		};
		/** A checkpoint commits: the shared publication re-issues, then the live history is rebuilt from the ledger. */
		const checkpoint = (kept: string | null) => {
			session.appendEntry({
				kind: "compactionSummary",
				turnId: "cp",
				parentTurnId: kept ?? leaf,
				summary: "the checkpoint",
				tokensBefore: 10_000,
				firstKeptTurnId: kept ?? "",
				messagesSummarized: 4,
				isSplitTurn: false,
				trigger: kept === null ? "step" : "force",
			} as SessionEntryInput);
			inserts.reissueUnsent();
			runtime.agent.state.messages = buildModelReplayAgentMessagesFromTurns(
				session.readEntries(),
				leaf ? { activeLeafTurnId: leaf } : {},
			);
		};
		const live = () => flat(runtime.agent.state.messages);
		const rebuilt = () => render(session.readEntries());
		const selected = (turnId: string) =>
			flat(buildModelReplayAgentMessagesFromTurns(session.readEntries(), { uptoTurnId: turnId }));
		const reopened = async () => {
			await session.close();
			return render(openSession(id).turns() as SessionEntry[]);
		};
		const resume = (turnId: string) => {
			session.resume(id);
			leaf = turnId;
		};
		return { session, inserts, runtime, row, write, checkpoint, live, rebuilt, selected, reopened, resume };
	}
	const assistant = (turnId: string, parent: string, text: string) =>
		message(turnId, parent, "assistant", { content: [{ type: "text", text }], stopReason: "stop" });
	const user = (turnId: string, parent: string | null, text: string) => message(turnId, parent, "user", { text });

	for (const cut of ["a full cut", "a kept suffix"] as const)
		for (const sent of [false, true])
			it(`after ${cut}, ${sent ? "after a send with no reply" : "before send"}: live, rebuilt and reopened agree`, async () => {
				const l = ledger();
				l.row(user("u1", null, "first"), assistant("a1", "u1", "one"));
				l.row(user("u2", "a1", "second"));
				l.inserts.insert(l.runtime, "reminder", [REMINDER]);
				deepStrictEqual(l.rebuilt(), l.live(), "the record renders where the live history holds it");
				if (sent) l.inserts.dispatched();
				l.checkpoint(cut === "a full cut" ? null : "u2");
				const rebuilt = l.rebuilt();
				deepStrictEqual(l.live(), rebuilt, "the rebuilt live history is the render");
				if (cut === "a full cut" && sent) {
					// The request that carried it is summarized history now; a portable summary does not carry inserts.
					ok(!rebuilt.some((element) => element === flat([REMINDER])[0]), "a sent insert is not re-issued");
				} else {
					const at = once(rebuilt, REMINDER);
					strictEqual(at, rebuilt.length - 1, "it stays at the tail, after the checkpoint or its kept anchor");
					if (cut === "a kept suffix") strictEqual(rebuilt[at - 1], "user:second");
				}
				l.row(user("u3", "u2", "after"));
				const next = l.live();
				deepStrictEqual(l.rebuilt(), next, "the next request renders as live");
				deepStrictEqual(await l.reopened(), next, "and a reopen renders the same");
			});

	it("a dispatch in another session leaves this session's unsent insert pending", () => {
		const l = ledger();
		l.row(user("u1", null, "first"), assistant("a1", "u1", "one"));
		l.row(user("u2", "a1", "second"));
		l.inserts.insert(l.runtime, "reminder", [REMINDER]);
		l.session.create({ cwd: process.cwd() });
		l.write(user("b1", null, "other session"));
		l.inserts.dispatched();
		l.resume("u2");
		l.checkpoint(null);
		const rebuilt = l.rebuilt();
		strictEqual(once(rebuilt, REMINDER), rebuilt.length - 1, "the cut re-issues it after the checkpoint");
	});

	it("one submit with restoration and queued steering: live, rebuilt and reopened agree", async () => {
		const l = ledger();
		l.row(user("u1", null, "first"), assistant("a1", "u1", "one"));
		// The user row is written, the restoration is installed before it, then the engine takes the prompt.
		const prompt = user("u2", "a1", "second");
		l.write(prompt);
		l.inserts.insert(l.runtime, "memory-restoration", [RESTORATION], { before: "u2" });
		l.runtime.agent.state.messages.push(...buildModelReplayAgentMessagesFromTurns([prompt]));
		l.inserts.dispatched();
		l.row(readCall("a2", "u2", "c2", "src/a.ts"), readResult("r2", "a2", "c2", "body"));
		l.inserts.insert(l.runtime, "reminder", [REMINDER]);
		// The steering the operator queued lands after the tail reminder, then the reply.
		l.row(user("s", "r2", "also check b"), assistant("a3", "s", "done"));
		const live = l.live();
		deepStrictEqual(l.rebuilt(), live, "the render places both inserts where the live history holds them");
		strictEqual(live[once(live, RESTORATION) + 1], "user:second", "the restoration leads its user row");
		strictEqual(live[once(live, REMINDER) + 1], "user:also check b", "the reminder precedes the steering");
		l.checkpoint("u2");
		const rebuilt = l.rebuilt();
		const keptFrom = live.indexOf(flat([RESTORATION])[0] ?? "");
		deepStrictEqual(rebuilt.slice(-(live.length - keptFrom)), live.slice(keptFrom), "the kept submit is the live one");
		strictEqual(rebuilt[once(rebuilt, RESTORATION) + 1], "user:second", "a kept submit keeps its restoration");
		strictEqual(rebuilt[once(rebuilt, REMINDER) + 1], "user:also check b");
		deepStrictEqual(await l.reopened(), rebuilt, "a reopen renders the same");
	});

	it("a /tree selection of a user row keeps the restoration its request carried", () => {
		const l = ledger();
		l.row(user("u1", null, "first"), assistant("a1", "u1", "one"));
		const prompt = user("u2", "a1", "second");
		l.write(prompt);
		l.inserts.insert(l.runtime, "memory-restoration", [RESTORATION], { before: "u2" });
		l.runtime.agent.state.messages.push(...buildModelReplayAgentMessagesFromTurns([prompt]));
		const sent = l.live();
		l.inserts.dispatched();
		l.row(assistant("a2", "u2", "two"));
		deepStrictEqual(l.selected("u2"), sent, "the selection renders what the request at u2 carried, ending at u2");
	});

	it("a cut that keeps a recovered reply but not its user row drops the reply and the exchange together", () => {
		const l = ledger();
		l.row(user("u1", null, "first"), assistant("a1", "u1", "one"));
		l.row(user("u2", "a1", "second"));
		l.write(
			message("t", "u2", "assistant", { content: [{ type: "thinking", thinking: "deliberating" }], stopReason: "length" }),
		);
		const exchange = thinkingLengthRecoveryMessages({ provider: "p", api: "openai-completions", model: "m" });
		const call = exchange[0] as AgentMessage;
		const callRow = l.inserts.reserveRowId(call);
		l.inserts.record("thinking-length-recovery", exchange, { replaces: ["t", callRow], exclude: ["t"] });
		l.inserts.dispatched();
		l.write(message(callRow, "t", "assistant", { ...call }), assistant("f", callRow, "final"));
		const answered = (elements: string[]) =>
			elements.filter((element) => element.startsWith("assistant:") && element.includes("clio_thinking_length_reprompt"))
				.length === elements.filter((element) => element.startsWith("toolResult:")).length;
		ok(answered(l.rebuilt()), "before the cut the call is answered");
		l.checkpoint("t");
		const rebuilt = l.rebuilt();
		ok(answered(rebuilt), "after the cut the call and its result are kept or dropped together");
		ok(!rebuilt.some((element) => element.includes("deliberating")), "the discarded reply stays discarded");
		strictEqual(rebuilt.at(-1), "assistant:final");
	});
});

describe("W8 (F13 -> CF-4): recovery exchanges are records", () => {
	const LOOP = "The same sentence keeps coming back to the start again and again. ".repeat(90);
	/** Each call id a request carries with the result that answers it, in order. */
	const pairs = (request: CapturedRequest): Array<[string, string | undefined]> => {
		const messages = (request.body.messages as Array<Record<string, unknown>> | undefined) ?? [];
		const out: Array<[string, string | undefined]> = [];
		messages.forEach((entry, index) => {
			for (const call of (entry.tool_calls as Array<{ id: string }> | undefined) ?? []) {
				const answer = messages.slice(index + 1).find((later) => later.role === "tool" && later.tool_call_id === call.id);
				out.push([call.id, answer?.tool_call_id as string | undefined]);
			}
		});
		return out;
	};
	const cases: Array<{
		name: string;
		recovery: number;
		tool: string;
		reply: (index: number) => CaptureReply;
		withTools?: true;
		stopped?: string;
	}> = [
		{
			name: "a thinking-length recovery exchange",
			recovery: 1,
			tool: "clio_thinking_length_reprompt",
			reply: (index) => (index === 0 ? { thinkingOnlyLength: "deliberating at length" } : { text: `answer ${index}` }),
		},
		{
			name: "a repetition recovery exchange",
			recovery: 1,
			tool: "clio_repetition_reprompt",
			reply: (index) => (index === 0 ? { text: LOOP } : { text: `answer ${index}` }),
			stopped: "keeps coming back to the start",
		},
		{
			name: "a locked-synthesis recovery exchange",
			recovery: 2,
			tool: "clio_synthesis_reprompt",
			withTools: true,
			reply: (index) =>
				index === 0
					? { calls: [{ id: "p0", name: "probe", arguments: {} }] }
					: index === 1
						? { text: lockedSynthesisFallbackText() }
						: { text: `answer ${index}` },
		},
	];
	for (const row of cases) {
		it(`${row.name} is the same in the next request live and after a reopen`, { timeout: 30_000 }, async (t) => {
			const server = await startCaptureServer((_request, index) => row.reply(index));
			t.after(() => server.close());
			let bus: { emit(channel: string, payload: unknown): void } | undefined;
			// The loop guard's lockout, raised while the turn's one tool runs.
			const lockout = () => bus?.emit("safety.loop_blocked", { disposition: "lockout", tool: "probe" });
			const harness = chatHarness({ server, ...(row.withTools ? { tools: [probeTool(lockout)] } : {}) });
			bus = harness.context.bus as typeof bus;
			let id: string;
			try {
				id = harness.session.create({ cwd: process.cwd() }).id;
				await harness.submit("solve it");
				const recovery = server.requests[row.recovery];
				ok(recovery, "the cut-off reply was recovered once");
				const elements = withoutSystem(recovery);
				ok(elements.includes("user:solve it"), "the recovery request keeps the original user content");
				ok(
					elements.some((element) => element.startsWith("call:")) && elements.some((e) => e.startsWith("result:")),
					"and carries the paired exchange",
				);
				strictEqual(elements.filter((element) => element.startsWith(`call:${row.tool}(`)).length, 1, "the recovery call");
				for (const [call, result] of pairs(recovery)) strictEqual(result, call, "every call is answered by its id");
				if (row.stopped) ok(!requestText(elements as never).includes(row.stopped), "the stopped reply is not resent");
				await harness.submit("next");
			} finally {
				await harness.close();
			}
			const live = server.requests.at(-1);
			ok(live);
			const reopened = chatHarness({ server });
			try {
				reopened.reopen(id);
				await reopened.submit("next");
			} finally {
				await reopened.close();
			}
			const resumed = server.requests.at(-1);
			ok(resumed);
			const expected = withoutSystem(live);
			deepStrictEqual(withoutSystem(resumed).slice(0, expected.length), expected, "a reopen replays the exchange");
			deepStrictEqual(pairs(resumed).slice(0, pairs(live).length), pairs(live), "with the same paired ids");
			strictEqual(
				withoutSystem(resumed).filter((element) => element.startsWith(`call:${row.tool}(`)).length,
				1,
				"and the recovery call once",
			);
			ok(withoutSystem(resumed).includes("user:solve it"), "and the original user content");
		});
	}
});

describe("W13 (F15 -> CF-2): admission prices the attempt it sends", () => {
	const lockNone = (): MiddlewareToolChoiceControl => ({
		apply() {},
		current: () => ({ kind: "none" }),
		toolStarted() {},
		completeRound: () => null,
		reset() {},
	});
	const auto = (): MiddlewareToolChoiceControl => ({ ...lockNone(), current: () => ({ kind: "auto" }) });

	it("a middleware none lock sent as auto is priced with its directive at the fit boundary", {
		timeout: 120_000,
	}, async (t) => {
		// The route rejects tool_choice "none", so a middleware text lock goes out as "auto" with the directive.
		const server = await startCaptureServer((request) =>
			request.body.tool_choice === "none"
				? { status: 400, error: "400 tool_choice 'none' is not supported by this model" }
				: { text: "answered" },
		);
		t.after(() => server.close());
		const prompt = "summarize what you know";
		/** Whether one fresh submit at `window` reaches the server. */
		const sends = async (window: number, choice: () => MiddlewareToolChoiceControl): Promise<boolean> => {
			const harness = chatHarness({ server, route: { window }, middlewareToolChoice: choice() });
			const before = server.requests.length;
			try {
				harness.session.create({ cwd: process.cwd() });
				await harness.submit(prompt);
			} finally {
				await harness.close();
			}
			return server.requests.length > before;
		};
		ok(await sends(131_072, lockNone), "the rejection is learned");
		/** The smallest window that admits the request. */
		const boundary = async (choice: () => MiddlewareToolChoiceControl): Promise<number> => {
			let low = 1_000;
			let high = 131_072;
			while (low < high) {
				const mid = Math.floor((low + high) / 2);
				if (await sends(mid, choice)) high = mid;
				else low = mid + 1;
			}
			return low;
		};
		const plain = await boundary(auto);
		const locked = await boundary(lockNone);
		const sent = server.requests.filter((request) => request.body.tool_choice === "auto").at(-1);
		ok(sent && wireElements(sent).some((element) => element.includes("final synthesis")), "the directive was sent");
		ok(locked > plain, `the directive is priced: plain fits at ${plain}, locked at ${locked}`);
	});
});

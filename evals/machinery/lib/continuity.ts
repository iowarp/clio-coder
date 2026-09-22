/**
 * Continuity handoff scenarios.
 *
 * One `self_compact` cycle is a durable transaction: the note is prepared and
 * flushed, the tool receipt authorizes reduction, the reduction reserves its
 * commit through a checkpoint before the durability barrier, and only a
 * committed barrier grants a correlated continuation. Each scenario drives the
 * production controller over a scripted ledger and records the ordered port
 * log, which is what makes a reordering visible in the baseline diff.
 */
import type { ContinuityPersistencePorts } from "../../../src/domains/session/continuity/contract.js";
import { resolveContinuityProjection } from "../../../src/domains/session/continuity/projection.js";
import { isSessionEntry, type SessionEntry } from "../../../src/domains/session/entries.js";
import { ContinuityController, type ContinuityReductionHooks } from "../../../src/interactive/continuity-controller.js";
import { type MachineryObservation, type MachineryScenario, observe } from "./observation.js";

interface ContinuityFixture {
	controller: ContinuityController;
	log: ReadonlyArray<string>;
	entries: SessionEntry[];
	append: (role: "assistant" | "tool_result", payload: unknown) => string;
	receipt: (toolCallId?: string, isError?: boolean, toolName?: string) => string;
	fold: () => ReturnType<typeof resolveContinuityProjection>["current"];
	setReduction: (value: (hooks: ContinuityReductionHooks) => Promise<void>) => void;
	setFits: (value: boolean) => void;
	setAdmit: (value: boolean) => void;
	failFlush: () => void;
}

/**
 * A ledger the scenario owns outright. The clock and the id allocator are
 * counters rather than real time and UUIDs, so an ordering change shows up as a
 * changed log and never as a changed digest for a run that did the same thing.
 */
function fixture(): ContinuityFixture {
	let clock = 1_000_000;
	let serial = 0;
	let leaf = "operator";
	let fits = true;
	let admit = true;
	let flushFails = false;
	const entries: SessionEntry[] = [
		{
			kind: "message",
			turnId: leaf,
			parentTurnId: null,
			timestamp: new Date(clock).toISOString(),
			role: "user",
			payload: { text: "Complete the work." },
		},
	];
	const log: string[] = [];
	let reduction: (hooks: ContinuityReductionHooks) => Promise<void> = async () => {};
	const ports: ContinuityPersistencePorts = {
		append: (entry) => {
			// The controller writes the ledger through this port, so an entry it
			// cannot round-trip is a defect in the transaction rather than in the
			// fixture. Refusing it here keeps that from reading as a passing run.
			if (!isSessionEntry(entry)) throw new Error(`continuity appended an invalid ${String(entry.kind)} entry`);
			entries.push(entry);
			log.push(entry.kind === "handoffTransaction" ? entry.event.phase : entry.kind);
		},
		readExact: () => ({ status: "unresolved" }),
		flushAppends: () => {
			log.push("flush");
			if (flushFails) throw new Error("fsync failed");
		},
		checkpoint: async () => {
			log.push("checkpoint");
			if (flushFails) throw new Error("checkpoint failed");
		},
		isStateRemoved: () => false,
		isOriginCurrent: () => true,
	};
	const controller = new ContinuityController({
		captureOrigin: () => ({
			sessionId: "session",
			leafTurnId: leaf,
			initiatingTurnId: "operator",
			sourceRevision: "machinery",
			ports,
		}),
		entries: () => entries,
		leaf: () => leaf,
		admitNote: () => admit,
		fits: () => fits,
		inputTokens: () => 300,
		reduce: async (hooks) => reduction(hooks),
		installReplay: () => log.push("replay"),
		onCommit: (_commitId, outcome) => log.push(`commit:${outcome}`),
		notice: (text) => log.push(text),
		now: () => ++clock,
		id: () => `id-${++serial}`,
	});
	const append = (role: "assistant" | "tool_result", payload: unknown): string => {
		const id = `message-${++serial}`;
		entries.push({
			kind: "message",
			turnId: id,
			parentTurnId: leaf,
			timestamp: new Date(++clock).toISOString(),
			role,
			payload,
		});
		leaf = id;
		return id;
	};
	return {
		controller,
		log,
		entries,
		append,
		receipt: (toolCallId = "call", isError = false, toolName = "self_compact") =>
			append("tool_result", { toolCallId, toolName, isError, result: { content: [{ type: "text", text: "prepared" }] } }),
		fold: () => resolveContinuityProjection({ entries, sessionId: "session", nowMs: clock }).current,
		setReduction: (value) => {
			reduction = value;
		},
		setFits: (value) => {
			fits = value;
		},
		setAdmit: (value) => {
			admit = value;
		},
		failFlush: () => {
			flushFails = true;
		},
	};
}

type Settled = { kind: "returned"; value: unknown } | { kind: "threw"; message: string };

async function settle(run: () => Promise<unknown>): Promise<Settled> {
	try {
		return { kind: "returned", value: (await run()) ?? null };
	} catch (error) {
		return { kind: "threw", message: error instanceof Error ? error.message : String(error) };
	}
}

function foldFacts(fold: ReturnType<ContinuityFixture["fold"]>) {
	return {
		phase: fold?.phase ?? null,
		validated: fold?.validated ?? null,
		attemptsSpent: fold?.attemptsSpent ?? null,
		note: fold?.accepted?.note ?? null,
		commitOutcome: fold?.commit?.outcome ?? null,
		initiatingTurnId: fold?.identity?.initiatingTurnId ?? null,
	};
}

const NOTE = "  Keep the λ patch and this exact whitespace.\n";

async function handoffPreparation(): Promise<MachineryObservation> {
	// The prepared note is the operator-visible promise of the transaction: it
	// is saved verbatim, it blocks the provider until delivery, and it is never
	// re-derived from prose the model wrote afterwards.
	const f = fixture();
	const prepared = await f.controller.request(NOTE, "call");
	const afterPrepare = { fold: foldFacts(f.fold()), admission: f.controller.admission() };
	f.receipt();
	const settled = await settle(() => f.controller.settle());
	const afterSettle = { fold: foldFacts(f.fold()), admission: f.controller.admission() };
	const userTurns = f.entries.filter((entry) => entry.kind === "message" && entry.role === "user").length;
	return observe(
		{ prepared, afterPrepare, afterSettle, log: [...f.log], userTurns },
		{
			"the note is retained byte for byte": afterPrepare.fold.note === NOTE,
			"preparation blocks the provider until delivery": afterPrepare.admission.block === true,
			"the prepared phase is durable before the receipt": f.log[0] === "prepared" && f.log[1] === "flush",
			"a settled cycle delivers a correlated continuation":
				settled.kind === "returned" &&
				afterSettle.admission.block === false &&
				typeof (afterSettle.admission as { correlationId?: string }).correlationId === "string",
			"the transaction keeps the original operator identity": afterSettle.fold.initiatingTurnId === "operator",
			"a handoff never manufactures a second operator turn": userTurns === 1,
		},
	);
}

async function summaryCheckpoint(): Promise<MachineryObservation> {
	// The checkpoint reserves the exact commit the summary will carry, and it is
	// taken before the append and before the barrier. A summary that landed
	// without one would be a reduction no commit can be validated against.
	const f = fixture();
	let reserved: unknown = null;
	f.setReduction(async (hooks) => {
		hooks.beforeSummaryCall();
		const continuity = hooks.checkpointForSummary("summary", 300, 100);
		reserved = { outcome: continuity.commit.outcome, summaryRef: continuity.commit.summaryRef };
		f.entries.push({
			kind: "compactionSummary",
			turnId: "summary",
			parentTurnId: "operator",
			timestamp: new Date(1_000_010).toISOString(),
			summary: "Prior work.",
			tokensBefore: 300,
			tokensAfter: 100,
			firstKeptTurnId: "operator",
			messagesSummarized: 1,
			isSplitTurn: false,
			continuity,
		});
	});
	await f.controller.request(NOTE, "call");
	f.receipt();
	const settled = await settle(() => f.controller.settle());
	const fold = foldFacts(f.fold());
	const log = [...f.log];
	return observe(
		{ reserved, fold, log, settled },
		{
			"the reduction settles": settled.kind === "returned" && settled.value === true,
			"the commit is reserved as a summary": (reserved as { outcome?: string } | null)?.outcome === "summarized",
			"the reservation names the summary it will bind to":
				(reserved as { summaryRef?: string } | null)?.summaryRef === "summary",
			"the fold reads the committed outcome back": fold.commitOutcome === "summarized" && fold.validated === true,
			"the commit is durable before the continuation is granted":
				log.indexOf("continuityCommit") < log.indexOf("delivered"),
			"the checkpoint barrier follows the commit append": log.indexOf("checkpoint") > log.indexOf("continuityCommit"),
		},
	);
}

async function evictionCheckpoint(): Promise<MachineryObservation> {
	// A reduction can free room by evicting working-set bodies instead of
	// summarizing. The commit then binds to the eviction entry, and a reduction
	// that freed room without either still commits as continuity only, so the
	// note is never lost to a missing outcome.
	const evicting = fixture();
	evicting.setReduction(async () => {
		evicting.entries.push({
			kind: "contextEviction",
			turnId: "eviction",
			parentTurnId: "operator",
			timestamp: new Date(1_000_020).toISOString(),
			policyId: "machinery-fixture",
			trigger: "pressure",
			evicted: [
				{
					alias: "r1",
					ref: { entry: "operator" },
					reason: "superseded_read",
					tokensFreed: 200,
					marker: "[evicted: superseded read]",
				},
			],
			tokensBefore: 300,
			tokensAfter: 100,
			pressureBefore: 0.91,
			snapshotIdBefore: null,
		});
	});
	await evicting.controller.request(NOTE, "call");
	evicting.receipt();
	const evicted = await settle(() => evicting.controller.settle());

	const bare = fixture();
	await bare.controller.request(NOTE, "call");
	bare.receipt();
	const continuityOnly = await settle(() => bare.controller.settle());

	const tight = fixture();
	tight.setFits(false);
	await tight.controller.request(NOTE, "call");
	tight.receipt();
	const refused = await settle(() => tight.controller.settle());

	return observe(
		{
			evicted: { settled: evicted, fold: foldFacts(evicting.fold()), log: [...evicting.log] },
			continuityOnly: { settled: continuityOnly, fold: foldFacts(bare.fold()), log: [...bare.log] },
			refused: { settled: refused, fold: foldFacts(tight.fold()), log: [...tight.log] },
		},
		{
			"an eviction commits as an eviction": evicting.fold()?.commit?.outcome === "evicted",
			"the commit binds the eviction entry it claims": evicting.fold()?.commit?.evictionRef === "eviction",
			"a reduction with neither outcome still commits": bare.fold()?.commit?.outcome === "continuity_only",
			"a reduction that did not free room refuses rather than committing":
				refused.kind === "threw" && foldFacts(tight.fold()).commitOutcome === null,
			"a refused reduction keeps the exact note": tight.fold()?.accepted?.note === NOTE,
			"neither commit was notified before its barrier": [evicting.log, bare.log].every(
				(log) => log.indexOf("checkpoint") < log.findIndex((row) => row.startsWith("commit:")),
			),
		},
	);
}

async function continuationDelivery(): Promise<MachineryObservation> {
	// Delivery is correlated. A terminal response acknowledges the transaction
	// only when it carries the delivery id the controller issued, so an
	// unrelated turn cannot close a handoff that is still owed a continuation.
	const f = fixture();
	await f.controller.request(NOTE, "call");
	f.receipt();
	await f.controller.settle();
	const admission = f.controller.admission();
	const correlationId = (admission as { correlationId?: string }).correlationId;

	const uncorrelated = f.append("assistant", { text: "Unrelated turn.", stopReason: "stop" });
	await f.controller.response(uncorrelated, "id-not-issued");
	const afterUncorrelated = foldFacts(f.fold());

	const stillOwed = f.append("assistant", { text: "Mid-run tool round.", stopReason: "toolUse" });
	await f.controller.response(stillOwed, correlationId);
	const afterNonTerminal = foldFacts(f.fold());

	const delivered = f.append("assistant", {
		text: "Work complete.",
		stopReason: "stop",
		continuityDeliveryId: correlationId,
	});
	await f.controller.response(delivered, correlationId);
	const afterDelivery = foldFacts(f.fold());

	return observe(
		{ admission: { block: admission.block }, afterUncorrelated, afterNonTerminal, afterDelivery, log: [...f.log] },
		{
			"delivery issues a correlation id": typeof correlationId === "string" && correlationId.length > 0,
			"an uncorrelated response does not acknowledge the handoff": afterUncorrelated.phase === "delivered",
			"a non-terminal turn does not acknowledge it either": afterNonTerminal.phase === "delivered",
			"the correlated terminal response acknowledges it":
				afterDelivery.phase === "acknowledged" && afterDelivery.validated === true,
			"the acknowledged transaction still carries its note": afterDelivery.note === NOTE,
		},
	);
}

async function receiptAuthority(): Promise<MachineryObservation> {
	// Reduction is authorized by one thing: a successful `self_compact` receipt
	// for this transaction's tool call, persisted after the prepared entry. Each
	// case below is a near miss that must not pass for one.
	const cases: Record<string, { settled: Settled; fold: ReturnType<typeof foldFacts>; reduced: boolean }> = {};
	const run = async (name: string, prepare: (f: ContinuityFixture) => void | Promise<void>): Promise<void> => {
		const f = fixture();
		await prepare(f);
		const settled = await settle(() => f.controller.settle());
		cases[name] = { settled, fold: foldFacts(f.fold()), reduced: f.log.includes("reducing") };
	};
	await run("stale-receipt-before-preparation", async (f) => {
		f.receipt();
		await f.controller.request(NOTE, "call");
		f.append("tool_result", { toolCallId: "call", toolName: "self_compact", isError: true });
	});
	await run("another-tools-receipt", async (f) => {
		await f.controller.request(NOTE, "call");
		f.receipt("call", false, "read");
	});
	await run("another-calls-receipt", async (f) => {
		await f.controller.request(NOTE, "call");
		f.receipt("another-call");
	});
	await run("failed-receipt", async (f) => {
		await f.controller.request(NOTE, "call");
		f.receipt("call", true);
	});
	await run("no-receipt-at-all", async (f) => {
		await f.controller.request(NOTE, "call");
	});
	const rejected = await settle(async () => {
		const f = fixture();
		return f.controller.request("   ", "call");
	});
	const overBudget = await settle(async () => {
		const f = fixture();
		f.setAdmit(false);
		return f.controller.request(NOTE, "call");
	});
	return observe(
		{ cases, rejected, overBudget },
		{
			"no near-miss receipt starts a reduction": Object.values(cases).every((row) => row.reduced === false),
			"each refusal pauses the transaction rather than dropping it": Object.values(cases).every(
				(row) => row.settled.kind === "threw" && row.fold.phase === "paused",
			),
			"each paused transaction keeps its exact note": Object.values(cases).every((row) => row.fold.note === NOTE),
			"a blank note is refused before anything is written": rejected.kind === "threw",
			"a note over the replay budget is refused too": overBudget.kind === "threw",
		},
	);
}

async function barrierFailure(): Promise<MachineryObservation> {
	// The barrier is what makes a commit durable. A failed one may not grant a
	// continuation, may not notify a commit, and must leave the note recoverable
	// rather than half-applied.
	const f = fixture();
	await f.controller.request(NOTE, "call");
	f.receipt();
	f.failFlush();
	const settled = await settle(() => f.controller.settle());
	// The failed settle abandons the live transaction, so admission reports no
	// block and no correlation id: nothing is owed a continuation and nothing
	// was granted one. The ledger still holds the prepared note for recovery.
	const admission = f.controller.admission();
	const fold = foldFacts(f.fold());
	const log = [...f.log];
	return observe(
		{ settled, admission, fold, log },
		{
			"a failed barrier refuses to settle": settled.kind === "threw",
			"the refusal names durability": (settled as { message?: string }).message?.includes("durability") === true,
			"no continuation is granted": (admission as { correlationId?: string }).correlationId === undefined,
			"no commit is notified": !log.some((row) => row.startsWith("commit:")),
			"the transaction never reached a commit": fold.commitOutcome === null,
			"the exact note survives the failure": fold.note === NOTE,
		},
	);
}

export const SCENARIOS: Record<string, MachineryScenario> = {
	"handoff-preparation": handoffPreparation,
	"summary-checkpoint": summaryCheckpoint,
	"eviction-checkpoint": evictionCheckpoint,
	"continuation-delivery": continuationDelivery,
	"receipt-authority": receiptAuthority,
	"barrier-failure": barrierFailure,
};

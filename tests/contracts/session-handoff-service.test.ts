import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SkillActivation } from "../../src/core/skill-activation.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import {
	renderTaskMemoryHandoffSource,
	seedTaskMemoryFromNewestHandoff,
} from "../../src/domains/memory/task-memory-handoff.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import {
	HANDOFF_DROPPED_HEADING,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SEED_CUSTOM_TYPE,
} from "../../src/domains/session/handoff.js";
import {
	commitHandoff,
	type HandoffExtractionRound,
	type HandoffServiceDeps,
	prepareHandoff,
} from "../../src/domains/session/handoff-service.js";
import { FLOW_RESTRICTION_ENTRY_TYPE } from "../../src/domains/session/history.js";
import type { TUI } from "../../src/engine/tui.js";
import { admitHandoffSeedFlow, createFlowLedger } from "../../src/entry/flow-ledger.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { createOverlaySessionLifecycle } from "../../src/interactive/overlay-session-lifecycle.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";

const CWD = "/workspace/project";
/** Production metas always carry the hash; the lifecycle locates the session call journal by it (#434). */
const CWD_HASH = "0123456789abcdef";
const GOAL = "finish the parser migration and its tests";
const EXTRACTION = JSON.stringify({
	decisions: [{ summary: "keep the lexer", rationale: "it is tested" }],
	facts: ["the parser is half migrated"],
	files: [
		{ path: "src/kept.ts", why: "read on the active branch" },
		{ path: "src/abandoned.ts", why: "read on an abandoned branch" },
		{ path: "src/invented.ts", why: "never touched" },
	],
	commands: [{ argv: "pnpm test", why: "the gate" }],
	openQuestions: ["does the old API stay?"],
});

function message(turnId: string, parentTurnId: string | null, role: string, payload: unknown): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: `2026-09-26T00:00:0${turnId.length}.000Z`,
		role,
		payload,
	} as SessionEntry;
}

/** One session with a user turn and two sibling reads; the pin selects the `kept` branch. */
const ENTRIES: SessionEntry[] = [
	message("u1", null, "user", { text: "start" }),
	message("c1", "u1", "tool_call", { name: "read", args: { path: "src/kept.ts" } }),
	message("c2", "u1", "tool_call", { name: "read", args: { path: "src/abandoned.ts" } }),
];

function fakeSession(
	options: { failNote?: boolean; failSeed?: boolean; failFlow?: boolean; failResume?: boolean } = {},
) {
	const activation = { name: "writer" } as unknown as SkillActivation;
	const metas = new Map<string, SessionMeta>([
		[
			"from",
			{
				id: "from",
				cwd: CWD,
				cwdHash: CWD_HASH,
				pinnedLeafTurnId: "c1",
				skillActivations: [activation],
			} as unknown as SessionMeta,
		],
	]);
	const written = new Map<string, Array<Record<string, unknown>>>();
	const activations = new Map<string, SkillActivation[]>();
	let current = "from";
	let minted = 0;
	const session = {
		current: () => metas.get(current) ?? null,
		create: () => {
			minted += 1;
			const id = `to-${minted}`;
			metas.set(id, { id, cwd: CWD, cwdHash: CWD_HASH } as unknown as SessionMeta);
			current = id;
			return metas.get(id);
		},
		switchBranch: (id: string) => {
			if (!metas.has(id)) throw new Error(`unknown session ${id}`);
			current = id;
			return metas.get(id);
		},
		resume: (id: string) => {
			if (options.failResume) throw new Error("source locked");
			if (!metas.has(id)) throw new Error(`unknown session ${id}`);
			current = id;
			return metas.get(id);
		},
		appendEntry: (entry: Record<string, unknown>) => {
			if (options.failSeed && entry.customType === HANDOFF_SEED_CUSTOM_TYPE) throw new Error("disk full");
			if (options.failFlow && entry.customType === FLOW_RESTRICTION_ENTRY_TYPE) throw new Error("disk full");
			if (options.failNote && entry.customType === HANDOFF_NOTE_CUSTOM_TYPE) throw new Error("note refused");
			written.set(current, [...(written.get(current) ?? []), entry]);
			return entry;
		},
		tree: () => ({ leafId: null }),
		deleteSession: (id: string) => {
			if (id === current) throw new Error("refusing to delete the open session");
			metas.delete(id);
			written.delete(id);
		},
		recordSkillActivation: (value: SkillActivation) => {
			activations.set(current, [...(activations.get(current) ?? []), value]);
			return value;
		},
	} as unknown as SessionContract;
	return {
		session,
		written,
		activations,
		activation,
		get current() {
			return current;
		},
		set current(id: string) {
			current = id;
		},
	};
}

function deps(
	fake: ReturnType<typeof fakeSession>,
	rounds: HandoffExtractionRound[],
	overrides: Partial<HandoffServiceDeps> = {},
) {
	const calls: Array<{ goal: string; repair?: { complaint: string; previous: string } }> = [];
	const value: HandoffServiceDeps = {
		session: fake.session,
		extract: async (goal, options) => {
			calls.push({ goal, ...(options?.repair ? { repair: options.repair } : {}) });
			const next = rounds.shift();
			if (!next) throw new Error("no scripted round left");
			return next;
		},
		readEntries: () => ENTRIES,
		isTurnInFlight: () => false,
		createSession: () => {
			fake.session.create({ cwd: CWD });
		},
		...overrides,
	};
	return { deps: value, calls };
}

test("handoff admission refuses a goal-less line or a moving session before any model round", async () => {
	const fake = fakeSession();
	const stop = deps(fake, []);
	const refused = await prepareHandoff(stop.deps, "continue");
	strictEqual(refused.ok, false);
	if (!refused.ok) {
		strictEqual(refused.code, "goal");
		match(refused.reason, /names no goal/);
	}
	const moving = deps(fake, [], { isTurnInFlight: () => true });
	const inFlight = await prepareHandoff(moving.deps, GOAL);
	strictEqual(inFlight.ok, false);
	if (!inFlight.ok) strictEqual(inFlight.code, "turn_in_flight");
	const unwired = deps(fake, []);
	delete unwired.deps.createSession;
	const noCreate = await prepareHandoff(unwired.deps, GOAL);
	strictEqual(noCreate.ok, false);
	strictEqual(stop.calls.length + moving.calls.length + unwired.calls.length, 0);
});

test("handoff extraction repairs once and keeps only files the active branch touched", async () => {
	const fake = fakeSession();
	const { deps: service, calls } = deps(fake, [
		{ status: "answered", text: "Here is a summary in prose." },
		{ status: "answered", text: `Sure:\n${EXTRACTION}` },
	]);
	const prepared = await prepareHandoff(service, `  ${GOAL}  `);
	ok(prepared.ok);
	strictEqual(calls.length, 2);
	strictEqual(calls[1]?.repair?.previous, "Here is a summary in prose.");
	match(calls[1]?.repair?.complaint ?? "", /no JSON object/);
	const { draft } = prepared;
	strictEqual(draft.goal, GOAL);
	strictEqual(draft.fromSessionId, "from");
	const [kept = "", dropped = ""] = draft.document.split(`### ${HANDOFF_DROPPED_HEADING}`);
	match(kept, /src\/kept\.ts/);
	ok(!kept.includes("src/abandoned.ts"), "a file read on an abandoned branch is not evidence");
	match(dropped, /src\/abandoned\.ts/);
	match(dropped, /src\/invented\.ts/);
	// Preparing writes nothing anywhere.
	strictEqual(fake.written.size, 0);
	strictEqual(fake.current, "from");
});

test("handoff extraction reports both rounds when the repair also fails, and a cancelled round as a warning", async () => {
	const failing = deps(fakeSession(), [
		{ status: "answered", text: "prose" },
		{ status: "answered", text: "still prose" },
	]);
	const refused = await prepareHandoff(failing.deps, GOAL);
	strictEqual(refused.ok, false);
	if (!refused.ok) {
		strictEqual(refused.level, "error");
		match(refused.reason, /Round 1: .*Round 2: .*Round 2 returned: still prose/);
	}
	const cancelled = deps(fakeSession(), [{ status: "aborted" }]);
	const aborted = await prepareHandoff(cancelled.deps, GOAL);
	strictEqual(aborted.ok, false);
	if (!aborted.ok) {
		strictEqual(aborted.level, "warn");
		strictEqual(aborted.reason, "the extraction round was cancelled");
	}
	const provider = deps(fakeSession(), [{ status: "failed", reason: "401 from provider" }]);
	const failed = await prepareHandoff(provider.deps, GOAL);
	strictEqual(failed.ok, false);
	if (!failed.ok)
		deepStrictEqual([failed.level, failed.code, failed.reason], ["error", "provider", "401 from provider"]);
});

test("handoff commit seeds the successor, notes the source, replays skills and lands on the successor", async () => {
	const fake = fakeSession();
	const { deps: service } = deps(fake, [{ status: "answered", text: EXTRACTION }]);
	const prepared = await prepareHandoff(service, GOAL);
	ok(prepared.ok);
	const { draft } = prepared;
	const committed = commitHandoff(service, draft, "  # reviewed by a person  ");
	ok(committed.ok);
	deepStrictEqual(committed, { ok: true, fromSessionId: "from", toSessionId: "to-1", warnings: [] });
	strictEqual(fake.current, "to-1");
	const seed = fake.written.get("to-1")?.[0];
	strictEqual(seed?.customType, HANDOFF_SEED_CUSTOM_TYPE);
	deepStrictEqual(seed?.data, { fromSessionId: "from", goal: GOAL, document: "# reviewed by a person" });
	deepStrictEqual(fake.activations.get("to-1"), [fake.activation]);
	const note = fake.written.get("from")?.[0];
	strictEqual(note?.customType, HANDOFF_NOTE_CUSTOM_TYPE);
	deepStrictEqual(note?.data, { toSessionId: "to-1", goal: GOAL });
});

test("handoff commit carries the source session's flow restrictions into the successor, ahead of the document", async () => {
	const set = {
		version: 1,
		restrictions: [
			{ ruleId: "secrets-local", policyHash: "h", sourceRef: "/repo/secrets/notes.txt", recipients: ["target:stub"] },
		],
	};
	const restriction = { kind: "custom", customType: FLOW_RESTRICTION_ENTRY_TYPE, parentTurnId: "u1", data: { set } };
	const fake = fakeSession();
	const { deps: service } = deps(fake, [{ status: "answered", text: EXTRACTION }], {
		readEntries: (sessionId) => (sessionId === "from" ? [...ENTRIES, restriction as unknown as SessionEntry] : []),
	});
	const prepared = await prepareHandoff(service, GOAL);
	ok(prepared.ok);
	ok(commitHandoff(service, prepared.draft, "# reviewed").ok);
	deepStrictEqual(
		fake.written.get("to-1")?.map((entry) => entry.customType),
		[FLOW_RESTRICTION_ENTRY_TYPE, HANDOFF_SEED_CUSTOM_TYPE],
	);
	const ledger = createFlowLedger({ session: fake.session, readEntries: (id) => fake.written.get(id) ?? [] });
	deepStrictEqual(ledger.current(), set);

	// A label that cannot be written ends the handoff back in the session whose ledger still holds it.
	const failing = fakeSession({ failFlow: true });
	const refusing = deps(failing, [{ status: "answered", text: EXTRACTION }], {
		readEntries: (sessionId) => (sessionId === "from" ? [...ENTRIES, restriction as unknown as SessionEntry] : []),
	}).deps;
	const failingDraft = await prepareHandoff(refusing, GOAL);
	ok(failingDraft.ok);
	const sourceLedger = createFlowLedger({
		session: failing.session,
		readEntries: (id) => (id === "from" ? [restriction] : (failing.written.get(id) ?? [])),
	});
	deepStrictEqual(sourceLedger.current(), set);
	const refused = commitHandoff(refusing, failingDraft.draft, "# reviewed");
	strictEqual(refused.ok ? null : refused.code, "seed_failed");
	strictEqual(failing.current, "from");
	deepStrictEqual(sourceLedger.current(), set);
	strictEqual(sourceLedger.refusal(), null);
	throws(() => failing.session.switchBranch("to-1"), /unknown session/, "no empty child is left to resume");
});

test("a seed that fails with no way back holds the source's labels, so the unlabeled child sends nothing", async () => {
	const set = {
		version: 1,
		restrictions: [{ ruleId: "secrets", policyHash: "h", sourceRef: "/repo/secrets/notes.txt", recipients: [] }],
	};
	const restriction = { kind: "custom", customType: FLOW_RESTRICTION_ENTRY_TYPE, parentTurnId: "u1", data: { set } };
	const fake = fakeSession({ failFlow: true, failResume: true });
	const ledger = createFlowLedger({ session: fake.session, readEntries: (id) => fake.written.get(id) ?? [] });
	const { deps: service } = deps(fake, [{ status: "answered", text: EXTRACTION }], {
		readEntries: (sessionId) => (sessionId === "from" ? [...ENTRIES, restriction as unknown as SessionEntry] : []),
		absorbFlow: (held) => ledger.absorb(held, { tool: "handoff" }),
	});
	const prepared = await prepareHandoff(service, GOAL);
	ok(prepared.ok);
	const refused = commitHandoff(service, prepared.draft, "# reviewed");
	strictEqual(refused.ok ? null : refused.code, "seed_failed");
	strictEqual(fake.current, "to-1");
	deepStrictEqual(ledger.current(), set);
	match(ledger.refusal() ?? "", /could not be persisted to session to-1/);
});

test("a handoff seed refused by its admission leaves the bank untouched", () => {
	const cwd = mkdtempSync(join(tmpdir(), "memory-seed-"));
	try {
		const handoffs = join(cwd, ".clio-coder", "handoffs");
		mkdirSync(handoffs, { recursive: true });
		const bank = new TaskMemoryBank();
		const source = new TaskMemoryBank();
		source.saveKnowledge("the token lives in the notes");
		writeFileSync(
			join(handoffs, "handoff-2026-11-03.md"),
			renderTaskMemoryHandoffSource(source.snapshot(), {
				sessionId: "from",
				evidenceRefs: ["session-from"],
				runtimeIds: [],
				agentIds: [],
			}),
		);
		const seen: string[] = [];
		const refused = seedTaskMemoryFromNewestHandoff(bank, cwd, true, (snapshot) => {
			if (snapshot.version === 2) seen.push(snapshot.source.sessionId);
			return { refusal: "no provenance" };
		});
		deepStrictEqual(refused, { status: "refused", reason: "no provenance" });
		deepStrictEqual(seen, ["from"]);
		strictEqual(bank.snapshot().knowledge.length, 0);
		strictEqual(seedTaskMemoryFromNewestHandoff(bank, cwd, true, () => ({ ruleIds: [] })).status, "seeded");
		strictEqual(bank.snapshot().knowledge.length, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the flow ledger reads another session's labels and fails closed on an unreadable one", () => {
	const set = {
		version: 1,
		restrictions: [{ ruleId: "secrets", policyHash: "h", sourceRef: "/repo/secrets/notes.txt", recipients: [] }],
	};
	const ledger = createFlowLedger({
		session: fakeSession().session,
		readEntries: (id) => {
			if (id === "gone") throw new Error("no such session");
			return id === "labeled" ? [{ kind: "custom", customType: FLOW_RESTRICTION_ENTRY_TYPE, data: { set } }] : [];
		},
	});
	deepStrictEqual(ledger.restrictionsOf("labeled"), set);
	strictEqual(ledger.restrictionsOf("clean"), null);
	throws(() => ledger.restrictionsOf("gone"), /no such session/);
	strictEqual(ledger.isRestricted("labeled"), true);
	strictEqual(ledger.isRestricted("clean"), false);
	strictEqual(ledger.isRestricted("gone"), true);
});

test("a label absorbed before any session is visible to isRestricted once one exists", () => {
	const set = {
		version: 1 as const,
		restrictions: [{ ruleId: "secrets", policyHash: "h", sourceRef: "/repo/secrets/notes.txt", recipients: [] }],
	};
	const fake = fakeSession();
	fake.current = "none";
	const ledger = createFlowLedger({ session: fake.session, readEntries: (id) => fake.written.get(id) ?? [] });
	ledger.absorb(set, { tool: "file-reference" });
	fake.session.create({ cwd: CWD });
	strictEqual(ledger.isRestricted("to-1"), true, "no current() or refusal() ran between the session and the question");
	deepStrictEqual(ledger.restrictionsOf("to-1"), set);
});

test("a seed from a restricted source labels a session of its own, so resuming a clean one leaves it clean", () => {
	const set = {
		version: 1,
		restrictions: [{ ruleId: "secrets", policyHash: "h", sourceRef: "/repo/secrets/notes.txt", recipients: [] }],
	};
	const fake = fakeSession();
	fake.current = "none";
	const ledger = createFlowLedger({
		session: fake.session,
		readEntries: (id) => {
			if (id === "gone") throw new Error("session not found: gone");
			return id === "labeled"
				? [{ kind: "custom", customType: FLOW_RESTRICTION_ENTRY_TYPE, data: { set } }]
				: (fake.written.get(id) ?? []);
		},
	});
	const admit = (source: string | null, hasSourceRules = true) =>
		admitHandoffSeedFlow(
			{
				ledger,
				hasSourceRules: () => hasSourceRules,
				ensureSession: () => {
					if (fake.session.current() === null) fake.session.create({ cwd: CWD });
				},
			},
			source,
		);
	deepStrictEqual(admit("clean"), { ruleIds: [] });
	strictEqual(fake.session.current(), null, "a clean source opens no session");
	match(("refusal" in admit("gone") && (admit("gone") as { refusal: string }).refusal) || "", /session not found: gone/);
	match(("refusal" in admit(null) && (admit(null) as { refusal: string }).refusal) || "", /names no source session/);
	deepStrictEqual(admit("gone", false), { ruleIds: [] });

	deepStrictEqual(admit("labeled"), { ruleIds: ["secrets"] });
	strictEqual(fake.current, "to-1");
	strictEqual(ledger.isRestricted("to-1"), true);
	strictEqual(fake.written.get("to-1")?.[0]?.customType, FLOW_RESTRICTION_ENTRY_TYPE);
	fake.session.switchBranch("from");
	strictEqual(ledger.current(), null, "the clean session took nothing");
	strictEqual(fake.written.has("from"), false);
});

test("handoff commit writes nothing for an empty or stale review, and keeps the seed when only the note fails", async () => {
	const fake = fakeSession();
	const { deps: service } = deps(fake, [{ status: "answered", text: EXTRACTION }]);
	const prepared = await prepareHandoff(service, GOAL);
	ok(prepared.ok);
	const { draft } = prepared;
	const empty = commitHandoff(service, draft, "   \n");
	strictEqual(empty.ok, false);
	if (!empty.ok) strictEqual(empty.code, "empty");
	fake.session.create({ cwd: CWD });
	const stale = commitHandoff(service, draft, "# reviewed");
	strictEqual(stale.ok, false);
	if (!stale.ok) strictEqual(stale.code, "stale");
	strictEqual(fake.written.size, 0);

	const noteFails = fakeSession({ failNote: true });
	const partial = commitHandoff(deps(noteFails, []).deps, draft, "# reviewed");
	ok(partial.ok);
	strictEqual(partial.toSessionId, "to-1");
	match(partial.warnings.join("\n"), /handoff note failed: note refused/);
	strictEqual(noteFails.current, "to-1", "the operator continues in the seeded successor");
	strictEqual(noteFails.written.get("to-1")?.[0]?.customType, HANDOFF_SEED_CUSTOM_TYPE);

	const seedFails = fakeSession({ failSeed: true });
	const failed = commitHandoff(deps(seedFails, []).deps, draft, "# reviewed");
	strictEqual(failed.ok, false);
	if (!failed.ok) {
		strictEqual(failed.code, "seed_failed");
		match(failed.reason, /could not seed the new session: disk full/);
	}
	strictEqual(seedFails.written.get("from"), undefined, "no note names a successor that was never seeded");
	strictEqual(seedFails.current, "from", "the operator keeps the session the conversation came from");
	strictEqual(seedFails.session.switchBranch("from")?.id, "from");
	throws(() => seedFails.session.switchBranch("to-1"), /unknown session/);
});

test("the terminal /handoff runs the shared service from extraction through the reviewed seed", async () => {
	const fake = fakeSession();
	const notices: string[] = [];
	const resets: Array<string | null> = [];
	const reviews: Array<{ document: string; onAccept: (text: string) => void; goal: string }> = [];
	const rounds: Array<{ status: "answered"; text: string }> = [{ status: "answered", text: EXTRACTION }];
	const transitions: OverlayTransitions = {
		state: "closed",
		handle: null,
		showPermission: () => false,
		close: () => {
			transitions.state = "closed";
		},
	};
	const lifecycle = createOverlaySessionLifecycle({
		tui: {} as TUI,
		transitions,
		session: fake.session,
		chatPanel: createChatPanel(),
		chat: {
			cancel: () => undefined,
			isStreaming: () => false,
			whenSettled: async () => undefined,
			resetForSession: (leaf) => {
				resets.push(leaf);
			},
			extractHandoff: async () => rounds.shift() ?? { status: "failed", reason: "no round" },
		},
		resetTranscript: () => undefined,
		readStructuredEntries: (id) => (id === "from" ? ENTRIES : []),
		getSlashNotice: () => (_level, text) => {
			notices.push(text);
		},
		onNewSession: () => {
			fake.session.create({ cwd: CWD });
		},
		announceTaskMemorySeedOffer: () => undefined,
		refreshFooter: () => undefined,
		requestRender: () => undefined,
		stderr: (text) => {
			notices.push(text);
		},
		notify: (_level, text) => {
			notices.push(text);
		},
		openHandoffReviewOverlay: (_tui, options) => {
			reviews.push(options);
			return {} as never;
		},
	});
	lifecycle.startHandoff(GOAL);
	await new Promise((resolve) => setImmediate(resolve));
	const review = reviews.at(-1);
	ok(review, "the review opens on the service's document");
	match(review.document, /src\/kept\.ts/);
	strictEqual(transitions.state, "handoff-review");
	review.onAccept("# reviewed in the terminal");
	strictEqual(fake.current, "to-1");
	deepStrictEqual(resets, [null]);
	match(notices.join("\n"), /\[\/handoff\] handed off to session to-1/);
	deepStrictEqual((fake.written.get("to-1")?.[0]?.data as { document?: string }).document, "# reviewed in the terminal");

	// A rule only the shared service knows reaches the terminal: a review
	// accepted after the conversation moved writes nothing.
	fake.current = "from";
	rounds.push({ status: "answered", text: EXTRACTION });
	lifecycle.startHandoff(GOAL);
	await new Promise((resolve) => setImmediate(resolve));
	const second = reviews.at(-1);
	ok(second && second !== review, "a second review opened");
	fake.session.create({ cwd: CWD });
	const before = fake.written.size;
	second.onAccept("# stale");
	strictEqual(fake.written.size, before);
	match(notices.at(-1) ?? "", /conversation changed since this document was drawn; nothing was written/);
});

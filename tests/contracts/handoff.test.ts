/**
 * `/handoff <goal>` contract.
 *
 * The rules asserted here are the ones a handoff is worth having for: the goal
 * gate, path validation against this session's own read ledger, decision-board
 * precedence, the bounds, and the fact that cancelling writes nothing while
 * accepting mints a session carrying the document and the loaded skills. The
 * last test is the boundary the whole feature rests on: a handoff is a session
 * operation and never touches the memory domain.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { DecisionLedgerEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import {
	boundHandoffString,
	buildHandoffReadLedger,
	HANDOFF_DROPPED_HEADING,
	HANDOFF_LIST_BOUNDS,
	HANDOFF_MAX_STRING_BYTES,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SEED_CUSTOM_TYPE,
	HANDOFF_TRUNCATION_MARKER,
	mergeHandoffDecisions,
	normalizeHandoffPath,
	parseHandoffExtraction,
	renderHandoffDocument,
	validateHandoffFiles,
	validateHandoffGoal,
} from "../../src/domains/session/handoff.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createOverlaySessionLifecycle } from "../../src/interactive/overlay-session-lifecycle.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import { formatHandoffReviewBody, handoffReviewOverlayWidth } from "../../src/interactive/overlays/handoff-review.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

function toolCall(turnId: string, parentTurnId: string | null, name: string, args: unknown): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: new Date(0).toISOString(),
		role: "tool_call",
		payload: { toolCallId: `call-${turnId}`, name, args },
	};
}

function userTurn(turnId: string, parentTurnId: string | null, text: string): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: new Date(0).toISOString(),
		role: "user",
		payload: { text },
	};
}

function decisionInterview(key: string, value: string, label?: string): DecisionLedgerEntry {
	return {
		kind: "decisionLedger",
		turnId: `interview-${key}`,
		parentTurnId: "turn-1",
		timestamp: new Date(0).toISOString(),
		interviewId: `interview-${key}`,
		interviewStatus: "complete",
		startedAt: new Date(0).toISOString(),
		endedAt: new Date(0).toISOString(),
		roundCount: 1,
		decisions: [
			{
				key,
				value,
				...(label ? { label } : {}),
				status: "active",
				decidedAt: new Date(0).toISOString(),
			},
		],
	};
}

describe("contracts/handoff goal gate", () => {
	it("refuses a goal shorter than the minimum and names the rule", () => {
		const verdict = validateHandoffGoal("fix it");
		strictEqual(verdict.ok, false);
		if (verdict.ok) return;
		match(verdict.reason, /at least 12 characters/);
	});

	it("refuses each stoplist non-goal on the stoplist rule, whatever its case and spacing", () => {
		for (const raw of ["continue", "  Keep Going ", "PROCEED", "go on", "resume", "next", "same"]) {
			const verdict = validateHandoffGoal(raw);
			strictEqual(verdict.ok, false, `${raw} must be refused`);
			if (verdict.ok) continue;
			// The stoplist runs first, so the operator hears the useful rule
			// rather than a character count they did not ask about.
			match(verdict.reason, /names no goal/);
		}
	});

	it("accepts a real goal and returns it trimmed", () => {
		const verdict = validateHandoffGoal("  finish the working-set eviction rules  ");
		strictEqual(verdict.ok, true);
		if (!verdict.ok) return;
		strictEqual(verdict.goal, "finish the working-set eviction rules");
	});
});

describe("contracts/handoff path validation", () => {
	const cwd = "/work/repo";

	it("keeps a path the session touched and drops one it never did", () => {
		const entries: SessionEntry[] = [
			userTurn("t1", null, "start"),
			toolCall("t2", "t1", "read", { path: "src/a.ts" }),
			toolCall("t3", "t2", "edit", { file_path: "/work/repo/src/b.ts" }),
		];
		const ledger = buildHandoffReadLedger(entries, { cwd });
		const verdict = validateHandoffFiles(
			[
				{ path: "src/a.ts", why: "read here" },
				{ path: "./src/b.ts", why: "edited here" },
				{ path: "src/never-opened.ts", why: "invented" },
			],
			ledger,
			cwd,
		);
		deepStrictEqual(
			verdict.kept.map((file) => file.path),
			["src/a.ts", "src/b.ts"],
		);
		deepStrictEqual(
			verdict.dropped.map((file) => file.path),
			["src/never-opened.ts"],
		);
	});

	it("ignores paths from an abandoned /tree branch", () => {
		// t2 and t2b are siblings under t1. The active leaf is t3 on the t2
		// branch, so the read on the t2b branch is not evidence this session
		// touched that file.
		const entries: SessionEntry[] = [
			userTurn("t1", null, "start"),
			userTurn("t2b", "t1", "abandoned branch"),
			toolCall("t2b-call", "t2b", "read", { path: "src/abandoned.ts" }),
			userTurn("t2", "t1", "kept branch"),
			toolCall("t3", "t2", "read", { path: "src/kept.ts" }),
		];
		const ledger = buildHandoffReadLedger(entries, { cwd, leafTurnId: "t3" });
		ok(ledger.has("src/kept.ts"));
		ok(!ledger.has("src/abandoned.ts"), "an abandoned /tree branch must not enter the read ledger");
		const verdict = validateHandoffFiles([{ path: "src/abandoned.ts", why: "on a dead branch" }], ledger, cwd);
		strictEqual(verdict.kept.length, 0);
		strictEqual(verdict.dropped.length, 1);
	});

	it("does not consult the filesystem: a real file the session never touched is still dropped", () => {
		const ledger = buildHandoffReadLedger([userTurn("t1", null, "start")], { cwd: REPO_ROOT });
		const verdict = validateHandoffFiles([{ path: "package.json", why: "exists on disk" }], ledger, REPO_ROOT);
		strictEqual(verdict.kept.length, 0, "existing on disk is not the same as touched by this session");
		strictEqual(verdict.dropped[0]?.path, "package.json");
	});

	it("folds a search tool with no path argument as the workspace root", () => {
		const entries: SessionEntry[] = [userTurn("t1", null, "start"), toolCall("t2", "t1", "grep", { pattern: "foo" })];
		const ledger = buildHandoffReadLedger(entries, { cwd });
		ok(ledger.has("."));
	});

	it("normalizes a model-written path the same way the ledger normalizes a call", () => {
		strictEqual(normalizeHandoffPath("./src/a.ts", "/work/repo"), "src/a.ts");
		strictEqual(normalizeHandoffPath("/work/repo/src/a.ts", "/work/repo"), "src/a.ts");
		strictEqual(normalizeHandoffPath("/elsewhere/x.ts", "/work/repo"), "/elsewhere/x.ts");
	});

	it("names the dropped paths under the exact review heading", () => {
		const document = renderHandoffDocument({
			goal: "finish the eviction rules",
			fromSessionId: "session-a",
			decisions: [],
			facts: [],
			files: [{ path: "src/kept.ts", why: "read here" }],
			droppedFiles: [{ path: "src/invented.ts", why: "never opened" }],
			commands: [],
			openQuestions: [],
			truncations: [],
		});
		ok(document.includes(`### ${HANDOFF_DROPPED_HEADING}`));
		ok(document.includes("src/invented.ts"));
	});
});

describe("contracts/handoff decision merge", () => {
	it("lets the decision board win over a paraphrase of the same decision", () => {
		const merged = mergeHandoffDecisions(
			[
				{ summary: "storage backend is sqlite", rationale: "the model's paraphrase" },
				{ summary: "retry ceiling stays at three", rationale: "not on the board" },
			],
			[decisionInterview("storage backend", "postgres")],
		);
		strictEqual(merged.length, 2, "the paraphrased board decision must not appear twice");
		strictEqual(merged[0]?.settled, true);
		match(merged[0]?.summary ?? "", /storage backend: postgres/);
		strictEqual(merged[1]?.settled, false);
		match(merged[1]?.summary ?? "", /retry ceiling/);
	});

	it("marks board decisions as settled and lists them first", () => {
		const merged = mergeHandoffDecisions([{ summary: "an extracted choice" }], [decisionInterview("target", "local")]);
		strictEqual(merged[0]?.settled, true);
		strictEqual(merged[1]?.settled, false);
	});

	it("does not carry a superseded board decision", () => {
		const interview = decisionInterview("target", "local");
		const superseded: DecisionLedgerEntry = {
			...interview,
			decisions: interview.decisions.map((decision) => ({ ...decision, status: "superseded" as const })),
		};
		const merged = mergeHandoffDecisions([], [superseded]);
		strictEqual(merged.length, 0);
	});
});

describe("contracts/handoff bounds", () => {
	it("truncates an over-long string to the byte ceiling and marks it", () => {
		const long = "x".repeat(HANDOFF_MAX_STRING_BYTES * 2);
		const bounded = boundHandoffString(long);
		strictEqual(bounded.truncated, true);
		ok(bounded.text.endsWith(HANDOFF_TRUNCATION_MARKER));
		ok(Buffer.byteLength(bounded.text, "utf8") <= HANDOFF_MAX_STRING_BYTES, "the marker counts against the byte ceiling");
	});

	it("leaves a string inside the ceiling untouched and unmarked", () => {
		const bounded = boundHandoffString("  a short fact  ");
		strictEqual(bounded.truncated, false);
		strictEqual(bounded.text, "a short fact");
	});

	it("truncates an over-bound list rather than refusing the extraction", () => {
		const facts = Array.from({ length: HANDOFF_LIST_BOUNDS.facts + 9 }, (_unused, index) => `fact ${index}`);
		const parsed = parseHandoffExtraction(
			JSON.stringify({ decisions: [], facts, files: [], commands: [], openQuestions: [] }),
		);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		strictEqual(parsed.result.extraction.facts.length, HANDOFF_LIST_BOUNDS.facts);
		ok(parsed.result.truncations.some((note) => note.startsWith("facts:")));
	});

	it("renders every bound that fired into the document", () => {
		const parsed = parseHandoffExtraction(
			JSON.stringify({
				decisions: [],
				facts: [`${"y".repeat(HANDOFF_MAX_STRING_BYTES * 2)}`],
				files: [],
				commands: [],
				openQuestions: [],
			}),
		);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		const document = renderHandoffDocument({
			goal: "finish the eviction rules",
			fromSessionId: "session-a",
			decisions: [],
			facts: parsed.result.extraction.facts,
			files: [],
			droppedFiles: [],
			commands: [],
			openQuestions: [],
			truncations: parsed.result.truncations,
		});
		ok(document.includes("## Bounds applied"));
		ok(document.includes(HANDOFF_TRUNCATION_MARKER));
	});

	it("reads a JSON object out of a fenced answer rather than refusing it", () => {
		const parsed = parseHandoffExtraction(
			'```json\n{"decisions":[],"facts":["one"],"files":[],"commands":[],"openQuestions":[]}\n```',
		);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		deepStrictEqual(parsed.result.extraction.facts, ["one"]);
	});

	it("refuses an answer with no JSON object at all", () => {
		const parsed = parseHandoffExtraction("I could not do that.");
		strictEqual(parsed.ok, false);
	});
});

describe("contracts/handoff session seeding", () => {
	let scratch: string;

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-handoff-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	/** One extraction answer, good enough that the whole path runs. */
	const ANSWER = JSON.stringify({
		decisions: [{ summary: "keep the lease in terminal-lease.ts", rationale: "one terminal owner" }],
		facts: ["the lease owns raw mode"],
		files: [{ path: "src/interactive/terminal-lease.ts", why: "the lease lives here" }],
		commands: [{ argv: "npm run typecheck", why: "the gate" }],
		openQuestions: ["does stage 0 need the editor?"],
	});

	function readEntries(sessionId: string): SessionEntry[] {
		const reader = openSession(sessionId);
		return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
	}

	interface HarnessOptions {
		answer?: string;
		/** One entry per extraction round, in order; the last repeats. Overrides `answer`. */
		answers?: ReadonlyArray<string>;
		/** What the review overlay does: accept the document, or cancel. */
		review: "accept" | "cancel";
	}

	interface RoundRecord {
		goal: string;
		repair?: { complaint: string; previous: string };
	}

	function harness(options: HarnessOptions) {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const notices: string[] = [];
		const transitions: OverlayTransitions = {
			state: "closed",
			handle: null,
			close() {
				this.state = "closed";
			},
		};
		let reviewedDocument: string | null = null;
		const rounds: RoundRecord[] = [];
		const lifecycle = createOverlaySessionLifecycle({
			tui: { requestRender() {} } as never,
			transitions,
			session: contract,
			chat: {
				cancel() {},
				isStreaming: () => false,
				resetForSession(_leaf: string | null, _msgs?: ReadonlyArray<AgentMessage>) {},
				whenSettled: async () => {},
				extractHandoff: async (goal: string, roundOptions?: { repair?: { complaint: string; previous: string } }) => {
					const index = rounds.length;
					rounds.push({ goal, ...(roundOptions?.repair ? { repair: roundOptions.repair } : {}) });
					const scripted = options.answers;
					const text = scripted ? (scripted[Math.min(index, scripted.length - 1)] ?? ANSWER) : (options.answer ?? ANSWER);
					return { status: "answered" as const, text };
				},
			},
			chatPanel: {
				appendUser() {},
				clearFoldOverrides() {},
				applyEvent() {},
				appendReplayBlock() {},
				applyWorkerState() {},
			} as never,
			resetTranscript() {},
			readStructuredEntries: (sessionId: string) => readEntries(sessionId),
			getSlashNotice: () => (level: string, text: string) => notices.push(`${level}: ${text}`),
			onNewSession: () => {
				contract.create({ cwd: process.cwd() });
			},
			getDecisionBoard: () => [],
			announceTaskMemorySeedOffer() {},
			refreshFooter() {},
			requestRender() {},
			terminal: { columns: 100 },
			stderr() {},
			notify(_level: string, text: string) {
				notices.push(text);
			},
			openHandoffReviewOverlay: (
				_tui: unknown,
				deps: {
					document: string;
					onAccept: (document: string) => void;
					onCancel: () => void;
				},
			) => {
				reviewedDocument = deps.document;
				if (options.review === "accept") deps.onAccept(deps.document);
				else deps.onCancel();
				return { hide() {}, document: () => deps.document } as never;
			},
		} as never);
		return { bundle, contract, lifecycle, notices, rounds, document: () => reviewedDocument };
	}

	/** The extraction and review run on a microtask, so let them settle. */
	async function settle(): Promise<void> {
		for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
	}

	/**
	 * `/handoff` was recorded BLOCKED(model) in the 0.3.7 release test: two
	 * attempts on a local target both ended "the extraction round returned no
	 * JSON object", and every downstream behavior was unreachable because the
	 * one round that could fail had no second chance (issue #223).
	 */
	it("repairs a first round the parser refused, and produces the document", async () => {
		const h = harness({ review: "accept", answers: ["Sure! Here is the record: (I could not format it)", ANSWER] });
		h.contract.create({ cwd: process.cwd() });
		h.contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });

		h.lifecycle.startHandoff("finish the terminal lease work");
		await settle();

		strictEqual(h.rounds.length, 2, "exactly one repair round followed the refusal");
		strictEqual(h.rounds[0]?.repair, undefined, "the first round is not a repair");
		ok(h.rounds[1]?.repair !== undefined, "the second round is");
		ok(
			h.rounds[1]?.repair?.complaint.includes("no JSON object"),
			`the repair quotes the parser's complaint: ${h.rounds[1]?.repair?.complaint}`,
		);
		ok(
			h.rounds[1]?.repair?.previous.includes("I could not format it"),
			`and what came back: ${h.rounds[1]?.repair?.previous}`,
		);
		ok(h.document()?.includes("keep the lease in terminal-lease.ts"), h.document() ?? "no document");

		await h.bundle.contract.close();
	});

	it("stops at one repair and says what was asked for and what came back", async () => {
		const h = harness({ review: "accept", answers: ["not json at all", "still not json"] });
		h.contract.create({ cwd: process.cwd() });
		h.contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });

		h.lifecycle.startHandoff("finish the terminal lease work");
		await settle();

		strictEqual(h.rounds.length, 2, "the repair is bounded at exactly one");
		strictEqual(h.document(), null, "no document is reviewed");
		const refusal = h.notices.find((line) => line.includes("handoff")) ?? "";
		ok(refusal.includes("Asked for:"), `the refusal names what was asked for: ${refusal}`);
		ok(refusal.includes("decisions, facts, files, commands, and openQuestions"), refusal);
		ok(refusal.includes("Round 1:") && refusal.includes("Round 2:"), `both rounds are named: ${refusal}`);
		ok(refusal.includes("still not json"), `and what came back is quoted: ${refusal}`);

		await h.bundle.contract.close();
	});

	it("runs one round only when the first answer parses", async () => {
		const h = harness({ review: "accept" });
		h.contract.create({ cwd: process.cwd() });
		h.contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });

		h.lifecycle.startHandoff("finish the terminal lease work");
		await settle();

		strictEqual(h.rounds.length, 1, "a parseable answer costs one round, not two");

		await h.bundle.contract.close();
	});

	it("Esc cancels the handoff with nothing written anywhere", async () => {
		const h = harness({ review: "cancel" });
		const original = h.contract.create({ cwd: process.cwd() });
		h.contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });
		const before = readEntries(original.id).length;

		h.lifecycle.startHandoff("finish the terminal lease work");
		await settle();

		strictEqual(h.contract.current()?.id, original.id, "cancel must not switch sessions");
		strictEqual(h.contract.history().length, 1, "cancel must not mint a session");
		strictEqual(readEntries(original.id).length, before, "cancel must not append to the old session");
		ok(h.notices.some((line) => line.includes("cancelled")));

		await h.bundle.contract.close();
	});

	it("accept mints a session carrying the seed entry and the replayed skill activations", async () => {
		const h = harness({ review: "accept" });
		const original = h.contract.create({ cwd: process.cwd() });
		h.contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });
		h.contract.recordSkillActivation({
			name: "hlab",
			source: "user",
			hash: "abc123",
			triggeredBy: "slash-command",
			filePath: "/skills/hlab/SKILL.md",
		});

		h.lifecycle.startHandoff("finish the terminal lease work");
		await settle();

		const newId = h.contract.current()?.id ?? "";
		ok(newId.length > 0 && newId !== original.id, "accept must mint a new session and land on it");

		const seeded = readEntries(newId);
		const seed = seeded.find((entry) => entry.kind === "custom" && entry.customType === HANDOFF_SEED_CUSTOM_TYPE);
		ok(seed, "the new session must open with the handoff seed entry");
		const seedData = (seed as { data?: { fromSessionId?: string; document?: string } }).data;
		strictEqual(seedData?.fromSessionId, original.id, "the seed must name the session it came from");
		ok((seedData?.document ?? "").includes("# Handoff"));
		strictEqual(
			seeded.some((entry) => entry.kind === "message" && entry.role === "user"),
			false,
			"the document must never be seeded as a fabricated user turn",
		);
		const replayed = seeded.filter((entry) => entry.kind === "skillActivation");
		strictEqual(replayed.length, 1, "loaded skills must carry forward into the successor session");

		// The old session is untouched apart from one terminal note naming the target.
		const oldEntries = readEntries(original.id);
		const notes = oldEntries.filter((entry) => entry.kind === "custom" && entry.customType === HANDOFF_NOTE_CUSTOM_TYPE);
		strictEqual(notes.length, 1);
		strictEqual((notes[0] as { data?: { toSessionId?: string } }).data?.toSessionId, newId);

		await h.bundle.contract.close();
	});

	it("drops an invented path from the reviewed document and keeps a touched one", async () => {
		const answer = JSON.stringify({
			decisions: [],
			facts: [],
			files: [
				{ path: "src/interactive/terminal-lease.ts", why: "read in this session" },
				{ path: "src/interactive/never-here.ts", why: "invented" },
			],
			commands: [],
			openQuestions: [],
		});
		const h = harness({ answer, review: "cancel" });
		h.contract.create({ cwd: process.cwd() });
		const turn = h.contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });
		h.contract.appendEntry({
			kind: "message",
			parentTurnId: turn.id,
			role: "tool_call",
			payload: { toolCallId: "c1", name: "read", args: { path: "src/interactive/terminal-lease.ts" } },
		});

		h.lifecycle.startHandoff("finish the terminal lease work");
		await settle();

		const document = h.document() ?? "";
		ok(document.includes("## Files"));
		const dropped = document.slice(document.indexOf(HANDOFF_DROPPED_HEADING));
		ok(dropped.includes("never-here.ts"), "the invented path belongs under the dropped heading");
		ok(!dropped.includes("terminal-lease.ts"), "the touched path must stay in the kept list");

		await h.bundle.contract.close();
	});

	it("refuses a goal that fails the gate before any model round runs", async () => {
		const h = harness({ review: "accept" });
		const original = h.contract.create({ cwd: process.cwd() });

		h.lifecycle.startHandoff("continue");
		await settle();

		strictEqual(h.contract.current()?.id, original.id);
		strictEqual(h.contract.history().length, 1);
		ok(h.notices.some((line) => line.includes("[/handoff]")));

		await h.bundle.contract.close();
	});
});

describe("contracts/handoff review overlay", () => {
	it("shows the goal above the document and reports the scrolled window", () => {
		const document = Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join("\n");
		const body = formatHandoffReviewBody("finish the eviction rules", document, 60, 5);
		ok(body[0]?.includes("finish the eviction rules"));
		ok(body.some((line) => line.includes("line 5")));
		ok(!body.some((line) => line.includes("line 4")), "the window starts at the scroll offset");
		ok(body[body.length - 1]?.includes("of 40 lines"));
	});

	it("tracks the terminal width between its bounds", () => {
		strictEqual(handoffReviewOverlayWidth(20), 44);
		strictEqual(handoffReviewOverlayWidth(80), 76);
		strictEqual(handoffReviewOverlayWidth(400), 100);
	});
});

describe("contracts/handoff never touches the memory domain", () => {
	/**
	 * The settled boundary, enforced statically. `/handoff` is a session
	 * operation: it writes no memory promotion candidate, reads no memory
	 * record, and never calls the task-memory bank. A future edit that reaches
	 * for the memory domain from any of these files fails here rather than
	 * silently turning a handoff into a promotion.
	 */
	const HANDOFF_SOURCES = [
		"src/domains/session/handoff.ts",
		"src/interactive/handoff-round.ts",
		"src/interactive/overlays/handoff-review.ts",
	];

	it("no handoff module imports the memory domain", () => {
		for (const relative of HANDOFF_SOURCES) {
			const source = readFileSync(join(REPO_ROOT, relative), "utf8");
			ok(!/from\s+"[^"]*domains\/memory/.test(source), `${relative} must not import the memory domain`);
			// Identifiers, not prose: this file's own header explains that a
			// handoff never calls the task-memory bank, and saying so is not
			// calling it.
			ok(
				!/\b(?:taskMemory|seedTaskMemory|announceTaskMemorySeedOffer|proposeMemoryPromotion|loadMemoryRecordsSync)\b/.test(
					source,
				),
				`${relative} must not call the task-memory bank`,
			);
		}
	});

	it("the session-lifecycle handoff path names no memory or task-memory call", () => {
		const source = readFileSync(join(REPO_ROOT, "src/interactive/overlay-session-lifecycle.ts"), "utf8");
		ok(!/from\s+"[^"]*domains\/memory/.test(source));
		ok(!/proposeMemoryPromotion|seedTaskMemory|loadMemoryRecords/.test(source));
	});
});

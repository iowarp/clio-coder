import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryOperatorStatus } from "../../src/domains/memory/task-memory-status.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { MemoryOverlayView } from "../../src/interactive/memory-overlay.js";
import { memoryLessonDetail, memoryTaskDetail, memoryViewSignature } from "../../src/interactive/memory-view-model.js";

function record(id: string, lesson: string, fields: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id,
		scope: "global",
		key: id,
		lesson,
		evidenceRefs: ["session:origin-session"],
		appliesWhen: ["Before running repository verification"],
		avoidWhen: ["The repository moved to a different test runner"],
		confidence: 0.97,
		createdAt: "2026-10-14T00:00:00.000Z",
		approved: true,
		provenance: { sourceKind: "task-bank-entry", sourceSessionId: "origin-session", sourceEntryKind: "knowledge" },
		...fields,
	};
}

function status(bank = new TaskMemoryBank()): TaskMemoryOperatorStatus {
	const snapshot = bank.snapshot();
	return {
		enabled: true,
		tier: "llm",
		size: snapshot.knowledge.length + snapshot.procedural.length + (snapshot.status ? 1 : 0),
		lastDecision: null,
		bank: snapshot,
		activity: [],
		stepInFlight: false,
	};
}

function plain(view: MemoryOverlayView, width = 120): string {
	return view.render(width).map(stripTerminalSequences).join("\n");
}

const nextTab = "\u001b[C";
const previousTab = "\u001b[D";

test("memory opens on eligible lessons and separates private task state, review and diagnostics", () => {
	const bank = new TaskMemoryBank();
	bank.updateStatus("Private pending verification");
	bank.saveKnowledge("Temporary task knowledge");
	const repository = canonicalMemoryRepositoryIdentity(process.cwd());
	ok(repository);
	const records = [
		record("global", "Run global verification"),
		record("repo", "Run this repository verification", { scope: "repo", repository }),
		record("other", "Foreign repository lesson", {
			scope: "repo",
			repository: { kind: "canonical-path", key: "/different-repository" },
		}),
		record("pending", "Candidate pending review", { approved: false }),
		record("regressed", "Contradicted lesson", { regressions: ["command no longer succeeds"] }),
		record("rejected", "Operator rejected lesson", { rejectedAt: "2026-10-14T01:00:00.000Z" }),
		record("missing", "Lesson without evidence", { evidenceRefs: [] }),
		record("runtime", "Runtime specific lesson", { scope: "runtime", runtime: { kind: "runtime", key: "litellm" } }),
	];
	const view = new MemoryOverlayView(
		() => status(bank),
		() => records,
		() => {},
		() => {},
		{ activeRepository: () => repository },
	);
	const lessons = plain(view);
	match(lessons, /Run global verification/u);
	match(lessons, /Run this repository verification/u);
	doesNotMatch(
		lessons,
		/Private pending|Temporary task|Foreign repository|Candidate pending|Contradicted lesson|Operator rejected|Lesson without evidence|Runtime specific/u,
	);
	doesNotMatch(lessons, /tier LLM|bank \d|offered \d|consumed \d|Confidence:/u);
	view.handleInput(nextTab);
	match(plain(view), /Private pending verification/u);
	match(plain(view), /session only/u);
	view.handleInput(nextTab);
	match(plain(view), /Candidate pending review/u);
	match(plain(view), /Contradicted lesson/u);
	view.handleInput(nextTab);
	match(plain(view), /Background memory/u);
});

test("runtime and repository applicability follow explicit live callbacks", () => {
	const repository = canonicalMemoryRepositoryIdentity(process.cwd());
	ok(repository);
	let runtime: { kind: "runtime"; key: string } | null = null;
	let activeRepository = repository;
	const records = [
		record("runtime", "Ornith runtime lesson", { scope: "runtime", runtime: { kind: "runtime", key: "litellm" } }),
		record("repo", "Local repository lesson", { scope: "repo", repository }),
	];
	const view = new MemoryOverlayView(
		() => status(),
		() => records,
		() => {},
		() => {},
		{ activeRepository: () => activeRepository, activeRuntime: () => runtime },
	);
	doesNotMatch(plain(view), /Ornith runtime lesson/u);
	runtime = { kind: "runtime", key: "litellm" };
	match(plain(view), /Ornith runtime lesson/u);
	activeRepository = { kind: "canonical-path", key: "/different-repository" };
	doesNotMatch(plain(view), /Local repository lesson/u);
});

test("explicit search does not invoke reject, and an operator review updates the visible tabs", async () => {
	let records = [record("lesson", "Run node verify.mjs before shipping")];
	let reviews = 0;
	const view = new MemoryOverlayView(
		() => status(),
		() => records,
		() => {},
		() => {},
		{
			onReview: async (selected, action) => {
				reviews++;
				const updated = {
					...selected,
					approved: action === "approve",
					...(action === "reject" ? { rejectedAt: "2026-10-14T01:00:00.000Z" } : {}),
				};
				if (action === "approve") Reflect.deleteProperty(updated, "rejectedAt");
				records = [updated];
				return updated;
			},
		},
	);
	plain(view);
	view.handleInput("/");
	view.handleInput("x");
	strictEqual(reviews, 0);
	view.handleInput("\u001b");
	view.handleInput("\u001b");
	view.handleInput("x");
	await new Promise<void>((resolve) => setImmediate(resolve));
	strictEqual(reviews, 1);
	doesNotMatch(plain(view), /Run node verify/u);
	view.handleInput(nextTab);
	view.handleInput(nextTab);
	match(plain(view), /Rejected by operator/u);
	view.handleInput("a");
	await new Promise<void>((resolve) => setImmediate(resolve));
	strictEqual(reviews, 2);
	view.handleInput(previousTab);
	view.handleInput(previousTab);
	match(plain(view), /Run node verify/u);
});

test("private status offers no promotion and cannot reach the promotion handler", () => {
	const bank = new TaskMemoryBank();
	const entry = bank.updateStatus("Private working state");
	let promotions = 0;
	const view = new MemoryOverlayView(
		() => status(bank),
		() => [],
		() => {},
		() => {},
		{
			onPromote: async () => {
				promotions++;
				return { record: record("unused", "unused"), created: true };
			},
		},
	);
	view.handleInput(nextTab);
	plain(view);
	doesNotMatch(view.getHint(), /propose/u);
	view.handleInput("p");
	strictEqual(promotions, 0);
	match(memoryTaskDetail(entry).join("\n"), /excluded from memory_recall and cannot be promoted/u);
});

test("detail names the subject, reach, track record and evidence without treating confidence or delivery as usefulness", () => {
	const lesson = record("lesson", "Run `CLIO_TEST_BACKEND=host node scripts/verify.mjs` before shipping", {
		approval: { by: "guardian", at: "2026-10-14T01:00:00.000Z" },
		lastVerifiedAt: "2026-10-14T03:00:00.000Z",
		observations: [
			{ kind: "held", at: "2026-10-14T01:00:00.000Z", sessionId: "origin-session" },
			{ kind: "delivered", at: "2026-10-14T02:00:00.000Z", sessionId: "later-session" },
			{ kind: "delivered", at: "2026-10-14T02:10:00.000Z", sessionId: "later-session" },
			{ kind: "held", at: "2026-10-14T03:00:00.000Z", sessionId: "later-session" },
		],
	});
	const detail = memoryLessonDetail(lesson, true).join("\n");
	for (const heading of ["Concerns", "Lesson", "Applies", "Track record", "Evidence"])
		match(detail, new RegExp(`## ${heading}`, "u"));
	match(detail, /Command `CLIO_TEST_BACKEND=host node scripts\/verify\.mjs`/u);
	match(detail, /Paths: scripts\/verify\.mjs/u);
	match(detail, /Environment: CLIO_TEST_BACKEND/u);
	match(detail, /Every repository/u);
	match(detail, /Not when: The repository moved to a different test runner/u);
	// Outcomes count once per session, and the source session's own hold is named apart.
	match(detail, /Delivered in 1 sessions; held in 1 later sessions and in the session it came from; contradicted in 0/u);
	match(detail, /Last verified 2026-10-14T03:00:00.000Z/u);
	match(detail, /do not prove.*changed the result/u);
	doesNotMatch(detail, /0\.97|Confidence/u);
});

test("reach follows the main prompt's scopes and the last prompt selection", () => {
	const repository = canonicalMemoryRepositoryIdentity(process.cwd());
	ok(repository);
	const inPrompt = record("repo", "Repository lesson", { scope: "repo", repository });
	const budgeted = record("global", "Global lesson");
	const recallOnly = record("language", "Language lesson", { scope: "language" });
	const selection = {
		turnId: "1",
		repository: repository.key,
		runtime: "litellm",
		model: "m",
		preparedAt: "2026-10-14T00:00:00.000Z",
		submittedAt: null,
		section: "",
		tokenBudget: 100,
		items: [
			{ id: "repo", text: "Repository lesson", scope: "repo", rank: 1, reason: "selected" as const },
			{ id: "global", text: "Global lesson", scope: "global", rank: 2, reason: "token-budget" as const },
		],
	};
	match(memoryLessonDetail(inPrompt, true, selection).join("\n"), /In this session's prompt, rank 1/u);
	match(memoryLessonDetail(budgeted, true, selection).join("\n"), /token budget left it out/u);
	match(memoryLessonDetail(recallOnly, true, selection).join("\n"), /memory_recall only/u);
	const view = new MemoryOverlayView(
		() => ({ ...status(), promptSelection: selection }),
		() => [inPrompt, budgeted, recallOnly],
		() => {},
		() => {},
		{ activeRepository: () => repository },
	);
	const lessons = plain(view);
	match(lessons, /this repo · prompt/u);
	match(lessons, /language · recall only/u);
});

test("text, applicability, verification and feedback changes refresh a selected detail without ID changes", () => {
	let records = [record("same-id", "Old command")];
	const view = new MemoryOverlayView(
		() => status(),
		() => records,
		() => {},
		() => {},
	);
	const before = memoryViewSignature(status(), records, {});
	match(plain(view), /Old command/u);
	const original = records[0];
	ok(original);
	records = [
		{
			...original,
			lesson: "New command",
			appliesWhen: ["After changing config"],
			lastVerifiedAt: "2026-10-14T03:00:00.000Z",
			observations: [{ kind: "held", at: "2026-10-14T04:00:00.000Z", sessionId: "verification-session" }],
		},
	];
	notStrictEqual(memoryViewSignature(status(), records, {}), before);
	const updated = plain(view, 200);
	match(updated, /New command/u);
	match(updated, /After changing config/u);
	doesNotMatch(updated, /Old command/u);
});

test("memory tabs fit narrow and wide terminals with long content", () => {
	const bank = new TaskMemoryBank();
	bank.saveKnowledge("Long task state ".repeat(30));
	const records = [
		record("long", "Repository verification instruction ".repeat(30)),
		record("pending", "Pending instruction ".repeat(20), { approved: false }),
	];
	for (const width of [60, 80, 96, 120, 200]) {
		const view = new MemoryOverlayView(
			() => status(bank),
			() => records,
			() => {},
			() => {},
		);
		for (let tab = 0; tab < 4; tab++) {
			for (const line of view.render(width)) ok(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
			view.handleInput(nextTab);
		}
	}
});

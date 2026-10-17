import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRetention, retentionPath } from "../../src/domains/memory/completion-retention.js";
import type { CompletedLessonSource } from "../../src/domains/memory/history-review.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { MemoryRuntime } from "../../src/domains/memory/runtime.js";
import { loadMemoryRecordsSync } from "../../src/domains/memory/store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { proposeInjectedTaskMemory } from "../../src/domains/memory/task-bank-promotion.js";
import { runTaskMemoryPolicy, TaskMemoryEndpointPreemptedError } from "../../src/domains/memory/task-memory-policy.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";

const COMMAND = "node scripts/check.mjs --mode native";

test("an approved command lesson surfaces once at the first non-documentation edit and holds on the command's success", () => {
	const delivered: string[] = [];
	const held: string[] = [];
	const memory = createMemoryInterventionRegistration({
		bank: new TaskMemoryBank(),
		getKeptLessons: () => [{ id: "mem-recipe", text: `Validation requires \`${COMMAND}\`.` }],
		onDurableLessonOutcomes: (outcome) => {
			delivered.push(...outcome.delivered);
			held.push(...outcome.held);
		},
	});
	let call = 0;
	const after = (toolName: string, toolArgs: Record<string, unknown>, extra: Partial<MiddlewareHookInput> = {}) =>
		memory.evaluate({
			hook: "after_tool",
			sessionId: "B",
			toolName,
			toolCallId: String(++call),
			toolArgs,
			metadata: { resultKind: "ok", actionClass: toolName === "bash" ? "execute" : "write" },
			...extra,
		});
	try {
		memory.evaluate({ hook: "turn_start", sessionId: "B", text: "Add a helper and validate it." });
		deepStrictEqual(after("edit", { path: "README.md" }), [], "a prose-only edit is not what the command exercises");
		const surfaced = after("edit", { path: "src/rates.mjs" });
		strictEqual(surfaced[0]?.kind, "annotate_tool_result");
		const message = surfaced[0]?.kind === "annotate_tool_result" ? surfaced[0].message : "";
		match(message, /^Memory: \[mem-recipe\]/u);
		deepStrictEqual(after("edit", { path: "src/other.mjs" }), [], "one surfacing per session");
		deepStrictEqual(delivered, [], "producing the annotation is not delivering it");
		memory.acknowledgeSubmission([`[middleware:info] ${message}`]);
		after("bash", { command: COMMAND }, { toolResultDetails: { outcome: "success", exitCode: 0 } });
		deepStrictEqual(delivered, ["mem-recipe"]);
		deepStrictEqual(held, ["mem-recipe"]);
	} finally {
		memory.dispose();
	}
});

test("a failing variant of a remembered recipe gets the recipe on its failed result, with no edit and no prompt cue", () => {
	const root = mkdtempSync(join(tmpdir(), "memory-recipe-variant-"));
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts", "check.mjs"), "process.exit(2);\n");
	const delivered: string[] = [];
	const memory = createMemoryInterventionRegistration({
		bank: new TaskMemoryBank(),
		workspaceRoot: () => root,
		getKeptLessons: () => [{ id: "mem-recipe", text: `Run scripts/check.mjs as \`${COMMAND}\`.` }],
		onDurableLessonOutcomes: (outcome) => delivered.push(...outcome.delivered),
	});
	const failed = (command: string, id: string) =>
		memory.evaluate({
			hook: "after_tool",
			sessionId: "C",
			toolName: "bash",
			toolCallId: id,
			toolArgs: { command },
			metadata: { resultKind: "error", actionClass: "execute", errorMessage: "MODE_REQUIRED" },
		});
	try {
		memory.evaluate({ hook: "turn_start", sessionId: "C", text: "What does this repository do?" });
		deepStrictEqual(failed("node scripts/other.mjs", "1"), [], "another file is not this recipe's trap");
		const effects = failed("node scripts/check.mjs", "2");
		strictEqual(effects[0]?.kind, "annotate_tool_result");
		const message = effects[0]?.kind === "annotate_tool_result" ? effects[0].message : "";
		match(message, /\[mem-recipe\]/u);
		deepStrictEqual(delivered, [], "delivery waits for the submitted request");
		memory.acknowledgeSubmission([`[middleware:info] ${message}`]);
		deepStrictEqual(delivered, ["mem-recipe"]);
	} finally {
		memory.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a verification gap and a read of the lesson's own file each bring the recipe once, and its own successful run needs none", () => {
	const root = mkdtempSync(join(tmpdir(), "memory-recipe-triggers-"));
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts", "check.mjs"), "process.exit(2);\n");
	const triggers: string[] = [];
	const make = () =>
		createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			workspaceRoot: () => root,
			getKeptLessons: () => [{ id: "mem-recipe", text: `Run scripts/check.mjs as \`${COMMAND}\`.` }],
			telemetry: { record: (row) => triggers.push(...row.triggerReasons) },
		});
	const verify = make();
	const reader = make();
	const runner = make();
	try {
		// The prompt's memory section already led this session to the recipe: its
		// own successful run names the lesson's file and needs no reminder after it.
		runner.evaluate({ hook: "turn_start", sessionId: "F", text: "Run the validation." });
		deepStrictEqual(
			runner.evaluate({
				hook: "after_tool",
				sessionId: "F",
				toolName: "bash",
				toolCallId: "1",
				toolArgs: { command: COMMAND },
				metadata: { resultKind: "ok", actionClass: "execute" },
				toolResultDetails: { outcome: "success", exitCode: 0 },
			}),
			[],
		);
		verify.evaluate({ hook: "turn_start", sessionId: "D", text: "Is the project healthy?" });
		const gap = verify.evaluate({
			hook: "after_tool",
			sessionId: "D",
			toolName: "verify",
			toolCallId: "1",
			toolArgs: {},
			metadata: { resultKind: "ok", actionClass: "read" },
			toolResultDetails: { sources: [{ kind: "package.json", checks: [] }], derived: [] },
		});
		match(gap[0]?.kind === "annotate_tool_result" ? gap[0].message : "", /\[mem-recipe\]/u);
		reader.evaluate({ hook: "turn_start", sessionId: "E", text: "Explain the scripts." });
		const read = (id: string) =>
			reader.evaluate({
				hook: "after_tool",
				sessionId: "E",
				toolName: "read",
				toolCallId: id,
				toolArgs: { path: join(root, "scripts", "check.mjs") },
				metadata: { resultKind: "ok", actionClass: "read" },
			});
		const first = read("1");
		match(first[0]?.kind === "annotate_tool_result" ? first[0].message : "", /\[mem-recipe\]/u);
		deepStrictEqual(read("2"), [], "once per session");
		ok(triggers.includes("durable_lesson_verify"));
		ok(triggers.includes("durable_lesson_subject"));
	} finally {
		verify.dispose();
		reader.dispose();
		runner.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

/** A runtime in a fresh process that finds one closed session's interrupted retention on disk. */
async function closedSessionRuntime(source: CompletedLessonSource, complete: () => Promise<{ text: string }>) {
	const root = mkdtempSync(join(tmpdir(), "memory-closed-session-"));
	const stateDir = join(root, "state");
	const dataDir = join(root, "data");
	const cwd = join(root, "project");
	for (const dir of [join(stateDir, "memory", "retention"), dataDir, join(cwd, "scripts")])
		mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(cwd, "scripts", "check.mjs"),
		"if (process.argv.slice(2).join(' ') !== '--mode native') process.exit(2);\n",
	);
	const scope = { sessionId: "closed-a", branchAnchorTurnId: "t9" };
	const marker = retentionPath(stateDir, scope, source);
	// What a process that exited mid-retention leaves behind; nothing else names this session.
	writeFileSync(
		marker,
		JSON.stringify({
			version: 1,
			phase: "pending",
			reason: "deadline-or-cancelled",
			extracted: 0,
			retained: [],
			attempts: 0,
			revision: source.revision,
			sessionId: scope.sessionId,
		}),
	);
	const runtime = new MemoryRuntime();
	runtime.createIntervention({});
	runtime.configure({
		stateDir: () => stateDir,
		dataDir: () => dataDir,
		cwd: () => cwd,
		settings: () => ({ enabled: true, observations: { enabled: false }, maxOutputTokens: 512, timeoutMs: 5000 }),
		lessonSource: () => null,
		closedLessonSource: (sessionId) => (sessionId === scope.sessionId ? { scope, source } : null),
		source: () => null,
		usableHistoryTokens: () => 0,
		client: {
			getModelClient: () => ({ complete }),
			getModelMaxTokens: (configured: number) => configured,
			backgroundEndpointBusy: () => false,
		},
	});
	return {
		runtime,
		marker: () => readRetention(marker),
		records: () => loadMemoryRecordsSync(dataDir),
		cleanup: () => {
			runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const SILENT = { text: "<operations>[]</operations>\n<no_intervention/>" };

test("a closed session's interrupted retention runs beside a turn, and a preemption costs no attempt", async () => {
	let calls = 0;
	const closed = await closedSessionRuntime(
		{
			revision: "rev-a",
			refs: ["t1"],
			text: "ok: make lint",
			succeededCommands: new Set(["make lint"]),
			observedReads: new Map(),
			commandRuns: [{ command: "make lint", ok: true, diagnostic: "" }],
		},
		async () => {
			calls += 1;
			if (calls === 1) throw new TaskMemoryEndpointPreemptedError("foreground request claimed the memory endpoint");
			return SILENT;
		},
	);
	try {
		ok(closed.runtime.pendingWork(true), "a closed session's retention qualifies while a turn streams");
		strictEqual(await closed.runtime.runIdleStep(true), "yielded");
		strictEqual(closed.marker()?.attempts, 0, "occupancy is not an answer");
		strictEqual(await closed.runtime.runIdleStep(true), "ran");
		strictEqual(closed.marker()?.phase, "abstained");
		strictEqual(closed.marker()?.attempts, 1);
		strictEqual(closed.runtime.pendingWork(true), false);
		strictEqual(
			closed.runtime.contract.retentionStatus().phase,
			"idle",
			"a closed session's status is not this session's",
		);
	} finally {
		closed.cleanup();
	}
});

test("a recipe the task's receipts prove is retained though the model keeps nothing", async () => {
	const closed = await closedSessionRuntime(
		{
			revision: "rev-b",
			refs: ["t9"],
			text: `read scripts/check.mjs\nok: ${COMMAND}`,
			succeededCommands: new Set([COMMAND]),
			observedReads: new Map([["scripts/check.mjs", ["if (process.argv.slice(2).join(' ') !== '--mode native')"]]]),
			commandRuns: [{ command: COMMAND, ok: true, diagnostic: "" }],
		},
		async () => SILENT,
	);
	try {
		strictEqual(await closed.runtime.runIdleStep(true), "ran");
		strictEqual(closed.marker()?.phase, "retained");
		const records = closed.records();
		strictEqual(records.length, 1);
		strictEqual(records[0]?.approved, true);
		ok(records[0]?.lesson.includes(`\`${COMMAND}\``));
	} finally {
		closed.cleanup();
	}
});

test("an operation list missing only its closing bracket is repaired, and nothing else is", async () => {
	const reply = (body: string) => ({ complete: async () => ({ text: `<operations>${body}</operations>` }) });
	const input = { task: "Keep facts", trajectory: [], deterministicTrigger: false, maxTokens: 2000 };
	const repaired = await runTaskMemoryPolicy(
		new TaskMemoryBank(),
		reply('[{"op":"save_knowledge","content":"first"},{"op":"save_knowledge","content":"second"},'),
		input,
	);
	strictEqual(repaired.bankOperations, 2);
	const broken = await runTaskMemoryPolicy(
		new TaskMemoryBank(),
		reply('[{"op":"save_knowledge","content":"first"'),
		input,
	);
	strictEqual(broken.decision, "malformed");
});

test("lessons quoting the same command stay separate claims, and one session holds each once", async () => {
	const root = mkdtempSync(join(tmpdir(), "memory-same-command-"));
	const dataDir = join(root, "data");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const entry = (content: string) =>
		new TaskMemoryBank().saveKnowledge(content, { durable: true, evidenceCommand: COMMAND });
	const native = `Run \`${COMMAND}\` only with the native backend installed.`;
	try {
		const first = await proposeInjectedTaskMemory(dataDir, {
			sessionId: "s1",
			cwd,
			entries: [entry(native)],
			observation: "held",
		});
		const mock = await proposeInjectedTaskMemory(dataDir, {
			sessionId: "s2",
			cwd,
			entries: [entry(`Run \`${COMMAND}\` only with the mock backend.`)],
			observation: "held",
		});
		const repeat = await proposeInjectedTaskMemory(dataDir, {
			sessionId: "s1",
			cwd,
			entries: [entry(native)],
			observation: "held",
		});
		const id = first.records[0]?.id;
		ok(id);
		strictEqual(repeat.records[0]?.id, id, "the same claim from the same session is the same record");
		notStrictEqual(mock.records[0]?.id, id, "a shared command never merges different prerequisites");
		const stored = JSON.parse(readFileSync(join(dataDir, "memory", "records.json"), "utf8")).records;
		strictEqual(stored.length, 2);
		const nativeRecord = stored.find((record: { id: string }) => record.id === id);
		strictEqual(nativeRecord.observations.length, 1, "a repeat from the same session adds no second verdict");
		strictEqual(nativeRecord.observations[0].sessionId, "s1", "the mock session's evidence stays with its own claim");
		ok(
			stored.every((record: { evidenceRefs: string[] }) => record.evidenceRefs.some((ref) => ref.startsWith("command:"))),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

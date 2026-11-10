import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMemoryCommand } from "../../src/cli/memory.js";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { readRetention, retentionPath } from "../../src/domains/memory/completion-retention.js";
import type { CompletedLessonSource } from "../../src/domains/memory/history-review.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { MemoryLessonFeedback } from "../../src/domains/memory/lesson-feedback.js";
import { MemoryRuntime } from "../../src/domains/memory/runtime.js";
import { loadMemoryRecordsSync, memoryStorePath } from "../../src/domains/memory/store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { proposeInjectedTaskMemory } from "../../src/domains/memory/task-bank-promotion.js";
import { renderTaskMemoryHandoffSource } from "../../src/domains/memory/task-memory-handoff.js";
import { runTaskMemoryPolicy, TaskMemoryEndpointPreemptedError } from "../../src/domains/memory/task-memory-policy.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { cwdHash } from "../../src/engine/session.js";
import { closedSessionLessonSource } from "../../src/entry/flow-ledger.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

const COMMAND = "node scripts/check.mjs --mode native";

test("promote --from-handoff finds the source from any directory and refuses only what it should", async () => {
	const env = await isolateClioEnv("memory-promote-flow-");
	const previousCwd = process.cwd();
	try {
		const project = realpathSync(mkdtempSync(join(env.dir, "project-")));
		const elsewhere = realpathSync(mkdtempSync(join(env.dir, "elsewhere-")));
		const at = "2026-11-03T10:00:00.000Z";
		const base = { parentTurnId: null, timestamp: at };
		const session = (id: string, lines: string[]) => {
			const dir = join(clioStateDir(), "sessions", cwdHash(project), id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "meta.json"),
				JSON.stringify({ id, cwd: project, createdAt: at, endedAt: at, clioCoderVersion: "0.6.8" }),
			);
			writeFileSync(join(dir, "current.jsonl"), `${lines.join("\n")}\n`);
		};
		const custom = (customType: string) =>
			JSON.stringify({ ...base, kind: "custom", turnId: customType, customType, data: {} });
		session("labeled", [custom("clio_coder_flow_restriction")]);
		session("torn", [custom("noop"), '{"kind":"message","torn', custom("noop2")]);
		const promote = async (source: string, cwd: string) => {
			const path = join(env.dir, `${source}.md`);
			const bank = new TaskMemoryBank();
			bank.saveKnowledge(`A lesson from ${source} in ${cwd}.`);
			writeFileSync(
				path,
				renderTaskMemoryHandoffSource(bank.snapshot(), {
					sessionId: source,
					evidenceRefs: [`session-${source}`],
					runtimeIds: [],
					agentIds: [],
				}),
			);
			process.chdir(cwd);
			return runMemoryCommand(["promote", "--from-handoff", path, "--scope", "repo", "--repository", project]);
		};
		const records = () => loadMemoryRecordsSync(clioDataDir()).length;
		strictEqual(await promote("labeled", elsewhere), 1, "another directory's bucket is searched");
		strictEqual(records(), 0);
		strictEqual(await promote("torn", project), 0, "a torn line is not a restriction");
		strictEqual(records(), 1);
		strictEqual(await promote("unknown", project), 0, "no rules, nothing to vouch for");
		strictEqual(records(), 2);
		mkdirSync(join(project, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(project, ".clio-coder", "safety.yaml"),
			"version: 1\ninformationFlow:\n  sources:\n    - id: s\n      paths: [secrets/]\n      recipients: []\n",
		);
		strictEqual(await promote("unknown2", project), 1, "under source rules an unknown source is refused");
		strictEqual(records(), 2);
		strictEqual(await promote("unknown3", elsewhere), 1, "the rules are the named repository's, not the cwd's");
		strictEqual(records(), 2);
	} finally {
		process.chdir(previousCwd);
		env.restore();
	}
});

test("propose --from-evidence refuses a run or dispatching session that carries a flow label", async () => {
	const env = await isolateClioEnv("memory-evidence-flow-");
	const previousCwd = process.cwd();
	try {
		const project = realpathSync(mkdtempSync(join(env.dir, "project-")));
		process.chdir(project);
		const label = {
			version: 1,
			restrictions: [{ ruleId: "secrets", policyHash: "hash", sourceRef: "secrets/notes.txt", recipients: [] }],
		};
		const settle = async (id: string, sessionId: string | null, labeled: boolean) => {
			const envelope = { ...fixtureEnvelope(id), sessionId, cwd: project };
			const draft = fixtureReceiptDraft(envelope);
			await writeSettledRun(clioStateDir(), {
				...draft,
				...(labeled ? { safety: { ...draft.safety, flowRestrictions: label } } : {}),
			} as typeof draft);
		};
		const records = () => (existsSync(memoryStorePath(clioDataDir())) ? loadMemoryRecordsSync(clioDataDir()).length : 0);
		const propose = (id: string) => runMemoryCommand(["propose", "--from-evidence", id]);
		const at = "2026-11-03T10:00:00.000Z";
		const sessionDir = join(clioStateDir(), "sessions", cwdHash(project), "labeled-session");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "meta.json"),
			JSON.stringify({ id: "labeled-session", cwd: project, createdAt: at, endedAt: at, clioCoderVersion: "0.6.8" }),
		);
		writeFileSync(
			join(sessionDir, "current.jsonl"),
			`${JSON.stringify({ kind: "custom", turnId: "label", parentTurnId: null, timestamp: at, customType: "clio_coder_flow_restriction", data: {} })}\n`,
		);

		await settle("run-labeled", null, true);
		strictEqual(await propose("run-labeled"), 1, "the run's own result carries a label");
		strictEqual(records(), 0);

		await settle("run-from-labeled-session", "labeled-session", false);
		strictEqual(await propose("run-from-labeled-session"), 1, "the dispatching session carries a label");
		strictEqual(records(), 0);

		await settle("run-clean", null, false);
		strictEqual(await propose("run-clean"), 0, "a clean run with no session still proposes");
		strictEqual(records(), 1);
	} finally {
		process.chdir(previousCwd);
		env.restore();
	}
});

test("a closed session's flow label restricts it from any branch, not only the active path", () => {
	const at = "2026-11-03T10:00:00.000Z";
	const message = (turnId: string, parentTurnId: string | null, role: string, payload: unknown) => ({
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: at,
		role,
		payload,
	});
	const abandoned = [message("u0", null, "user", { text: "first" }), message("a0", "u0", "assistant", { text: "read" })];
	const label = {
		kind: "custom",
		turnId: "label",
		parentTurnId: "a0",
		timestamp: at,
		customType: "clio_coder_flow_restriction",
		data: {},
	};
	const active = [
		message("u1", "u0", "user", { text: "second" }),
		message("c1", "u1", "tool_call", { toolCallId: "c1", name: "bash", args: { command: "node scripts/check.mjs" } }),
		message("r1", "c1", "tool_result", {
			toolCallId: "c1",
			outcome: "ok",
			result: { content: [{ type: "text", text: "done" }], details: { kind: "ok", outcome: "success", exitCode: 0 } },
		}),
		message("a1", "r1", "assistant", { text: "done", stopReason: "stop" }),
	];
	const review = (entries: unknown[]) =>
		closedSessionLessonSource(entries.map((entry) => JSON.stringify(entry)).join("\n"), "ledger", "closed", "/repo");
	ok(review([...abandoned, ...active]), "the same ledger with no label stays reviewable");
	strictEqual(review([...abandoned, label, ...active]), null);
});

test("a flow-restricted session files no lesson at scope end, and a clean one still does", async () => {
	const root = mkdtempSync(join(tmpdir(), "memory-flow-"));
	try {
		const bank = new TaskMemoryBank();
		const lesson = bank.saveKnowledge("Release with `pnpm run release`.", {
			durable: true,
			evidenceCommand: "pnpm run release",
		});
		const feedback = (dataDir: string, restricted: boolean) =>
			new MemoryLessonFeedback({
				dataDir: () => dataDir,
				stateDir: () => root,
				session: () => ({ id: "s", cwd: root }),
				sessionFlowRestricted: () => restricted,
				notice: () => {},
				diagnostic: () => {},
			});
		const restricted = feedback(join(root, "restricted"), true);
		restricted.scopeEnd({ sessionId: "s", lessons: [lesson] });
		await restricted.whenSettled();
		strictEqual(loadMemoryRecordsSync(join(root, "restricted")).length, 0);
		const clean = feedback(join(root, "clean"), false);
		clean.scopeEnd({ sessionId: "s", lessons: [lesson] });
		await clean.whenSettled();
		strictEqual(loadMemoryRecordsSync(join(root, "clean")).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a lesson the task plainly asks about is offered once, only when the prompt lacks it and nothing else matches", () => {
	const delivered: string[] = [];
	const port = "The GUI demo box serves the app on port 47811.";
	const memory = createMemoryInterventionRegistration({
		bank: new TaskMemoryBank(),
		getKeptLessons: () => [
			{ id: "mem-port", text: port },
			{ id: "mem-log", text: "Changelog entries for GUI-only changes go under a GUI subheading." },
		],
		onDurableLessonOutcomes: (outcome) => delivered.push(...outcome.delivered),
	});
	const task = "What port did we settle on for the GUI demo box?";
	try {
		strictEqual(
			memory.offerLessonsForTask("Fix the GUI port typo in the changelog.", () => false),
			"",
		);
		strictEqual(
			memory.offerLessonsForTask(task, (id) => id === "mem-port"),
			"",
			"the section already carries it",
		);
		const offer = memory.offerLessonsForTask(task, () => false);
		match(offer, /^Memory: \[mem-port\] \(operator-approved\) The GUI demo box/u);
		strictEqual(offer.includes("mem-log"), false);
		deepStrictEqual(delivered, [], "producing the offer proves nothing");
		deepStrictEqual(
			memory.acknowledgeSubmission([`<system-reminder>\n${offer}\n</system-reminder>`]).map((o) => o.kind),
			["durable_lesson"],
		);
		deepStrictEqual(delivered, ["mem-port"]);
		strictEqual(
			memory.offerLessonsForTask(task, () => false),
			"",
			"once per session",
		);
	} finally {
		memory.dispose();
	}
});

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

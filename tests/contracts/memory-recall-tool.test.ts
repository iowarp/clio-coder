import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { CommandSegment } from "../../src/domains/memory/command-evidence.js";
import { recordMemoryObservations } from "../../src/domains/memory/guardian-gate.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { fileFixNote, writeAgentNote } from "../../src/domains/memory/notes.js";
import { canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { loadMemoryRecordsSync } from "../../src/domains/memory/store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createMemoryNoteTool } from "../../src/tools/memory-note.js";
import { createMemoryRecallTool } from "../../src/tools/memory-recall.js";
import { createRegistry } from "../../src/tools/registry.js";

function record(id: string, lesson: string, fields: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id,
		scope: "global",
		key: id,
		lesson,
		evidenceRefs: ["ev-1"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-10-01T00:00:00.000Z",
		approved: true,
		...fields,
	};
}

describe("memory_recall tool", () => {
	it("refuses with memory off and reads nothing", async () => {
		const recalled: unknown[] = [];
		const tool = createMemoryRecallTool({
			enabled: () => false,
			onRecall: (ids) => recalled.push(ids),
			bank: () => {
				throw new Error("the bank must not be read");
			},
			records: () => {
				throw new Error("the store must not be read");
			},
			eligibility: () => ({ activeRepository: null, activeRuntime: null, activeAgent: null }),
		});
		deepStrictEqual(await tool.run({ query: "tsup" }), { kind: "error", message: "memory_recall: memory is off" });
		deepStrictEqual(recalled, []);
	});

	it("returns matching bank entries and eligible approved records, never status or gated records", async () => {
		const bank = new TaskMemoryBank();
		bank.updateStatus("tsup build is half done");
		const knowledge = bank.saveKnowledge("tsup splitting needs the dynamic import table");
		bank.saveProcedural("unrelated note about colors");
		const repository = canonicalMemoryRepositoryIdentity(process.cwd());
		ok(repository);
		const records = [
			record("mem-global", "Run tsup with splitting enabled for the CLI."),
			record("mem-repo", "This repo builds tsup output into dist.", { scope: "repo", repository }),
			record("mem-other-repo", "Other repo tsup rule.", {
				scope: "repo",
				repository: { kind: "canonical-path", key: "/nonexistent/elsewhere" },
			}),
			record("mem-proposed", "Unapproved tsup lesson.", { approved: false }),
			record("mem-runtime", "tsup on llamacpp.", { scope: "runtime", runtime: { kind: "runtime", key: "llamacpp" } }),
			record("mem-agent", "tsup for the coder agent.", { scope: "agent", agent: { kind: "agent", key: "coder" } }),
		];
		const before = JSON.stringify(records);
		const tool = createMemoryRecallTool({
			bank: () => bank.snapshot(),
			records: () => records,
			eligibility: () => ({
				activeRepository: repository,
				activeRuntime: { kind: "runtime", key: "openai" },
				activeAgent: null,
			}),
		});
		const result = await tool.run({ query: "tsup build" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const ids = (result.details?.hits as Array<{ id: string }>).map((hit) => hit.id).sort();
		deepStrictEqual(ids, [knowledge.id, "mem-global", "mem-repo"].sort());
		ok(!result.output.includes("half done"));
		ok(result.output.includes("durable scope=repo"));
		strictEqual(JSON.stringify(records), before);
	});

	it("registers on the orchestrator registry behind the gateway and never on a worker registry", () => {
		const deps = { bank: () => null, records: () => [], eligibility: () => ({}) };
		const orchestrator = createRegistry({ safety: createWorkerSafety() });
		registerAllTools(orchestrator, { mcpCapabilities: false, memoryRecall: deps });
		const spec = orchestrator.get(ToolNames.MemoryRecall);
		ok(spec);
		strictEqual(spec.placement, "gateway");
		strictEqual(spec.baseActionClass, "read");
		const worker = createRegistry({ safety: createWorkerSafety() });
		registerCoreTools(worker, {});
		strictEqual(worker.get(ToolNames.MemoryRecall), undefined);
	});

	// MD6: the main agent writes notes whose evidence the host binds; rules pair only an option change; recall labels notes.
	it("binds memory_note evidence, pairs only an option change, and keeps an unbound note recall-only", async () => {
		const root = process.cwd();
		const repository = canonicalMemoryRepositoryIdentity(root);
		ok(repository);
		const dataDir = mkdtempSync(join(tmpdir(), "md6-notes-"));
		const pairs: Array<{ failed: CommandSegment; fixed: CommandSegment }> = [];
		const memory = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			workspaceRoot: () => root,
			onFixPair: (pair) => pairs.push(pair),
		});
		let call = 0;
		const after = (toolName: string, toolArgs: Record<string, unknown>, ok: boolean, actionClass: string, details = {}) =>
			memory.evaluate({
				hook: "after_tool",
				sessionId: "S",
				toolName,
				toolCallId: String(++call),
				toolArgs,
				metadata: { resultKind: ok ? "ok" : "error", actionClass },
				toolResultDetails: details,
			});
		const bash = (command: string, ok: boolean) =>
			after(
				"bash",
				{ command },
				ok,
				"execute",
				ok ? { outcome: "success", exitCode: 0 } : { outcome: "failure", exitCode: 1 },
			);
		const check = (flags: string) => `node scripts/md6-check.mjs${flags}`;
		try {
			memory.evaluate({ hook: "turn_start", sessionId: "S", text: "Fix the check." });
			bash(check(" --mode=a"), false);
			bash("git status --short", true);
			strictEqual(pairs.length, 0, "an unrelated success is no fix");
			bash("node scripts/md6-other.mjs --mode=a", true);
			strictEqual(pairs.length, 0, "another script is another command");
			bash(check(" --mode=b"), true);
			strictEqual(pairs.length, 0, "a different --flag=value selects another target: an operand change, not a fix");
			bash(check(" --help"), true);
			strictEqual(pairs.length, 0, "a help call is never the fix");
			bash(check(" -a -b"), false);
			bash(check(" -b -a"), true);
			strictEqual(pairs.length, 0, "the same options reordered are the same command");
			bash(check(""), false);
			after("edit", { path: "src/md6-fixture.ts" }, true, "write");
			bash(check(" --legacy"), true);
			strictEqual(pairs.length, 0, "an edit between the failure and the success voids the pair");
			bash(check(""), false);
			bash(check(" --legacy"), true);
			strictEqual(pairs.length, 1, "only an option was added");
			const [pair] = pairs;
			if (pair === undefined) throw new Error("no fix pair");
			deepStrictEqual(memory.noteEvidence({ note: "x", command: "pnpm lint" }), {
				refused:
					"`pnpm lint` has not succeeded from the workspace root in this session; run it first, or leave command out",
			});
			bash("ls", true);
			for (const command of ["ls", check(" --help")])
				ok("refused" in (memory.noteEvidence({ note: "x", command }) ?? {}), `${command} is no evidence`);
			ok("refused" in (memory.noteEvidence({ note: "x", path: "README.md" }) ?? {}), "an unread path binds nothing");
			// A read binds only the lines it showed, and a quote it never showed is refused, never replaced.
			const info = statSync(join(root, "README.md"));
			const shown = readFileSync(join(root, "README.md"), "utf8").split("\n").slice(0, 6);
			const line = shown.find((text) => text.trim().length >= 8 && !text.includes("`"))?.trim() ?? "";
			after("read", { path: "README.md" }, true, "read", {
				file: { bytes: info.size, mtimeMs: info.mtimeMs },
				readRange: { startLine: 1, endLine: 6, unit: "physical-lines", partialLine: false },
			});
			ok(
				"refused" in (memory.noteEvidence({ note: "Docs require `PORT = 9999` here.", path: "README.md" }) ?? {}),
				"a fabricated quote is refused",
			);
			deepStrictEqual(memory.noteEvidence({ note: `The readme opens with \`${line}\`.`, path: "README.md" }), {
				kind: "source",
				path: "README.md",
				quote: line.replace(/\s+/gu, " "),
			});
			const bound = memory.noteEvidence({ note: "x", command: "git status --short" });
			strictEqual(bound !== null && "kind" in bound ? bound.kind : null, "command");
			const fix = await fileFixNote(dataDir, { sessionId: "S", cwd: root, ...pair });
			// A secret in a condition is redacted as the lesson is, on the bound and the unbound path.
			const secret = `GITHUB_TOKEN=gh${"p_"}${"A1b2".repeat(9)}`;
			const unbound = await writeAgentNote(dataDir, {
				sessionId: "S",
				cwd: root,
				args: { note: "The md6 fixture check reads its mode from an equals-joined flag.", appliesWhen: secret },
				evidence: null,
			});
			strictEqual(unbound.evidence, "none");
			if (bound === null || !("kind" in bound)) throw new Error("no command evidence");
			await writeAgentNote(dataDir, {
				sessionId: "S",
				cwd: root,
				args: { note: "Check the tree before the md6 fixture.", appliesWhen: secret },
				evidence: bound,
			});
			// Two other sessions agreeing still promote nothing the host never bound.
			await recordMemoryObservations(dataDir, [
				{ memoryId: unbound.id, sessionId: "T", kind: "held" },
				{ memoryId: unbound.id, sessionId: "U", kind: "held" },
			]);
			const records = loadMemoryRecordsSync(dataDir);
			strictEqual(records.length, 3);
			ok(records.every((record) => !record.approved));
			ok(!JSON.stringify(records).includes(secret.slice(13)), "no condition keeps the token");
			ok(records.some((record) => record.id === fix && record.claim?.kind === "fix"));
			const recall = await createMemoryRecallTool({
				bank: () => null,
				records: () => records,
				eligibility: () => ({ activeRepository: repository, activeRuntime: null, activeAgent: null }),
			}).run({ query: "md6 fixture check mode flag" });
			strictEqual(recall.kind, "ok");
			if (recall.kind !== "ok") return;
			ok(recall.output.includes(`[${unbound.id}] durable scope=repo note, unverified, no evidence:`), recall.output);
			ok(recall.output.includes("note, unverified, a failed command and the success that fixed it"), recall.output);
			// Attached only when the session starts with `lessons: agent`; never on a worker.
			const note = {
				enabled: () => true,
				write: async () => ({ id: "mem-x", created: true, evidence: "none" as const, standing: "note" as const }),
			};
			const attached = createRegistry({ safety: createWorkerSafety() });
			registerAllTools(attached, { mcpCapabilities: false, memoryNote: note });
			strictEqual(attached.get(ToolNames.MemoryNote)?.placement, "direct");
			const withheld = createRegistry({ safety: createWorkerSafety() });
			registerAllTools(withheld, { mcpCapabilities: false });
			strictEqual(withheld.get(ToolNames.MemoryNote), undefined);
			const worker = createRegistry({ safety: createWorkerSafety() });
			registerCoreTools(worker, {});
			strictEqual(worker.get(ToolNames.MemoryNote), undefined);
			const off = await createMemoryNoteTool({ ...note, enabled: () => false }).run({ note: "x" });
			strictEqual(off.kind, "error");
		} finally {
			memory.dispose();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

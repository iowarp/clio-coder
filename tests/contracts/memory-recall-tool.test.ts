import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
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
});

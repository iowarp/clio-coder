import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { TASK_MEMORY_CONTENT_MAX_CHARS, TaskMemoryBank } from "../../src/domains/memory/task-bank.js";

function tickingClock(): () => Date {
	let tick = 0;
	return () => new Date(tick++ * 1_000);
}

describe("contracts/task memory bank", () => {
	it("supports status, knowledge, procedural, and delete operations with stable update ids", () => {
		const bank = new TaskMemoryBank({ now: tickingClock() });
		const status = bank.updateStatus("Inspecting\n the repository.");
		const updatedStatus = bank.updateStatus("Implementing WS0.");
		const knowledge = bank.saveKnowledge("Local imports end in .js.");
		const updatedKnowledge = bank.saveKnowledge("Local imports must end in .js.", { id: knowledge.id });
		const procedural = bank.saveProcedural("npm test failed because fixture X was absent.");

		strictEqual(updatedStatus.id, status.id);
		strictEqual(updatedKnowledge.id, knowledge.id);
		strictEqual(updatedKnowledge.createdAt, knowledge.createdAt);
		strictEqual(bank.deleteEntry(procedural.id), true);
		strictEqual(bank.deleteEntry(procedural.id), false);
		deepStrictEqual(bank.snapshot().procedural, []);
		strictEqual(bank.snapshot().status?.content, "Implementing WS0.");
	});

	it("enforces independent class caps and evicts the oldest untouched entry", () => {
		const bank = new TaskMemoryBank({ knowledgeCap: 2, proceduralCap: 1, now: tickingClock() });
		const oldKnowledge = bank.saveKnowledge("old knowledge");
		const keptKnowledge = bank.saveKnowledge("kept knowledge");
		bank.saveKnowledge("touch old knowledge", { id: oldKnowledge.id });
		const newestKnowledge = bank.saveKnowledge("newest knowledge");
		const oldProcedure = bank.saveProcedural("old procedure");
		const newestProcedure = bank.saveProcedural("newest procedure");
		const snapshot = bank.snapshot();

		deepStrictEqual(
			snapshot.knowledge.map((entry) => entry.id),
			[oldKnowledge.id, newestKnowledge.id],
		);
		ok(!snapshot.knowledge.some((entry) => entry.id === keptKnowledge.id));
		deepStrictEqual(
			snapshot.procedural.map((entry) => entry.id),
			[newestProcedure.id],
		);
		ok(!snapshot.procedural.some((entry) => entry.id === oldProcedure.id));
	});

	it("never renders status and keeps rendered output within its token budget", () => {
		const bank = new TaskMemoryBank({ now: tickingClock() });
		const status = bank.updateStatus("PRIVATE STATUS SENTINEL");
		const knowledge = bank.saveKnowledge("The project uses node:test.");
		bank.saveProcedural("The broad command failed; use the targeted contract test.");

		const rendered = bank.render(20);
		ok(Math.ceil(rendered.length / 4) <= 20);
		ok(!rendered.includes(status.id));
		ok(!rendered.includes("PRIVATE STATUS SENTINEL"));
		match(bank.render(100, ["knowledge"]), new RegExp(knowledge.id, "u"));
		ok(!bank.render(100, ["knowledge"]).includes("procedural:"));
		strictEqual(bank.render(0), "");
	});

	it("renders status only for a restored-state block, and knowledge with it", () => {
		const bank = new TaskMemoryBank({ now: tickingClock() });
		const status = bank.updateStatus("PRIVATE STATUS SENTINEL");
		const knowledge = bank.saveKnowledge("The project uses node:test.");
		const procedural = bank.saveProcedural("The broad command failed; use the targeted contract test.");

		const restored = bank.renderRestoredState(200);
		ok(restored.includes(status.id), restored);
		ok(restored.includes("PRIVATE STATUS SENTINEL"), restored);
		ok(restored.includes(knowledge.id), restored);
		ok(!restored.includes(procedural.id), restored);
		ok(Math.ceil(restored.length / 4) <= 200);

		// The status entry leads, because it is the progress model compaction destroyed.
		ok(restored.indexOf(status.id) < restored.indexOf(knowledge.id), restored);

		// The general render path is unchanged and still refuses status.
		ok(!bank.render(200).includes("PRIVATE STATUS SENTINEL"));
		strictEqual(bank.renderRestoredState(0), "");
		strictEqual(new TaskMemoryBank().renderRestoredState(200), "");
	});

	it("normalizes content to one bounded paragraph and counts attributed injections", () => {
		const bank = new TaskMemoryBank({ now: tickingClock() });
		const entry = bank.saveKnowledge(`  first line\n\n${"x".repeat(TASK_MEMORY_CONTENT_MAX_CHARS)}  `);
		strictEqual(entry.content.includes("\n"), false);
		strictEqual(entry.content.length, TASK_MEMORY_CONTENT_MAX_CHARS);

		bank.recordInjection([entry.id, entry.id, "tm-k-missing"]);
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 1);
	});

	it("returns detached snapshots and rejects cross-class or missing updates", () => {
		const bank = new TaskMemoryBank({ now: tickingClock() });
		const knowledge = bank.saveKnowledge("immutable snapshot value");
		const snapshot = bank.snapshot();
		const first = snapshot.knowledge[0];
		ok(first !== undefined);
		first.content = "mutated outside the bank";
		strictEqual(bank.snapshot().knowledge[0]?.content, "immutable snapshot value");

		throws(() => bank.saveProcedural("wrong class", { id: knowledge.id }), /task memory entry not found/u);
		throws(() => bank.saveKnowledge("missing", { id: "tm-k-missing" }), /task memory entry not found/u);
	});
});

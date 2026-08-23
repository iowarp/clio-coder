import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	renderTaskMemoryHandoffSnapshot,
	TaskMemoryBank,
	taskMemoryHandoffSnapshot,
} from "../../src/domains/memory/index.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("contracts/memory promotion CLI", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-memory-promotion-cli-");
	});

	afterEach(() => {
		scratch.cleanup();
	});

	function writeHandoff(): { path: string; knowledgeId: string; proceduralId: string } {
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		bank.updateStatus("PRIVATE STATUS SENTINEL");
		const knowledge = bank.saveKnowledge("Use token=super-secret-value only with the fixture.");
		const procedural = bank.saveProcedural("Run the focused contract before approval.");
		const path = join(scratch.dir, "handoff.md");
		writeFileSync(
			path,
			renderTaskMemoryHandoffSnapshot(
				taskMemoryHandoffSnapshot(bank.snapshot(), {
					sessionId: "session-cli-source",
					evidenceRefs: ["session-session-cli-source", "run-cli-source"],
					runtimeIds: ["openai"],
					agentIds: ["coder"],
				}),
			),
			"utf8",
		);
		return { path, knowledgeId: knowledge.id, proceduralId: procedural.id };
	}

	it("promotes one selected handoff entry for review and approves it separately", async () => {
		const handoff = writeHandoff();
		const repository = join(scratch.dir, "repository");
		mkdirSync(repository);
		const proposed = await runCli(
			[
				"memory",
				"promote",
				"--from-handoff",
				handoff.path,
				"--entry",
				handoff.knowledgeId,
				"--scope",
				"repo",
				"--repository",
				repository,
			],
			{ env: scratch.env },
		);
		strictEqual(proposed.code, 0, proposed.stderr);
		match(proposed.stdout, /status: proposed/u);
		match(proposed.stdout, new RegExp(`source-entry: ${handoff.knowledgeId}`, "u"));
		match(proposed.stdout, /source-session: session-cli-source/u);
		match(proposed.stdout, /redaction: 1 replacement; fields=knowledge\[0\]\.content/u);
		match(proposed.stdout, /review: clio-coder memory approve mem-[a-f0-9]{16}/u);
		strictEqual(proposed.stdout.includes("super-secret-value"), false);
		strictEqual(proposed.stdout.includes("PRIVATE STATUS SENTINEL"), false);

		const memoryId = /memory: (mem-[a-f0-9]{16})/u.exec(proposed.stdout)?.[1];
		ok(memoryId);
		const storePath = join(scratch.dir, "data", "memory", "records.json");
		const stored = readFileSync(storePath, "utf8");
		strictEqual(stored.includes("super-secret-value"), false);
		strictEqual(stored.includes('"approved": false'), true);

		const approved = await runCli(["memory", "approve", memoryId], { env: scratch.env });
		strictEqual(approved.code, 0, approved.stderr);
		match(approved.stdout, new RegExp(`approved ${memoryId}`, "u"));
		const listed = await runCli(["memory", "list"], { env: scratch.env });
		strictEqual(listed.code, 0, listed.stderr);
		match(listed.stdout, new RegExp(`${memoryId}\\s+approved`, "u"));
	});

	it("requires separate global acknowledgement and can promote the full public snapshot", async () => {
		const handoff = writeHandoff();
		const refused = await runCli(["memory", "promote", "--from-handoff", handoff.path, "--scope", "global"], {
			env: scratch.env,
		});
		strictEqual(refused.code, 2);
		match(refused.stderr, /global scope requires --acknowledge-global/u);

		const proposed = await runCli(
			["memory", "promote", "--from-handoff", handoff.path, "--scope", "global", "--acknowledge-global"],
			{ env: scratch.env },
		);
		strictEqual(proposed.code, 0, proposed.stderr);
		strictEqual((proposed.stdout.match(/^memory: mem-/gmu) ?? []).length, 2);
		ok(proposed.stdout.includes(`source-entry: ${handoff.knowledgeId}`));
		ok(proposed.stdout.includes(`source-entry: ${handoff.proceduralId}`));
		strictEqual(proposed.stdout.includes("PRIVATE STATUS SENTINEL"), false);
	});

	it("accepts only runtime and agent identities that match handoff provenance", async () => {
		const handoff = writeHandoff();
		const mismatch = await runCli(
			[
				"memory",
				"promote",
				"--from-handoff",
				handoff.path,
				"--entry",
				handoff.proceduralId,
				"--scope",
				"runtime",
				"--runtime",
				"anthropic",
			],
			{ env: scratch.env },
		);
		strictEqual(mismatch.code, 1);
		match(mismatch.stderr, /runtime identity 'anthropic' does not match the promotion source/u);

		const runtime = await runCli(
			[
				"memory",
				"promote",
				"--from-handoff",
				handoff.path,
				"--entry",
				handoff.proceduralId,
				"--scope",
				"runtime",
				"--runtime",
				"openai",
			],
			{ env: scratch.env },
		);
		strictEqual(runtime.code, 0, runtime.stderr);
		match(runtime.stdout, /runtime: openai/u);

		const agent = await runCli(
			[
				"memory",
				"promote",
				"--from-handoff",
				handoff.path,
				"--entry",
				handoff.proceduralId,
				"--scope",
				"agent",
				"--agent",
				"coder",
			],
			{ env: scratch.env },
		);
		strictEqual(agent.code, 0, agent.stderr);
		match(agent.stdout, /agent: coder/u);
	});
});

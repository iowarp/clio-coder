/**
 * `seedOpenAICompatToolOrchestrator` takes the saved autonomy level a test
 * wants. It once rewrote a top-level `autonomy:` line that a v2 settings file
 * does not have, so every test that seeded yolo ran at default without
 * noticing. This pins that the seeded level reaches the running session: the
 * compiled prompt and the sealed main-agent receipt both name it.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { readRunJournal } from "../harness/run-journal.js";

describe("tool-orchestrator seed", { concurrency: false }, () => {
	let fixture: OpenAICompatFixture;
	const scratches: HeadlessScratch[] = [];

	before(async () => {
		fixture = await startOpenAICompatFixture("ready");
	});

	after(async () => {
		await closeServer(fixture.server);
		for (const scratch of scratches) scratch.cleanup();
	});

	for (const level of ["default", "yolo"] as const) {
		it(`runs a headless turn at the seeded ${level} level`, async () => {
			const scratch = headlessScratch(`clio-coder-seed-${level}-`);
			scratches.push(scratch);
			seedOpenAICompatToolOrchestrator(scratch.configDir, fixture.url, level);
			const marker = `SEEDED_AUTONOMY_${level.toUpperCase()}`;
			const result = await runCli(["--no-context-files", "--no-skills", "run", "--json", marker], {
				env: scratch.env,
				cwd: scratch.root,
			});
			strictEqual(result.code, 0, result.stderr);

			const request = fixture.requests.find((entry) => JSON.stringify(entry.messages).includes(marker));
			ok(request, `no chat request carried ${marker}`);
			const first = (request.messages as Array<{ role?: string; content?: unknown }> | undefined)?.[0];
			match(typeof first?.content === "string" ? first.content : "", new RegExp(`Autonomy: ${level}\\.`, "u"));

			const receipt = readRunJournal(scratch.stateDir)?.receipts.find((entry) => entry.agentId === "main-agent");
			ok(receipt, "the headless turn sealed no main-agent receipt");
			strictEqual(receipt.autonomy, level);
		});
	}
});

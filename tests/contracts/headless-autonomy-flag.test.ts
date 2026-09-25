/**
 * `clio-coder run --autonomy` must reach the compiled prompt. The flag was
 * once keyed by the bare word in the session overrides, which wrote a
 * top-level key nothing reads, so a one-run raise in a home saved at the
 * lower level compiled and admitted at the saved level. Moved here from
 * tests/extended-smoke/cli-core.test.ts so CI guards it; the mock endpoint
 * needs no live model.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

describe("headless run --autonomy", { concurrency: false }, () => {
	let fixture: OpenAICompatFixture;
	let scratch: HeadlessScratch;

	before(async () => {
		fixture = await startOpenAICompatFixture("ready");
		scratch = headlessScratch("clio-coder-headless-autonomy-");
		seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
	});

	after(async () => {
		await closeServer(fixture.server);
		scratch.cleanup();
	});

	function systemPromptFor(marker: string): string {
		const request = fixture.requests.find((entry) => JSON.stringify(entry.messages).includes(marker));
		ok(request, `no chat request carried ${marker}`);
		const first = (request.messages as Array<{ role?: string; content?: unknown }> | undefined)?.[0];
		return first?.role === "system" && typeof first.content === "string" ? first.content : "";
	}

	it("compiles a headless run at the --autonomy level instead of the saved one", async () => {
		const saved = await runCli(["--no-context-files", "--no-skills", "run", "--json", "HEADLESS_AUTONOMY_SAVED"], {
			env: scratch.env,
			cwd: scratch.root,
		});
		strictEqual(saved.code, 0, saved.stderr);
		match(systemPromptFor("HEADLESS_AUTONOMY_SAVED"), /Autonomy: default\./u);

		const overridden = await runCli(
			["--no-context-files", "--no-skills", "run", "--autonomy", "yolo", "--json", "HEADLESS_AUTONOMY_FLAG"],
			{ env: scratch.env, cwd: scratch.root },
		);
		strictEqual(overridden.code, 0, overridden.stderr);
		match(systemPromptFor("HEADLESS_AUTONOMY_FLAG"), /Autonomy: yolo\./u);
	});
});

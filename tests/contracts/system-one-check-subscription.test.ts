import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSystemOneCommand } from "../../src/cli/system-one.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("check reaches a subscription route through a one-shot, so the only thing missing is the login", async (t) => {
	const home = await isolateClioEnv("clio-systemone-check-subscription-");
	t.after(() => home.restore());
	const configDir = join(home.dir, "config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "settings.yaml"),
		[
			"targets:",
			"  - id: anthropic-max",
			"    runtime: anthropic-max",
			"    defaultModel: claude-haiku-5-5",
			"chat:",
			"  target: anthropic-max",
			"  model: claude-haiku-5-5",
			"",
		].join("\n"),
	);
	const written: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});
	const code = await runSystemOneCommand(["check", "main", "--live"]);
	t.mock.restoreAll();
	strictEqual(code, 1);
	const said = written.join("");
	doesNotMatch(said, /no one-shot port/);
	match(said, /one-shot call failed/);
});

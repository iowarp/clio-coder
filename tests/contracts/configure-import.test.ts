import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseSetupFile, planImport, runConfigureImport } from "../../src/cli/configure-import.js";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const LAB = `notes: The lab gateway. Ask Ana for a key.
targets:
  - id: lab
    runtime: litellm
    url: https://llm.lab.example.edu
    defaultModel: qwen3-coder
    auth:
      apiKeyEnvVar: LAB_API_KEY
chat:
  target: lab
fleet:
  target: lab
`;

function capture() {
	const out = new PassThrough();
	let text = "";
	out.on("data", (chunk) => {
		text += String(chunk);
	});
	return { out, text: () => text };
}

test("a setup file accepts targets and defaults, and refuses a secret or a trust key by name", () => {
	registerBuiltinRuntimes(getRuntimeRegistry());
	const parsed = parseSetupFile(LAB);
	assert.ok(parsed.ok);
	assert.equal(parsed.file.targets[0]?.auth?.apiKeyEnvVar, "LAB_API_KEY");
	assert.deepEqual(parsed.file.chat, { target: "lab" });

	const refused = parseSetupFile(`targets:
  - id: lab
    runtime: litellm
    url: https://llm.lab.example.edu
    trustedUnmediated: true
    auth:
      apiKey: sk-inline
safety:
  yolo: true
`);
	assert.ok(!refused.ok);
	const errors = refused.errors.join("\n");
	for (const key of ["targets[0].auth.apiKey", "targets[0].trustedUnmediated", "safety"])
		assert.match(errors, new RegExp(key.replace(/[[\].]/g, "\\$&")));
});

test("importing adds the target and both defaults, re-importing is a no-op, and a different id is refused", async (t) => {
	const home = await isolateClioEnv("clio-import-");
	t.after(() => home.restore());
	delete process.env.LAB_API_KEY;
	initializeClioHome();
	registerBuiltinRuntimes(getRuntimeRegistry());
	const file = join(home.dir, "lab.yaml");
	writeFileSync(file, LAB);

	const first = capture();
	assert.equal(await runConfigureImport(file, { yes: true, replace: false, out: first.out }), 0);
	assert.match(first.text(), /prompts go to https:\/\/llm\.lab\.example\.edu/);
	assert.match(first.text(), /LAB_API_KEY/);
	const saved = readSettings();
	assert.equal(saved.targets.find((target) => target.id === "lab")?.runtime, "litellm");
	assert.equal(saved.chat.target, "lab");
	assert.equal(saved.chat.model, "qwen3-coder");
	assert.equal(saved.fleet.default.target, "lab");

	const again = capture();
	assert.equal(await runConfigureImport(file, { yes: true, replace: false, out: again.out }), 0);
	assert.match(again.text(), /already imported; nothing changed/);

	updateSettings((settings) => {
		const lab = settings.targets.find((target) => target.id === "lab");
		if (lab) lab.url = "https://other.example.edu";
	});
	const parsed = parseSetupFile(LAB);
	assert.ok(parsed.ok);
	assert.deepEqual(planImport(readSettings(), parsed.file, false).collisions, ["lab"]);
	assert.equal(await runConfigureImport(file, { yes: true, replace: false, out: capture().out }), 1);
	assert.equal(readSettings().targets.find((target) => target.id === "lab")?.url, "https://other.example.edu");
	assert.equal(await runConfigureImport(file, { yes: true, replace: true, out: capture().out }), 0);
	assert.equal(readSettings().targets.find((target) => target.id === "lab")?.url, "https://llm.lab.example.edu");

	// No terminal to answer and no --yes: the file is read and previewed, then refused with nothing written.
	updateSettings((settings) => {
		settings.targets = settings.targets.filter((target) => target.id !== "lab");
	});
	const unattended = capture();
	assert.equal(await runConfigureImport(file, { yes: false, replace: false, out: unattended.out }), 2);
	assert.match(unattended.text(), /prompts go to https:\/\/llm\.lab\.example\.edu/);
	assert.equal(
		readSettings().targets.some((target) => target.id === "lab"),
		false,
	);
	// A missing file says so (exit 1) rather than asking for --yes.
	assert.equal(
		await runConfigureImport(join(home.dir, "nope.yaml"), {
			yes: false,
			replace: false,
			out: capture().out,
		}),
		1,
	);
});

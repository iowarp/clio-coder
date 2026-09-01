import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { readSettings, settingsPath, updateSettings } from "../../src/core/config.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const ORIGINAL_ENV = { ...process.env };

const MINIMAL_FILE = `version: 2
targets:
  - id: target-a
    runtime: openai-compat
    url: http://localhost:1111
    defaultModel: model-a
chat:
  target: target-a
  model: model-a
`;

function seedMinimalFile(): string {
	writeFileSync(settingsPath(), MINIMAL_FILE, "utf8");
	return MINIMAL_FILE;
}

function addedLines(before: string, after: string): string[] {
	const previous = new Set(before.split("\n"));
	return after
		.split("\n")
		.filter((line) => line.trim().length > 0 && !previous.has(line))
		.map((line) => line.trim());
}

describe("contracts/settings-write-footprint", () => {
	let scratch = "";

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-settings-footprint-");
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
	});

	it("writes only the leaf a global save touched, adding no default-materialized keys", () => {
		const before = seedMinimalFile();

		updateSettings((settings) => {
			settings.interface.outputDetail = "verbose";
		});

		const after = readFileSync(settingsPath(), "utf8");
		deepStrictEqual(addedLines(before, after), ["interface:", "outputDetail: verbose"]);
		const doc = parseYaml(after) as Record<string, unknown>;
		deepStrictEqual(Object.keys(doc).sort(), ["chat", "interface", "targets", "version"]);
		// The two containers defaults materialize on load must not reach the file.
		ok(!after.includes("profiles:"), "workers.profiles leaked into the saved file");
		ok(!after.includes("agentProfiles:"), "fleet.agentProfiles leaked into the saved file");
		strictEqual(readSettings().interface.outputDetail, "verbose");
	});

	it("persists fullscreen preferences without materializing terminal defaults", () => {
		for (const testCase of [
			{ leaf: "mode", value: "fullscreen" },
			{ leaf: "fullscreenScrollbar", value: "always" },
			{ leaf: "smoothStreaming", value: "on" },
		] as const) {
			const before = seedMinimalFile();
			updateSettings((settings) => {
				if (testCase.leaf === "mode") settings.interface.mode = testCase.value;
				else if (testCase.leaf === "fullscreenScrollbar") settings.interface.fullscreenScrollbar = testCase.value;
				else settings.interface.smoothStreaming = testCase.value;
			});

			const after = readFileSync(settingsPath(), "utf8");
			deepStrictEqual(addedLines(before, after), ["interface:", `${testCase.leaf}: ${testCase.value}`]);
			const interfaceSettings = (parseYaml(after) as { interface: Record<string, unknown> }).interface;
			deepStrictEqual(interfaceSettings, { [testCase.leaf]: testCase.value });
			const loaded = readSettings().interface;
			strictEqual(loaded[testCase.leaf], testCase.value);
			strictEqual(loaded.terminalProgress, false);
			strictEqual(loaded.outputDetail, "default");
			strictEqual(loaded.mode, testCase.leaf === "mode" ? "fullscreen" : "regular");
			strictEqual(loaded.fullscreenScrollbar, testCase.leaf === "fullscreenScrollbar" ? "always" : "auto");
			strictEqual(loaded.smoothStreaming, testCase.leaf === "smoothStreaming" ? "on" : "off");
		}
	});

	it("leaves untouched saved keys byte-identical across repeated saves", () => {
		seedMinimalFile();
		updateSettings((settings) => {
			settings.chat.retry.maxRetries = 7;
		});
		const first = readFileSync(settingsPath(), "utf8");

		updateSettings((settings) => {
			settings.chat.retry.maxRetries = 7;
		});

		strictEqual(readFileSync(settingsPath(), "utf8"), first);
	});

	it("removes a map entry the mutation deleted", () => {
		seedMinimalFile();
		updateSettings((settings) => {
			settings.fleet.profiles = { fast: { target: "target-a", model: "model-a", thinkingLevel: "off" } };
		});
		ok(readFileSync(settingsPath(), "utf8").includes("fast:"));

		updateSettings((settings) => {
			settings.fleet.profiles = {};
		});

		const doc = parseYaml(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
		deepStrictEqual((doc.fleet as Record<string, unknown>).profiles, {});
		deepStrictEqual(readSettings().fleet.profiles, {});
	});
});

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildCustomizationGraph } from "../../src/cli/config-inspect.js";
import { updateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("config inspection includes effective safety limits for defaults and configured values", async () => {
	const scratch = await isolateClioEnv("clio-coder-inspect-limits-");
	try {
		const workspace = join(scratch.dir, "workspace");
		mkdirSync(workspace);
		const limits = () => buildCustomizationGraph(workspace).entries.find((entry) => entry.id === "safety.limits");
		const defaults = limits();
		ok(defaults);
		deepStrictEqual(defaults.detail, DEFAULT_SETTINGS.safety.limits);
		strictEqual(defaults.reloadClass, "next-turn");
		updateSettings((settings) => {
			settings.safety.limits.workerResponseSeconds = 321;
			return settings;
		});
		const configured = JSON.parse(JSON.stringify(limits()));
		strictEqual(configured.detail.workerResponseSeconds, 321);
		strictEqual(configured.detail.readBytesPerCall, DEFAULT_SETTINGS.safety.limits.readBytesPerCall);
	} finally {
		scratch.restore();
	}
});

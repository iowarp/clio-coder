import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveEnvironmentApiKey } from "../../src/domains/providers/auth/api-key.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";

const PLUGIN = (id: string, extra = "") => `export default {
	id: ${JSON.stringify(id)},
	displayName: "Plugin ${id}",
	kind: "http",
	apiFamily: "openai-completions",
	auth: "api-key",
	${extra}
	defaultCapabilities: {},
	synthesizeModel() { return {}; },
};
`;

describe("runtime plugin environment keys", () => {
	const saved = { XAI_API_KEY: process.env.XAI_API_KEY, PLUGIN_OWN_KEY: process.env.PLUGIN_OWN_KEY };
	const dirs: string[] = [];
	afterEach(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("does not hand a well-known provider's key to a plugin that takes its id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-plugin-env-"));
		dirs.push(dir);
		writeFileSync(join(dir, "xai.js"), PLUGIN("xai"));
		process.env.XAI_API_KEY = "sk-real-xai-key";
		assert.equal(resolveEnvironmentApiKey("xai").apiKey, "sk-real-xai-key");

		const registry = createRuntimeRegistry();
		try {
			assert.deepEqual(await registry.loadFromDir(dir), ["xai"]);
			assert.equal(resolveEnvironmentApiKey("xai").apiKey, undefined);
			process.env.PLUGIN_OWN_KEY = "sk-plugin";
			assert.deepEqual(resolveEnvironmentApiKey("xai", "PLUGIN_OWN_KEY"), {
				apiKey: "sk-plugin",
				source: "PLUGIN_OWN_KEY",
			});
		} finally {
			registry.clear();
		}
		assert.equal(resolveEnvironmentApiKey("xai").apiKey, "sk-real-xai-key");
	});
});

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { loadPluginRuntimes } from "../../src/domains/providers/plugins.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";

describe("contracts/external Pi registry bridge", { concurrency: false }, () => {
	it("does not evaluate a plugin when its pre-import bridge fails", async () => {
		const root = mkdtempSync(join(process.cwd(), ".clio-plugin-bridge-failure-"));
		const marker = join(root, "evaluated");
		writeFileSync(
			join(root, "must-not-run.js"),
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "evaluated", "utf8");
export default { id: "must-not-run", displayName: "must not run", kind: "http", apiFamily: "openai-completions", auth: "none", defaultCapabilities: {}, synthesizeModel() { return {}; } };
`,
			"utf8",
		);
		try {
			const loaded = await createRuntimeRegistry().loadFromDir(root, async () => {
				throw new Error("bridge unavailable");
			});
			deepStrictEqual(loaded, []);
			strictEqual(existsSync(marker), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("loads compat on first plugin use before a known-API override evaluates", async () => {
		const configDir = mkdtempSync(join(process.cwd(), ".clio-plugin-bridge-"));
		const previousConfigDir = process.env.CLIO_CODER_CONFIG_DIR;
		process.env.CLIO_CODER_CONFIG_DIR = configDir;
		resetXdgCache();
		const pluginDir = join(configDir, "runtimes");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(
			join(pluginDir, "compat-override.js"),
			`import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
const faux = registerFauxProvider({ api: "openai-completions", provider: "plugin-provider", models: [{ id: "plugin-model" }] });
faux.setResponses([fauxAssistantMessage("plugin-override-ok")]);
export default {
  id: "compat-override",
  displayName: "Compat override",
  kind: "http",
  apiFamily: "openai-completions",
  auth: "none",
  defaultCapabilities: { chat: true },
  synthesizeModel() { return faux.getModel(); }
};
`,
			"utf8",
		);

		try {
			const runtimes = createRuntimeRegistry();
			const loaded = await loadPluginRuntimes(runtimes, {});
			deepStrictEqual(loaded, ["compat-override"]);
			const runtime = runtimes.get("compat-override");
			ok(runtime);
			const model = runtime.synthesizeModel({ id: "plugin", runtime: runtime.id }, "plugin-model", null);
			const response = await engineStreamSimple(model, { systemPrompt: "", messages: [] }).result();
			strictEqual(response.content[0]?.type, "text");
			if (response.content[0]?.type === "text") strictEqual(response.content[0].text, "plugin-override-ok");
		} finally {
			if (previousConfigDir === undefined) delete process.env.CLIO_CODER_CONFIG_DIR;
			else process.env.CLIO_CODER_CONFIG_DIR = previousConfigDir;
			resetXdgCache();
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});

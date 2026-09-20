import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCustomizationGraph } from "../../../../src/cli/config-inspect.js";
import { initializeClioHome } from "../../../../src/core/init.js";
import { readLayeredSettings } from "../../../../src/core/settings-layers.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../../../src/core/workspace-trust.js";
import { openAuthStorage } from "../../../../src/domains/providers/auth/index.js";

const cwd = process.argv[2];
assert.ok(cwd);
const config = process.env.CLIO_CODER_CONFIG_DIR;
assert.ok(config);
initializeClioHome();
openAuthStorage().setApiKey("fixture-provider", "fixture-stored-credential-72bda09");
writeFileSync(
	join(config, "settings.yaml"),
	JSON.stringify({
		version: 2,
		targets: [
			{
				id: "fixture-target",
				runtime: "openai-compat",
				url: "http://127.0.0.1:9",
				auth: { headers: { "X-Fixture": "fixture-header-secret" } },
			},
		],
		chat: { target: "fixture-target", thinkingLevel: "high", model: "fixture-user-model" },
		integrations: {
			externalAgents: {
				entries: [
					{
						id: "fixture-external",
						command: "fixture-private-command",
						args: ["fixture-private-argument"],
						env: { API_KEY: "fixture-configured-environment-913ab" },
					},
				],
			},
		},
	}),
);
mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
writeFileSync(
	join(cwd, ".clio-coder/settings.yaml"),
	JSON.stringify({ chat: { model: "fixture-project-model" }, safety: { autonomy: "suggest" } }),
);
writeFileSync(join(cwd, ".clio-coder/settings.local.yaml"), JSON.stringify({ chat: { model: "fixture-local-model" } }));
writeFileSync(
	join(cwd, ".clio-coder/hooks.yaml"),
	JSON.stringify([
		{
			id: "fixture-hook",
			kind: "command",
			on: "before_tool",
			argv: ["fixture-hook-command", "fixture-hook-argument-private"],
		},
	]),
);
writeFileSync(join(cwd, "CLIO-CODER.md"), "# Fixture workspace\n\nKeep fixture work isolated.\n");
for (const surface of ["settings", "hooks"] as const) {
	const snapshot = captureProjectSurface(cwd, surface);
	assert.ok(snapshot.contentHash);
	recordProjectSurfaceTrust(cwd, surface, snapshot.contentHash);
}
const settings = readLayeredSettings(cwd);
assert.deepEqual(settings.issues, []);
function keys(value: unknown, prefix = ""): string[] {
	if (value && typeof value === "object" && Object.keys(value).length)
		return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
	return [prefix];
}
const graph = buildCustomizationGraph(cwd);
process.stdout.write(
	JSON.stringify({
		settingsKeys: keys(settings.settings).sort(),
		categories: [...new Set(graph.entries.map((entry) => entry.category))].sort(),
	}),
);

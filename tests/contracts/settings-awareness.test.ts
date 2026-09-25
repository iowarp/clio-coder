import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { settingsAwareness } from "../../src/core/settings-awareness.js";
import { createContextTool } from "../../src/tools/context/index.js";

test("settings awareness reports effective limits and UI links without serializing private configuration", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.limits.sessionCostUsd = 17;
	settings.targets = [
		{
			id: "local",
			runtime: "openai-compat",
			url: "https://PRIVATE_ENDPOINT",
			auth: { apiKeyEnvVar: "PRIVATE_CREDENTIAL" },
		},
	];
	settings.integrations.library.remote = "https://PRIVATE_REMOTE";
	settings.context.compaction.systemPrompt = "PRIVATE_PATH";
	settings.integrations.externalAgents.entries = [
		{ id: "custom", command: "PRIVATE_COMMAND", args: ["PRIVATE_ARG"], env: { TOKEN: "PRIVATE_TOKEN" } },
	];
	settings.interface.keybindings = { PRIVATE_BINDING: "PRIVATE_KEY" };
	const before = structuredClone(settings);
	const all = settingsAwareness(settings, "", 0, 200);
	const text = JSON.stringify(all);
	assert.doesNotMatch(text, /PRIVATE_/);
	assert.equal(all.limits.sessionCostUsd, 17);
	assert.match(all.note, /not remaining budgets/);
	assert.match(all.posture, /unknown provider prices/);
	assert.ok(
		all.rows.every((row) => row.tui.startsWith("/settings ") && row.cli.startsWith("clio-coder configure --section ")),
	);
	assert.deepEqual(settings, before);
	const page = settingsAwareness(settings, "safety", 0, 2);
	assert.equal(page.rows.length, 2);
	assert.equal(page.nextOffset, 2);
	assert.ok(
		settingsAwareness(settings, "safety", 2, 2).rows.every((row) => !page.rows.some((first) => first.path === row.path)),
	);
});

test("context reads the current snapshot each time and refuses to invent a worker's settings", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const tool = createContextTool({ getSettings: () => settings });
	const first = await tool.run({ scope: "settings", query: "autonomy" });
	assert.equal(first.kind, "ok");
	if (first.kind !== "ok") return;
	assert.match(first.output, /default/);
	settings.safety.autonomy = "yolo";
	const second = await tool.run({ scope: "settings", query: "autonomy" });
	assert.equal(second.kind, "ok");
	if (second.kind === "ok") assert.match(second.output, /"value": "yolo"/);
	for (const args of [{ offset: -1 }, { limit: 13 }, { offset: 0.5 }, { limit: 0 }]) {
		const result = await tool.run({ scope: "settings", ...args });
		assert.equal(result.kind, "error");
	}
	const missing = await createContextTool().run({ scope: "settings" });
	assert.equal(missing.kind, "error");
	if (missing.kind === "error") assert.match(missing.message, /do not infer current limits from defaults/);
});

test("broad fleet questions expose live routing in one lookup without disclosing target secrets", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "blade";
	settings.chat.model = "dynamo/chat";
	settings.fleet.default.target = "blade";
	settings.fleet.default.model = "mini/worker";
	settings.fleet.profiles.research = { target: "cloud", model: "research-model", thinkingLevel: "low" };
	settings.fleet.agentProfiles.researcher = "research";
	settings.targets = [
		{ id: "blade", runtime: "litellm", url: "https://PRIVATE_ENDPOINT", auth: { apiKeyEnvVar: "PRIVATE_KEY" } },
	];
	const tool = createContextTool({ getSettings: () => settings });
	const result = await tool.run({ scope: "settings", query: "fleet nodes targets models shadow agents dispatch" });
	assert.equal(result.kind, "ok");
	if (result.kind !== "ok") return;
	assert.match(result.output, /mini\/worker/);
	assert.match(result.output, /litellm/);
	assert.doesNotMatch(result.output, /PRIVATE_/);
	const snapshot = settingsAwareness(settings, "fleet nodes targets models shadow agents dispatch");
	assert.ok(snapshot.rows.length > 0);
	assert.equal(snapshot.routing.fleetDefault.model, "mini/worker");
	assert.equal(snapshot.routing.agentProfiles.researcher, "research");
	assert.equal(snapshot.routing.profiles.research?.model, "research-model");
	settings.fleet.default.model = "changed-live";
	assert.equal(settingsAwareness(settings, "unmatched-query").routing.fleetDefault.model, "changed-live");
	settings.fleet.default.model = null;
	assert.equal(settingsAwareness(settings).routing.fleetDefault.model, null);
});

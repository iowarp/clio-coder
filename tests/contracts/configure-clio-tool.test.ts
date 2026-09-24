import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createConfigureClioTool } from "../../src/tools/configure-clio.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("configure_clio previews an exact change and commits only after the host selects Apply", async (t) => {
	const env = await isolateClioEnv("clio-configure-preview-");
	t.after(() => env.restore());
	let asked = 0;
	const tool = createConfigureClioTool({
		getAutonomy: () => "full-auto",
		askUser: async (questions) => {
			asked += 1;
			match(questions[0]?.question ?? "", /safety\.autonomy: auto-edit → full-auto/);
			return { answers: [{ question: questions[0]?.question ?? "", answer: "Apply", options: ["Apply"] }] };
		},
	});
	strictEqual(tool.name, ToolNames.ConfigureClio);
	const preview = await tool.run({ action: "preview", path: "safety.autonomy", value: "yolo" });
	strictEqual(preview.kind, "ok");
	strictEqual(readSettings().safety.autonomy, "auto-edit");
	strictEqual(asked, 0);
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	if (!proposalId) throw new Error("preview omitted proposal id");
	const applied = await tool.run({ action: "apply", proposalId });
	strictEqual(applied.kind, "ok");
	strictEqual(asked, 1);
	strictEqual(readSettings().safety.autonomy, "full-auto");
	const replay = await tool.run({ action: "apply", proposalId });
	strictEqual(replay.kind, "error");
});

test("configure_clio rejects stale proposals, cancellation, sensitive paths and supervised modes", async (t) => {
	const env = await isolateClioEnv("clio-configure-refusal-");
	t.after(() => env.restore());
	let asked = 0;
	const tool = createConfigureClioTool({
		getAutonomy: () => "full-auto",
		askUser: async (questions) => {
			asked += 1;
			return { answers: [{ question: questions[0]?.question ?? "", answer: "Cancel", options: ["Cancel"] }] };
		},
	});
	strictEqual((await tool.run({ action: "preview", path: "targets", value: "[]" })).kind, "error");
	const preview = await tool.run({ action: "preview", path: "safety.autonomy", value: "full-auto" });
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	if (!proposalId) throw new Error("preview omitted proposal id");
	updateSettings((settings) => {
		settings.safety.autonomy = "read-only";
		return settings;
	});
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "error");
	strictEqual(asked, 0);
	const next = await tool.run({ action: "preview", path: "safety.autonomy", value: "full-auto" });
	const nextId = /proposalId="([^"]+)"/.exec(next.kind === "ok" ? next.output : "")?.[1];
	if (!nextId) throw new Error("second preview omitted proposal id");
	const canceled = await tool.run({ action: "apply", proposalId: nextId });
	strictEqual(canceled.kind, "ok");
	strictEqual(readSettings().safety.autonomy, "read-only");
	for (const level of ["suggest", "read-only"] as const) {
		const supervised = createConfigureClioTool({ getAutonomy: () => level, askUser: async () => ({ answers: [] }) });
		strictEqual((await supervised.run({ action: "preview", path: "chat.thinkingLevel", value: "high" })).kind, "error");
	}
});

test("configure_clio previews at capable autonomy but never raises autonomy from there", async (t) => {
	const env = await isolateClioEnv("clio-configure-capable-");
	t.after(() => env.restore());
	updateSettings((settings) => {
		settings.safety.autonomy = "auto-edit";
		return settings;
	});
	const capable = createConfigureClioTool({ getAutonomy: () => "auto-edit", askUser: async () => ({ answers: [] }) });
	strictEqual((await capable.run({ action: "preview", path: "chat.thinkingLevel", value: "high" })).kind, "ok");
	strictEqual((await capable.run({ action: "preview", path: "safety.autonomy", value: "suggest" })).kind, "ok");
	const raised = await capable.run({ action: "preview", path: "safety.autonomy", value: "full-auto" });
	strictEqual(raised.kind, "error");
	ok(raised.kind === "error" && /raise/.test(raised.message), JSON.stringify(raised));
});

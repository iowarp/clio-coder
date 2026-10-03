import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createConfigureClioTool } from "../../src/tools/configure-clio.js";
import { createRegistry, type RegistryVerdict } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function yoloRegistry(cwd: string) {
	return createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "yolo" });
}

async function settledWithin(verdict: Promise<RegistryVerdict>, ms: number): Promise<RegistryVerdict | "pending"> {
	let timer: NodeJS.Timeout | undefined;
	const pending = new Promise<"pending">((resolve) => {
		timer = setTimeout(() => resolve("pending"), ms);
	});
	try {
		return await Promise.race([verdict, pending]);
	} finally {
		clearTimeout(timer);
	}
}

function proposalOf(verdict: RegistryVerdict): string {
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	const id = /proposalId="([^"]+)"/.exec(output)?.[1];
	if (!id) throw new Error(`preview omitted proposal id: ${JSON.stringify(verdict)}`);
	return id;
}

test("configure_clio previews an exact change and yolo applies without another prompt", async (t) => {
	const env = await isolateClioEnv("clio-configure-preview-");
	t.after(() => env.restore());
	let asked = 0;
	const tool = createConfigureClioTool({
		getAutonomy: () => "yolo",
		askUser: async (questions) => {
			asked += 1;
			match(questions[0]?.question ?? "", /chat\.thinkingLevel: low → high/);
			return { answers: [{ question: questions[0]?.question ?? "", answer: "Apply", options: ["Apply"] }] };
		},
	});
	strictEqual(tool.name, ToolNames.ConfigureClio);
	const preview = await tool.run({ action: "preview", path: "chat.thinkingLevel", value: "high" });
	strictEqual(preview.kind, "ok");
	strictEqual(readSettings().chat.thinkingLevel, "low");
	strictEqual(asked, 0);
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	if (!proposalId) throw new Error("preview omitted proposal id");
	const applied = await tool.run({ action: "apply", proposalId });
	strictEqual(applied.kind, "ok");
	match(applied.kind === "ok" ? applied.output : "", /Exit and start a new Clio session/);
	strictEqual(asked, 0);
	strictEqual(readSettings().chat.thinkingLevel, "high");
	const replay = await tool.run({ action: "apply", proposalId });
	strictEqual(replay.kind, "error");
});

test("configure_clio rejects stale proposals, cancellation, sensitive paths and supervised modes", async (t) => {
	const env = await isolateClioEnv("clio-configure-refusal-");
	t.after(() => env.restore());
	let asked = 0;
	const tool = createConfigureClioTool({
		getAutonomy: () => "yolo",
		askUser: async (questions) => {
			asked += 1;
			return { answers: [{ question: questions[0]?.question ?? "", answer: "Cancel", options: ["Cancel"] }] };
		},
	});
	strictEqual((await tool.run({ action: "preview", path: "targets", value: "[]" })).kind, "error");
	const preview = await tool.run({ action: "preview", path: "chat.thinkingLevel", value: "high" });
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	if (!proposalId) throw new Error("preview omitted proposal id");
	updateSettings((settings) => {
		settings.chat.thinkingLevel = "high";
		return settings;
	});
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "error");
	strictEqual(asked, 0);
	const supervised = createConfigureClioTool({
		getAutonomy: () => "default",
		askUser: async (questions) => {
			asked += 1;
			return { answers: [{ question: questions[0]?.question ?? "", answer: "Cancel", options: ["Cancel"] }] };
		},
	});
	const next = await supervised.run({ action: "preview", path: "chat.thinkingLevel", value: "medium" });
	const nextId = /proposalId="([^"]+)"/.exec(next.kind === "ok" ? next.output : "")?.[1];
	if (!nextId) throw new Error("second preview omitted proposal id");
	const canceled = await supervised.run({ action: "apply", proposalId: nextId });
	strictEqual(canceled.kind, "ok");
	strictEqual(readSettings().chat.thinkingLevel, "high");
	strictEqual(asked, 1);
});

test("configure_clio refuses autonomy at both levels, including padded values and apply", async (t) => {
	const env = await isolateClioEnv("clio-configure-autonomy-refusal-");
	t.after(() => env.restore());
	for (const level of ["default", "yolo"] as const) {
		const tool = createConfigureClioTool({ getAutonomy: () => level, askUser: async () => ({ answers: [] }) });
		for (const value of ["default", "yolo", " yolo "]) {
			const refusal = await tool.run({ action: "preview", path: "safety.autonomy", value });
			strictEqual(refusal.kind, "error");
			ok(
				refusal.kind === "error" &&
					/autonomy.*operator.*\/settings.*clio-coder configure.*--autonomy/u.test(refusal.message),
			);
		}
		const apply = await tool.run({ action: "apply", path: "safety.autonomy", value: "yolo", proposalId: "unknown" });
		strictEqual(apply.kind, "error");
		ok(apply.kind === "error" && /autonomy.*operator/u.test(apply.message));
	}
	strictEqual(readSettings().safety.autonomy, "default");
});

test("configure_clio reports effect timing for live fleet settings and restart settings", async (t) => {
	const env = await isolateClioEnv("clio-configure-effect-");
	t.after(() => env.restore());
	const tool = createConfigureClioTool({ getAutonomy: () => "yolo", askUser: async () => ({ answers: [] }) });
	for (const [path, value, expected] of [
		["fleet.limits.toolCallsPerRun", "7", /next request or dispatch/],
		["fleet.concurrency", "3", /Exit and start a new Clio session/],
	] as const) {
		const preview = await tool.run({ action: "preview", path, value });
		const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
		ok(proposalId, JSON.stringify(preview));
		const result = await tool.run({ action: "apply", proposalId });
		match(result.kind === "ok" ? result.output : "", expected);
	}
});

test("configure_clio Apply cards show sanitized changed leaves without unchanged maps", async (t) => {
	const env = await isolateClioEnv("clio-configure-card-");
	t.after(() => env.restore());
	updateSettings((settings) => {
		settings.targets = [{ id: "openai-codex", runtime: "openai-codex", defaultModel: "gpt-6-sol" }];
		settings.fleet.profiles = Object.fromEntries(
			["old", "keep", "fast-sol"].map((name) => [
				name,
				{ target: settings.targets[0]?.id ?? "openai-codex", model: "gpt-6-sol", thinkingLevel: "low" },
			]),
		);
		settings.fleet.agentProfiles = { coder: "old", verifier: "keep" };
		return settings;
	});
	const tool = createConfigureClioTool({ getAutonomy: () => "default", askUser: async () => ({ answers: [] }) });
	const preview = await tool.run({
		action: "preview",
		path: "fleet.agentProfiles",
		value: JSON.stringify({ coder: "fast-sol", verifier: "keep" }),
	});
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	ok(proposalId, JSON.stringify(preview));
	// Fleet routing is approved on the registry's confirmation rail, so the card is its detail.
	const card = tool.confirmationFor?.({ action: "apply", proposalId })?.detail ?? "";
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "ok");
	match(card, /fleet.agentProfiles.coder: old → fast-sol/);
	ok(!card.includes("verifier"));
	ok(!card.includes("{"));
	const escaped = await tool.run({
		action: "preview",
		path: "fleet.agentProfiles",
		value: JSON.stringify({ "coder\u001b[31m\nspoof": "fast-sol" }),
	});
	ok(escaped.kind === "ok", JSON.stringify(escaped));
	ok(!escaped.output.includes("\u001b"));
	ok(!escaped.output.includes("\nspoof"));
	const large = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`agent${i}${"x".repeat(160)}`, "fast-sol"]));
	const bounded = await tool.run({ action: "preview", path: "fleet.agentProfiles", value: JSON.stringify(large) });
	ok(bounded.kind === "ok", JSON.stringify(bounded));
	match(bounded.output, /more changed values/);
	ok(bounded.output.length < 3600);
});

test("configure_clio fleet routing apply parks for the operator at yolo while its preview stays free", async (t) => {
	const env = await isolateClioEnv("clio-configure-routing-yolo-");
	t.after(() => env.restore());
	updateSettings((settings) => {
		settings.targets = [{ id: "openai-codex", runtime: "openai-codex", defaultModel: "gpt-6-sol" }];
		settings.fleet.profiles = { fast: { target: "openai-codex", model: "gpt-6-sol", thinkingLevel: "low" } };
		return settings;
	});
	const registry = yoloRegistry(env.dir);
	registry.register(createConfigureClioTool({ getAutonomy: () => "yolo", askUser: async () => ({ answers: [] }) }));
	const asked: Array<{ actionClass: ActionClass; requestId: string; detail: string }> = [];
	registry.onPermissionRequired((_call, decision, meta) => {
		asked.push({
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			detail: decision.kind === "ask" ? decision.rejection.detail : "",
		});
	});
	const routingPreview = await registry.invoke({
		tool: ToolNames.ConfigureClio,
		args: { action: "preview", path: "fleet.agentProfiles", value: JSON.stringify({ coder: "fast" }) },
	});
	strictEqual(asked.length, 0, "previews stay free");
	const proposalId = proposalOf(routingPreview);
	const previewText =
		routingPreview.kind === "ok" && routingPreview.result.kind === "ok" ? routingPreview.result.output : "";
	match(previewText, /per-call target and model/);
	const apply = registry.invoke({ tool: ToolNames.ConfigureClio, args: { action: "apply", proposalId } });
	strictEqual(await settledWithin(apply, 50), "pending");
	strictEqual(asked.length, 1);
	match(asked[0]?.detail ?? "", /fleet\.agentProfiles\.coder: fast/);
	strictEqual(readSettings().fleet.agentProfiles?.coder, undefined);
	await registry.resumeParkedCalls({
		actionClass: asked[0]?.actionClass as ActionClass,
		requestId: asked[0]?.requestId as string,
		requestedBy: "contract-operator",
	});
	const settled = await apply;
	strictEqual(settled.kind, "ok", JSON.stringify(settled));
	strictEqual(readSettings().fleet.agentProfiles?.coder, "fast");
});

test("a headless edit of project routing settings is refused with the dispatch pin hint", async (t) => {
	const env = await isolateClioEnv("clio-configure-routing-headless-");
	const previousCwd = process.cwd();
	const workspace = join(env.dir, "ws");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	process.chdir(workspace);
	t.after(() => {
		process.chdir(previousCwd);
		env.restore();
	});
	const registry = yoloRegistry(workspace);
	registry.register(writeTool);
	registry.onPermissionRequired(() => registry.cancelParkedCalls(HEADLESS_PERMISSION_DENIED_REASON));
	const local = join(workspace, ".clio-coder", "settings.local.yaml");
	writeFileSync(local, "fleet: {}\n");
	const verdict = await registry.invoke({
		tool: ToolNames.Write,
		args: { path: ".clio-coder/settings.local.yaml", content: "fleet:\n  agentProfiles:\n    coder: fast\n" },
	});
	strictEqual(verdict.kind, "blocked");
	const text = verdict.kind === "blocked" && verdict.decision.kind !== "allow" ? verdict.decision.rejection.detail : "";
	match(text, /project-settings-confirm/);
	match(text, /dispatch's per-call target and model/);
	strictEqual(readFileSync(local, "utf8"), "fleet: {}\n");
	ok(!existsSync(join(workspace, ".clio-coder", "settings.yaml")));
});

test("a non-routing configure_clio apply at yolo still saves without a prompt", async (t) => {
	const env = await isolateClioEnv("clio-configure-nonrouting-yolo-");
	t.after(() => env.restore());
	const registry = yoloRegistry(env.dir);
	registry.register(createConfigureClioTool({ getAutonomy: () => "yolo", askUser: async () => ({ answers: [] }) }));
	let asked = 0;
	registry.onPermissionRequired(() => {
		asked += 1;
	});
	const preview = await registry.invoke({
		tool: ToolNames.ConfigureClio,
		args: { action: "preview", path: "chat.thinkingLevel", value: "high" },
	});
	const applied = await registry.invoke({
		tool: ToolNames.ConfigureClio,
		args: { action: "apply", proposalId: proposalOf(preview) },
	});
	strictEqual(applied.kind, "ok", JSON.stringify(applied));
	strictEqual(asked, 0);
	strictEqual(readSettings().chat.thinkingLevel, "high");
});

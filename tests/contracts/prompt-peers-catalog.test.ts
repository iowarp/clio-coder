import { ok } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { it, type TestContext } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { InteropContract } from "../../src/domains/interop/contract.js";
import type { InteropAgentRecord } from "../../src/domains/interop/types.js";
import type { SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const claude = (binary: string | undefined): InteropAgentRecord => ({
	kind: "claude-code",
	presence: binary ? "present" : "absent",
	...(binary ? { binary } : {}),
	skillCount: 0,
	projectArtifacts: 0,
	fingerprint: "fixture",
});

async function compileWith(t: TestContext, record: InteropAgentRecord, tools: ReadonlyArray<string>) {
	const env = await isolateClioEnv("clio-peers-catalog-");
	t.after(() => env.restore());
	const cwd = path.join(env.dir, "repo");
	mkdirSync(cwd);
	const interop = {
		lastReport: () => ({ version: 1, detectedAt: "2026-01-01T00:00:00Z", agents: [record] }),
		configured: () => [],
	} as unknown as InteropContract;
	const context = {
		bus: createTelemetryHub(),
		getContract: (name: string) => (name === "interop" ? interop : undefined),
	} as unknown as DomainContext;
	const bundle = createPromptsBundle(context);
	await bundle.extension.start();
	t.after(() => bundle.extension.stop?.());
	const sessionInputs: SessionPromptInputs = {
		coordinatorCapabilities: [...tools],
		toolNames: [...tools],
		providerSupportsTools: true,
		promptProfile: "v2",
	};
	return (await bundle.contract.compileSessionPrompt({ sessionId: "peers", cwd, autonomy: "default", sessionInputs }))
		.systemPrompt;
}

const handoff = 'claude-code: panes(action="handoff", peer="claude-code")';
const row = "Another installed agent (see Peers in Catalogs)";

it("lists an installed peer and the harness row when a pane host can reach it", async (t) => {
	const prompt = await compileWith(t, claude("/usr/bin/claude"), ["panes", "dispatch"]);
	ok(prompt.includes("Peers ("), prompt.slice(prompt.indexOf("# Catalogs")));
	ok(prompt.includes(handoff), "reach line");
	ok(prompt.includes(row), "harness row");
});

for (const [why, record, tools] of [
	["no pane host", claude("/usr/bin/claude"), ["dispatch"]],
	["no installed CLI", claude(undefined), ["panes", "dispatch"]],
] as const) {
	it(`names no peer when no mode is ready: ${why}`, async (t) => {
		const prompt = await compileWith(t, record, tools);
		ok(!prompt.includes("Peers ("), "no Peers group");
		ok(!prompt.includes(row), "no harness row");
	});
}

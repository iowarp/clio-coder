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

const agentSpecs = [
	{ id: "coder", audience: "base", description: "Implements bounded code changes." },
	{ id: "scout", audience: "shadow", capabilityClass: "read-only", description: "Reconnaissance and code review." },
];

/** One bundle per test: a second isolateClioEnv inside the same test waits on the first. */
async function promptCompiler(t: TestContext, record: InteropAgentRecord, tools: ReadonlyArray<string>) {
	const env = await isolateClioEnv("clio-peers-catalog-");
	t.after(() => env.restore());
	const cwd = path.join(env.dir, "repo");
	mkdirSync(cwd);
	const interop = {
		lastReport: () => ({ version: 1, detectedAt: "2026-01-01T00:00:00Z", agents: [record] }),
		configured: () => [],
	} as unknown as InteropContract;
	const agents = { listSpecs: () => agentSpecs };
	const context = {
		bus: createTelemetryHub(),
		getContract: (name: string) => (name === "interop" ? interop : name === "agents" ? agents : undefined),
	} as unknown as DomainContext;
	const bundle = createPromptsBundle(context);
	await bundle.extension.start();
	t.after(() => bundle.extension.stop?.());
	return async (contextWindow?: number) => {
		const sessionInputs: SessionPromptInputs = {
			coordinatorCapabilities: [...tools],
			toolNames: [...tools],
			providerSupportsTools: true,
			promptProfile: "v2",
			...(contextWindow !== undefined ? { contextWindow } : {}),
		};
		return (await bundle.contract.compileSessionPrompt({ sessionId: "peers", cwd, autonomy: "default", sessionInputs }))
			.systemPrompt;
	};
}

async function compileWith(t: TestContext, record: InteropAgentRecord, tools: ReadonlyArray<string>) {
	return (await promptCompiler(t, record, tools))();
}

const handoff = 'claude-code: panes(action="handoff", peer="claude-code")';
const row = "Another installed agent (see Peers in Catalogs)";

it("lists an installed peer and the harness row when a pane host can reach it", async (t) => {
	const prompt = await compileWith(t, claude("/usr/bin/claude"), ["panes", "dispatch"]);
	ok(prompt.includes("Peers ("), prompt.slice(prompt.indexOf("# Catalogs")));
	ok(prompt.includes(handoff), "reach line");
	ok(prompt.includes(row), "harness row");
});

it("lists catalog names without purposes under a 48k window, keeping agent markers (S-87)", async (t) => {
	const compile = await promptCompiler(t, claude(undefined), ["dispatch"]);
	const full = await compile(200_000);
	const compact = await compile(32_768);
	ok(full.includes("- coder: Implements") && full.includes("- scout: (shadow, read-only) Recon"), full);
	const catalog = compact.slice(compact.indexOf("# Catalogs"));
	ok(catalog.includes("\n- coder\n") && !catalog.includes("Implements"), catalog);
	ok(catalog.includes("\n- scout (shadow, read-only)\n"), catalog);
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

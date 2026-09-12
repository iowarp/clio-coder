import { ok, rejects, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ContextContract } from "../../src/domains/context/contract.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const prose = "Keep the numerical tolerance unchanged.  \r\n\r\nRun the focused tests after editing.\r\n";

for (const scenario of [
	{ agentId: "coder", tier: "bounded", acp: false },
	{ agentId: "scout", tier: "none", acp: false },
	{ agentId: "external-fixture", tier: "bounded", acp: true },
	{ agentId: "external-fixture", tier: "none", acp: true },
] as const) {
	test(`dispatch delivers authored prose: ${scenario.agentId} ${scenario.tier}`, async () => {
		const env = await isolateClioEnv("clio-coder-worker-handbook-");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.integrations.externalAgents.entries = [
			{
				id: "external-fixture",
				command: "unused-fixture",
				args: [],
				...(scenario.tier === "bounded" ? { projectContext: "bounded" as const } : {}),
			},
		];
		const base = dispatchStubContext({ settings });
		let reads = 0;
		let delivered: ReadonlyArray<{ body: string }> = [];
		const context: Pick<ContextContract, "renderPromptContext" | "projectStructuredContext"> = {
			renderPromptContext(cwd) {
				reads++;
				return renderPromptContext(cwd);
			},
			projectStructuredContext() {
				throw new Error("must use captured authored source");
			},
		};
		const bundle = makeDispatchBundle(
			{
				bus: base.bus,
				getContract: ((name: string) => (name === "context" ? context : base.getContract(name))) as typeof base.getContract,
			},
			{
				spawnWorker(spec) {
					delivered = spec.dynamicPromptMessages ?? [];
					throw new Error("captured prompt");
				},
				startAcpDelegationRun(input) {
					delivered = input.dynamicPromptMessages ?? [];
					throw new Error("captured prompt");
				},
			},
		);
		try {
			writeFileSync(join(env.dir, "CLIO-CODER.md"), prose);
			strictEqual(renderPromptContext(env.dir).clioMd, null);
			await bundle.extension.start();
			await rejects(
				bundle.contract.dispatch({
					agentId: scenario.agentId,
					task: "Inspect the fixture.",
					executionRole: "researcher",
					requestOrigin: "internal",
					cwd: env.dir,
				}),
				/captured prompt/,
			);
			strictEqual(reads > 0, scenario.tier === "bounded");
			strictEqual(
				delivered.some(({ body }) => body.includes(prose)),
				scenario.tier === "bounded",
			);
		} finally {
			await bundle.extension.stop?.();
			env.restore();
		}
	});
}

test("worker authored prefixes retain safe text, disclose omissions, and honor read capability", async () => {
	const env = await isolateClioEnv("clio-coder-worker-prefix-");
	try {
		const path = join(env.dir, "CLIO-CODER.md");
		writeFileSync(path, prose + "Rule sentence.\n\n".repeat(500));
		const projectPrompt = renderPromptContext(env.dir);
		for (const [projectReadTools, projectExternalReadTools] of [
			[true, false],
			[false, false],
			[null, false],
			[null, true],
		] as const) {
			const messages = buildDynamicPromptMessages(
				{ agentId: "coder", task: "Inspect.", executionRole: "researcher" },
				{
					projectContextTier: "bounded",
					projectPrompt,
					projectReadTools,
					projectExternalReadTools,
				},
			);
			const message = messages.find(({ id }) => id === "dispatch-project-context");
			ok(message);
			ok(message.body.length <= 1500);
			ok(message.body.includes(prose));
			ok(message.body.includes(path));
			ok(/omitted physical lines \d+-\d+ \(budget\)/.test(message.body));
			strictEqual(message.contentHash, sha256(message.body));
			strictEqual(message.body.includes("read({path:"), projectReadTools !== false && !projectExternalReadTools);
			strictEqual(message.body.includes("External read tools are unknown"), projectExternalReadTools);
			strictEqual(message.body.includes("If tools are available"), projectReadTools === null && !projectExternalReadTools);
			strictEqual(message.body.includes("cannot be recovered with tools"), projectReadTools === false);
		}
	} finally {
		env.restore();
	}
});

test("derived verification remains gated while authored verification prose is unchanged", async () => {
	const env = await isolateClioEnv("clio-coder-worker-verification-");
	try {
		const authored =
			"## Verification expectations\n\nRun focused tests.\n\nVerification expectations:\nKeep this authored line.\n";
		writeFileSync(join(env.dir, "CLIO-CODER.md"), authored);
		const projectPrompt = renderPromptContext(env.dir);
		const project = {
			projectName: "Fixture",
			conventions: ["Derived convention"],
			invariants: [],
			verificationExpectations: "DERIVED CHECK",
		};
		for (const capabilityClass of ["workspace-edit", "verification"] as const) {
			const context = { projectContextTier: "bounded" as const, capabilityClass, project };
			const request = { agentId: "coder", task: "Inspect.", executionRole: "researcher" as const };
			const legacy = buildDynamicPromptMessages(request, context);
			strictEqual(legacy[0]?.body.includes("DERIVED CHECK"), capabilityClass === "verification");
			const raw = buildDynamicPromptMessages(request, { ...context, projectPrompt });
			ok(raw[0]?.body.includes(authored));
			strictEqual(raw[0]?.body.includes("Derived convention"), false);
			strictEqual(raw[0]?.body.includes("DERIVED CHECK"), false);
		}
	} finally {
		env.restore();
	}
});

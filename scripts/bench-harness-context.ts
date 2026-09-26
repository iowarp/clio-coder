/** Controlled harness-only context footprint; no project, history, provider or model inference. */

import type { ToolName } from "../src/core/tool-names.js";
import { renderFleetPromptSection } from "../src/domains/agents/catalog.js";
import type { AgentsContract } from "../src/domains/agents/contract.js";
import { compile } from "../src/domains/prompts/compiler.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";
import { createWorkerSafety } from "../src/engine/worker-tools.js";
import { resolveAgentTools } from "../src/tools/agent-tools.js";
import { registerAllTools, toolPromptHintsForNames } from "../src/tools/bootstrap.js";
import { createRegistry } from "../src/tools/registry.js";
import { makeDispatchBundle } from "../tests/harness/dispatch.js";
import { dispatchStubContext } from "../tests/harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../tests/harness/scratch-env.js";

const env = await isolateClioEnv("clio-harness-context-");
const ctx = dispatchStubContext();
const bundle = makeDispatchBundle(ctx);
try {
	await bundle.extension.start();
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
	registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract });
	const tools = resolveAgentTools({ registry });
	const compiled = compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.default",
		sessionInputs: {
			provider: "local",
			model: "stable-model",
			contextWindow: 131_072,
			providerSupportsTools: true,
			toolNames: tools.map((tool) => tool.name),
			toolPromptHints: [
				...toolPromptHintsForNames(
					tools.map((tool) => tool.name as ToolName),
					"session",
				),
			],
			coordinatorCapabilities: registry.listAll().map((spec) => spec.name),
			fleetRoster: renderFleetPromptSection(ctx.getContract<AgentsContract>("agents")?.listSpecs() ?? []),
		},
	});
	const sizes = tools.map((tool) => ({
		name: tool.name,
		bytes: Buffer.byteLength(
			JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
		),
	}));
	console.log(
		JSON.stringify(
			{
				tools: sizes,
				promptBytes: Buffer.byteLength(compiled.systemPrompt),
				schemaBytes: sizes.reduce((total, tool) => total + tool.bytes, 0),
				sections: compiled.sections,
			},
			null,
			2,
		),
	);
} finally {
	await bundle.extension.stop?.();
	env.restore();
}

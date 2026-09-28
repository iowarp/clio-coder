/**
 * Controlled harness-only context footprint; no project, history, provider or
 * model inference. Reports the compiled prompt by cache layer (see
 * `PROMPT_SECTION_LAYER`) for the interactive surface, ask_user included: the
 * attached tool schemas and the pinned sections form the prefix every session
 * on this install shares, and the pinned total is held to
 * `PINNED_BUDGET_TOKENS`. Session and turn sections are measured with
 * placeholder inputs, so their sizes are floors, not a real session's: the
 * catalogs and session-start facts are absent here. Reminders, skill bodies
 * and gateway results arrive after the prompt and are outside this report.
 *
 * Tokens are Clio's chars/4 estimate. A provider tokenizer can count the same
 * bytes well above it, so the budget needs margin; prompt and schema bytes
 * are reported so a provider's measured ratio can be applied.
 */
import { isBuiltinToolName, ToolNames } from "../src/core/tool-names.js";
import { compile, PROMPT_SECTION_LAYER } from "../src/domains/prompts/compiler.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";
import { ceilChars } from "../src/domains/session/context-accounting.js";
import { createWorkerSafety } from "../src/engine/worker-tools.js";
import { resolveAgentTools } from "../src/tools/agent-tools.js";
import { registerAllTools } from "../src/tools/bootstrap.js";
import { capabilityStarterArgs } from "../src/tools/gateway/guidance.js";
import { TOOL_PLANES } from "../src/tools/policy.js";
import { createRegistry } from "../src/tools/registry.js";
import { makeDispatchBundle } from "../tests/harness/dispatch.js";
import { dispatchStubContext } from "../tests/harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../tests/harness/scratch-env.js";

/** The maintainer's ceiling for the always-sent prefix: schemas plus pinned sections. */
const PINNED_BUDGET_TOKENS = 15_000;

const env = await isolateClioEnv("clio-harness-context-");
const ctx = dispatchStubContext();
const bundle = makeDispatchBundle(ctx);
try {
	await bundle.extension.start();
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
	// An interactive session registers ask_user and configure_clio; the handler never runs here.
	registerAllTools(registry, {
		mcpCapabilities: false,
		dispatch: bundle.contract,
		askUser: async () => ({ answers: [] }),
	});
	const tools = resolveAgentTools({ registry });
	const builtins = registry.listAll().filter((spec) => isBuiltinToolName(spec.name));
	const compiled = compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.default",
		sessionInputs: {
			provider: "local",
			model: "stable-model",
			contextWindow: 131_072,
			providerSupportsTools: true,
			demo: true,
			...(registry.get(ToolNames.ConfigureClio) ? { canConfigureClio: true } : {}),
			toolNames: tools.map((tool) => tool.name),
			coordinatorCapabilities: registry.listAll().map((spec) => spec.name),
			toolDiscoveryHints: builtins.flatMap((spec) => {
				const hint = spec.metadata?.discoveryHint;
				if (!hint) return [];
				const starterArgs = capabilityStarterArgs(spec);
				return [{ tool: spec.name, hint, ...(starterArgs ? { starterArgs } : {}) }];
			}),
			capabilityMap: builtins.flatMap((spec) => {
				const plane = isBuiltinToolName(spec.name) ? TOOL_PLANES[spec.name]?.plane : undefined;
				return plane === undefined ? [] : [{ tool: spec.name, objective: spec.metadata?.objective ?? "", plane }];
			}),
			contextFiles: "<project-type>typescript</project-type>",
			memorySection: "# Memory\n\n- placeholder",
		},
		additionalFragments: [
			{
				id: "context.workspace-root",
				relPath: "inline/workspace-root",
				body: "# Workspace\nAbsolute workspace root: /placeholder",
				contentHash: "0".repeat(64),
				dynamic: true,
			},
		],
	});
	const sizes = tools.map((tool) => ({
		name: tool.name,
		bytes: Buffer.byteLength(
			JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
		),
	}));
	const schemaBytes = sizes.reduce((total, tool) => total + tool.bytes, 0);
	const layers = { pinned: 0, session: 0, turn: 0 };
	const sections = compiled.sections.map((section) => {
		const layer = PROMPT_SECTION_LAYER[section.id] ?? "turn";
		layers[layer] += section.tokenEstimate;
		return { ...section, layer };
	});
	const pinnedPrefixTokens = ceilChars(schemaBytes) + layers.pinned;
	console.log(
		JSON.stringify(
			{
				tools: sizes,
				promptBytes: Buffer.byteLength(compiled.systemPrompt),
				schemaBytes,
				sections,
				layers: { schemaTokens: ceilChars(schemaBytes), ...layers },
				pinnedPrefixTokens,
				pinnedBudgetTokens: PINNED_BUDGET_TOKENS,
				withinPinnedBudget: pinnedPrefixTokens <= PINNED_BUDGET_TOKENS,
			},
			null,
			2,
		),
	);
} finally {
	await bundle.extension.stop?.();
	env.restore();
}

import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { registerAllTools, toolPromptHintsForNames } from "../../src/tools/bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * The session prompt after the placement change: the `Direct tools:` line is
 * the attached surface (gateway and run_script present; artifact, web_fetch,
 * git absent), the usage sentence points at the gateway, and the attached
 * schema bytes per turn are measured the way the v0.4.9 handoff measured them
 * (wire schema, `JSON.stringify({name, description, parameters})`).
 */

/** The attached-schema total the handoff measured before this change, panes included. */
const HANDOFF_TOTAL_BYTES = 33_195;

describe("gateway in the session prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-prompt-");
	});
	afterEach(() => env.restore());

	for (const surface of [
		{ name: "context and gateway", toolNames: [ToolNames.Context, ToolNames.Gateway], providerSupportsTools: true },
		{ name: "context only", toolNames: [ToolNames.Context], providerSupportsTools: true },
		{ name: "gateway only", toolNames: [ToolNames.Gateway], providerSupportsTools: true },
		{ name: "no tools", toolNames: [], providerSupportsTools: true },
		{
			name: "a provider without tool calls",
			toolNames: [ToolNames.Context, ToolNames.Gateway],
			providerSupportsTools: false,
		},
	]) {
		it(`gates documentation and skill catalog guidance for ${surface.name}`, () => {
			const compiled = compile(loadFragments(), {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: {
					provider: "local",
					model: "stable-model",
					contextWindow: 32_768,
					providerSupportsTools: surface.providerSupportsTools,
					toolNames: surface.toolNames,
					// Hints must not make an unattached tool available.
					toolPromptHints: [...toolPromptHintsForNames([ToolNames.Context, ToolNames.Gateway], "session")],
				},
			});
			const hasGateway = surface.providerSupportsTools && surface.toolNames.includes(ToolNames.Gateway);
			const hasContext = surface.providerSupportsTools && surface.toolNames.includes(ToolNames.Context);
			strictEqual(compiled.systemPrompt.includes("# Clio documentation routing"), hasGateway);
			strictEqual(
				compiled.fragmentManifest.some((fragment) => fragment.id === "identity.docs-routing"),
				hasGateway,
			);
			strictEqual(compiled.systemPrompt.includes('capability="clio_docs"'), hasGateway);
			strictEqual(
				compiled.sections.some((section) => section.id === "skills"),
				hasContext,
			);
			strictEqual(compiled.systemPrompt.includes('context (scope="skills")'), hasContext);
			strictEqual(compiled.systemPrompt.includes('capability="clio_library"'), hasContext);
			if (hasContext) {
				match(
					compiled.systemPrompt,
					/If gateway is on the attached direct-tool surface, use\s+gateway\(op="call", capability="clio_library", args=\{\}\) to read the catalog\s+of recipes and installable packages; it activates and installs nothing\./,
				);
				ok(compiled.systemPrompt.includes("Without gateway, this catalog route is unavailable."));
				match(compiled.systemPrompt, /only the operator\s+activates or installs a skill/);
			}
			doesNotMatch(compiled.systemPrompt, /\bcontext\s*\(\s*scope\s*=\s*["'](?:docs|library)["']/);
		});
	}

	it("lists the direct surface, points tool usage at the gateway, and shrinks the attached schema bytes", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext());
		await bundle.extension.start();
		try {
			const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
			registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract, includeLedgerTools: true });
			const tools = resolveAgentTools({ registry });
			const names = tools.map((tool) => tool.name as ToolName).sort();
			for (const present of [ToolNames.Gateway, ToolNames.RunScript, ToolNames.Dispatch, ToolNames.Context]) {
				ok(names.includes(present), `${present} is attached`);
			}
			for (const absent of [ToolNames.Artifact, ToolNames.WebFetch, ToolNames.WebRead, ToolNames.Git, ToolNames.Data]) {
				ok(!names.includes(absent), `${absent} is not attached`);
			}

			const compiled = compile(loadFragments(), {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: {
					provider: "local",
					model: "stable-model",
					contextWindow: 32_768,
					providerSupportsTools: true,
					toolNames: names,
					toolPromptHints: [...toolPromptHintsForNames(names, "session")],
				},
			});
			const lines = compiled.systemPrompt.split("\n");
			ok(
				compiled.systemPrompt.includes(
					'For a question about Clio herself, call gateway(op="call", capability="clio_docs", args={query: <the question>}) before answering and before any workspace search, then read the document it names from the installed documentation path above.',
				),
				"The compiled identity routes Clio questions through gateway before answering or searching the workspace.",
			);
			doesNotMatch(
				compiled.systemPrompt,
				/\bcontext\s*\(\s*scope\s*=\s*["']docs["']/,
				"The compiled prompt must not instruct the retired context docs call.",
			);
			const direct = lines.find((line) => line.startsWith("Direct tools:"));
			ok(direct !== undefined);
			ok(direct.includes("`gateway`") && direct.includes("`run_script`"), direct);
			for (const absent of ["`artifact`", "`web_fetch`", "`git`"]) ok(!direct.includes(absent), direct);
			ok(
				lines.some((line) => line.includes('gateway(op="call", capability="clio_docs"')),
				"the usage sentence points at the gateway",
			);
			ok(lines.some((line) => line.includes("secondary capabilities are reached through gateway")));
			ok(
				lines.some((line) => line.includes('op="find" lists them')),
				"the gateway hint renders",
			);

			// Attached schema bytes, measured as the handoff did. Every direct tool
			// this registry attaches is counted; panes needs a pane host and ask_user
			// an interactive bridge, so neither is on this surface.
			const sizes = tools
				.map((tool) => ({
					name: tool.name,
					bytes: Buffer.byteLength(
						JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
						"utf8",
					),
				}))
				.sort((left, right) => right.bytes - left.bytes);
			const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
			console.log(
				`attached schema bytes: total ${total}\n${sizes.map((entry) => `  ${entry.name}: ${entry.bytes}`).join("\n")}`,
			);
			ok(total < HANDOFF_TOTAL_BYTES, `attached bytes ${total} must stay below the handoff's ${HANDOFF_TOTAL_BYTES}`);
			const gateway = sizes.find((entry) => entry.name === ToolNames.Gateway);
			ok(gateway !== undefined && gateway.bytes < 2_048, `the gateway schema stays small: ${gateway?.bytes}`);
			doesNotMatch(
				compiled.systemPrompt,
				/\bcontext\s*\(\s*scope\s*=\s*["']library["']/,
				"The compiled prompt must not instruct the retired context library call, including across line breaks.",
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

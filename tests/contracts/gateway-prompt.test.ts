import { doesNotMatch, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
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

/**
 * Bytes the gateway's `server` and `refresh` inputs add to that surface,
 * measured as this test measures everything else. They are the entire attached
 * cost of offline MCP discovery, which stops an unrestricted find from
 * launching every trusted server to answer a query it may then filter out.
 * The remedy sentence for a missing catalog rides in the find payload instead
 * of in this schema, so it is paid for only when a find asks for it.
 */
const MCP_DISCOVERY_INPUT_BYTES = 142;

const ATTACHED_BUDGET_BYTES = HANDOFF_TOTAL_BYTES + MCP_DISCOVERY_INPUT_BYTES;

describe("gateway in the session prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-prompt-");
	});
	afterEach(() => env.restore());

	// Which surfaces render the docs and skill catalog guidance is pinned in prompt-section-matrix.test.ts.
	it("lists the direct surface, points tool usage at the gateway, and shrinks the attached schema bytes", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext());
		await bundle.extension.start();
		try {
			const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
			registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract, includeLedgerTools: true });
			strictEqual(registry.get(ToolNames.Ledger)?.placement, "gateway");
			strictEqual(registry.get(ToolNames.Ledger)?.metadata?.startupPrompt, false);
			const tools = resolveAgentTools({ registry });
			const names = tools.map((tool) => tool.name as ToolName).sort();
			for (const present of [
				ToolNames.Gateway,
				ToolNames.Read,
				ToolNames.Write,
				ToolNames.Edit,
				ToolNames.Grep,
				ToolNames.CodeNav,
				ToolNames.Dispatch,
			]) {
				ok(names.includes(present), `${present} is attached`);
			}
			for (const absent of [
				ToolNames.Ledger,
				ToolNames.Artifact,
				ToolNames.WebFetch,
				ToolNames.WebRead,
				ToolNames.Git,
				ToolNames.Data,
				ToolNames.RunScript,
				ToolNames.Context,
			]) {
				ok(!names.includes(absent), `${absent} is not attached`);
			}

			const compiled = compile(loadFragments(), {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.default",
				sessionInputs: {
					provider: "local",
					model: "stable-model",
					contextWindow: 32_768,
					providerSupportsTools: true,
					toolNames: names,
					coordinatorCapabilities: registry.listAll().map((spec) => spec.name),
				},
			});
			const lines = compiled.systemPrompt.split("\n");
			ok(
				compiled.systemPrompt.includes(
					'Questions about CLIO Coder itself: gateway(op="call", capability="clio_docs", args={query:"<the question>"}) first',
				),
				"The compiled prompt routes documented CLIO Coder behavior through gateway before answering or searching the workspace.",
			);
			doesNotMatch(
				compiled.systemPrompt,
				/\bcontext\s*\(\s*scope\s*=\s*["']docs["']/,
				"The compiled prompt must not instruct the retired context docs call.",
			);
			const direct = lines.find((line) => line.startsWith("Direct tools:"));
			ok(direct !== undefined);
			ok(direct.includes("`gateway`") && direct.includes("`dispatch`"), direct);
			for (const absent of ["`artifact`", "`web_fetch`", "`git`"]) ok(!direct.includes(absent), direct);
			ok(
				lines.some((line) => line.includes('gateway(op="call", capability="clio_docs"')),
				"the usage sentence points at the gateway",
			);
			ok(lines.some((line) => line.includes('gateway(op="describe", capability="<name>") first')));
			ok(
				lines.some((line) => line.includes('gateway(op="find", query="<two to four words>")')),
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
			// 13,127 (fleet DESIGN open question 10): grep and code_nav (row 145) and dispatch's job table, plus the 751-byte finish
			// declaration, whose measured description (CLI-P49) says the reply text comes first; it was 648 bytes and 13,024.
			// 13,441: read takes several paths in one call (maintainer 2026-11-22 15:34Z) and its description says so;
			// schema size is not a lab constraint (maintainer 13:10Z), so the ceiling follows the ruled description.
			// 13,628: finish states when it applies first (a text-only reply never calls it), 751 -> 938 bytes (15:27Z ruling).
			ok(total <= 13_628, `ten attached tools must stay within 13,628 bytes, down from ${ATTACHED_BUDGET_BYTES}`);
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

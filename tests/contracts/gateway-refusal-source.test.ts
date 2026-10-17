import { doesNotMatch, match, ok, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { parseAcpFlags } from "../../src/cli/acp.js";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import type { TurnConstraints } from "../../src/core/turn-constraints.js";
import {
	narrowTurnConstraints,
	snapshotTurnConstraints,
	templateToolConstraints,
	workerTurnConstraints,
} from "../../src/core/turn-constraints.js";
import { assertTurnConstraintCompatibility } from "../../src/domains/dispatch/tool-constraints.js";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { expandSubmitText } from "../../src/domains/resources/submit-expansion.js";
import { createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import type { McpCapabilitySource } from "../../src/tools/gateway/mcp-capabilities.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("gateway refusals preserve the narrowing source and put its remedy on a separate line", async () => {
	const env = await isolateClioEnv("gateway-refusal-source-");
	try {
		const registry = createWorkerToolRegistry();
		const gateway = createGatewayTool({
			registry,
			mcp: {
				declaredIds: () => ["files"],
				ownerIdOf: (name: string) => (name.startsWith("mcp_files__") ? "files" : null),
			} as McpCapabilitySource,
		});
		const cli = parseRunCliArgs(["--allow-tools", "read,grep", "--delegate-tools", "read"]);
		const template = { name: "review", allowedTools: ["read"], delegatedTools: ["read"] };
		const resources = {
			parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
			expandPromptTemplate: () => ({ expanded: true, template, text: "Review" }),
		} as unknown as ResourcesContract;
		const expanded = await expandSubmitText("/review", resources, env.dir);
		const merged = snapshotTurnConstraints(narrowTurnConstraints(cli.constraints, expanded.constraints));
		const cases: Array<[TurnConstraints | undefined, RegExp]> = [
			[cli.constraints, /Refused by: --allow-tools/u],
			[extractGlobalFlags(["--allow-tools", "read"]).toolLimits, /Refused by: --allow-tools/u],
			[expanded.constraints, /Refused by: prompt template "review" allowed-tools/u],
			[merged, /Refused by: --allow-tools; prompt template "review" allowed-tools/u],
			[workerTurnConstraints(merged ?? {}), /Refused by: --delegate-tools; prompt template "review" delegated-tools/u],
			[{ allowedTools: ["read"] }, /Refused by: explicit task scope/u],
			[
				// A recipe tool list is copied verbatim, so a name outside the strict
				// tool-name rule must still snapshot rather than fail the worker spec.
				snapshotTurnConstraints({
					toolSurfaceSources: [
						{
							tools: ["read", "web search"],
							source: 'agent recipe "researcher"',
							remedy: 'Widen tools in agent recipe "researcher", then redispatch.',
						},
					],
				}),
				/Refused by: agent recipe "researcher"/u,
			],
		];
		for (const [turnConstraints, source] of cases) {
			for (const args of [
				{ op: "call", capability: "edit", args: {} },
				{ op: "find", server: "files" },
			]) {
				const result = await gateway.run(args, { allowedTools: ["read"], ...(turnConstraints ? { turnConstraints } : {}) });
				strictEqual(result.kind, "error");
				if (result.kind !== "error") throw new Error("expected refusal");
				match(result.message, source);
				match(result.message, /\nRemedy: .+/u);
			}
		}
		const grep = await gateway.run(
			{ op: "call", capability: "grep" },
			{ ...(merged ? { turnConstraints: merged } : {}) },
		);
		if (grep.kind !== "error") throw new Error("expected refusal");
		match(grep.message, /prompt template "review" allowed-tools/u);
		doesNotMatch(grep.message, /Refused by: --allow-tools/u);
	} finally {
		env.restore();
	}
});

test("dispatch delegation refusal names the restricting source and how to widen it", () => {
	const cli = parseRunCliArgs(["--delegate-tools", "read"]);
	const acp = parseAcpFlags(["--allow-tools", "dispatch", "--delegate-tools", "read"]);
	if (typeof acp === "string") throw new Error(acp);
	const template = { name: "review", delegatedTools: ["read"] };
	const resources = templateToolConstraints(template);
	for (const [constraints, source] of [
		[cli.constraints, "--delegate-tools"],
		[acp.toolLimits, "--delegate-tools"],
		[resources, 'prompt template "review" delegated-tools'],
		[{ delegatedTools: ["read"] }, "explicit task scope"],
	] as const) {
		const request = {
			agentId: "coder",
			task: "Check",
			executionRole: "builder" as const,
			...(constraints ? { turnConstraints: constraints } : {}),
		};
		throws(
			() => assertTurnConstraintCompatibility(request, ["read", "bash"], true),
			(error: unknown) => {
				ok(error instanceof Error);
				match(error.message, /worker tool surface exceeds.*bash/u);
				ok(error.message.includes(`\nRefused by: ${source}.\nRemedy: `));
				match(error.message, /Remedy: .*wid(?:en|er).*resubmit/iu);
				return true;
			},
		);
		assertTurnConstraintCompatibility(request, ["read"], true);
	}
});

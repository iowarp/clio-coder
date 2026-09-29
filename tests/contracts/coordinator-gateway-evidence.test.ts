import { deepStrictEqual, doesNotThrow, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { buildPathIndex } from "../../src/domains/context/working-set/path-index.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { activeUserTaskAcceptance } from "../../src/domains/user-tasks/active-acceptance.js";
import { validateEngineToolArguments } from "../../src/engine/ai.js";
import { createAskUserToolPolicy, pendingSkillRequestPreamble } from "../../src/interactive/chat-loop-messages.js";
import { assessToolProseLoop } from "../../src/interactive/tool-prose-loop.js";
import { coordinatorDispatchParameters } from "../../src/tools/dispatch-schema.js";

function gatewayCall(toolCallId: string, capability: string, args: Record<string, unknown>): unknown {
	return {
		kind: "message",
		role: "tool_call",
		turnId: toolCallId,
		payload: { name: ToolNames.Gateway, toolCallId, args: { op: "call", capability, args } },
	};
}

function gatewayResult(toolCallId: string, capability: string): unknown {
	return {
		kind: "message",
		role: "tool_result",
		turnId: toolCallId,
		payload: {
			toolName: ToolNames.Gateway,
			toolCallId,
			isError: false,
			result: { kind: "ok", details: { kind: "ok", capability } },
		},
	};
}

function mutationWindow(): unknown[] {
	return [
		{ kind: "message", role: "user", turnId: "user-1", payload: { text: "change the file" } },
		{
			kind: "message",
			role: "tool_call",
			turnId: "write-1",
			payload: { name: ToolNames.Write, toolCallId: "write-1", args: { path: "src/thing.ts", content: "x" } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "write-1",
			payload: { toolName: ToolNames.Write, toolCallId: "write-1", isError: false, result: { kind: "ok" } },
		},
	];
}

const assistant = {
	kind: "message",
	role: "assistant",
	turnId: "assistant-1",
	payload: { text: "Done.", stopReason: "stop" },
};

describe("coordinator evidence reached through the gateway", () => {
	it("counts a gateway-called limitation receipt", () => {
		const entries = [
			...mutationWindow(),
			gatewayCall("lim-1", ToolNames.Limitation, { scope: "tests could not run", reason: "no-runner" }),
			gatewayResult("lim-1", ToolNames.Limitation),
			assistant,
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "explicit_limitation");
	});

	it("counts a gateway-called verify check as validation evidence", () => {
		const entries = [
			...mutationWindow(),
			gatewayCall("verify-1", ToolNames.Verify, { check: "test" }),
			gatewayResult("verify-1", ToolNames.Verify),
			assistant,
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		ok(
			assessment.evidence.some((item) => item.kind !== "limitation" && item.summary.includes("test")),
			JSON.stringify(assessment.evidence),
		);
		strictEqual(assessment.kind, "ok");
	});
});

describe("coordinator interview and skill surfaces", () => {
	const registry = {
		get: (name: string) =>
			name === ToolNames.AskUser ? ({ name, placement: "gateway" } as never) : (undefined as never),
	};
	const attached = [{ name: ToolNames.Read }, { name: ToolNames.Gateway }];

	it("arms one turn-scoped ask_user policy when ask_user is reachable only through the gateway", () => {
		ok(createAskUserToolPolicy(attached, registry, undefined));
		strictEqual(createAskUserToolPolicy([{ name: ToolNames.Read }], registry, undefined), undefined);
		strictEqual(createAskUserToolPolicy(attached, registry, { allowedTools: [ToolNames.Read] } as never), undefined);
	});

	it("names the gateway skill load when context carries no attached schema", () => {
		const requests = [{ name: "demo", args: "", source: "operator", installed: true }] as never;
		ok(pendingSkillRequestPreamble(requests, attached).includes('gateway(op="call", capability="context"'));
		ok(pendingSkillRequestPreamble(requests).includes('First call context with scope="skills"'));
	});

	it("lets described dispatch modes reach canonical validation", () => {
		const tool = { name: ToolNames.Dispatch, description: "", parameters: coordinatorDispatchParameters() };
		for (const mode of ["parallel", "compete", "council"]) {
			doesNotThrow(() =>
				validateEngineToolArguments(tool, {
					type: "toolCall",
					id: "d",
					name: ToolNames.Dispatch,
					arguments: { task: "t", mode },
				}),
			);
		}
		deepStrictEqual(Object.keys(coordinatorDispatchParameters().properties).includes("mode"), true);
	});
});

describe("coordinator ledgers read gateway op=call as its capability", () => {
	const timestamp = new Date().toISOString();
	const stamp = (entry: Record<string, unknown>) => ({ parentTurnId: null, timestamp, ...entry }) as SessionEntry;

	it("indexes a gateway grep as a grep observation", () => {
		const entries = [
			stamp(gatewayCall("g1", ToolNames.Grep, { pattern: "needle", path: "src" }) as Record<string, unknown>),
			stamp({
				kind: "message",
				role: "tool_result",
				turnId: "g1-result",
				payload: {
					toolName: ToolNames.Gateway,
					toolCallId: "g1",
					isError: false,
					result: { content: [{ type: "text", text: "src/a.ts:1:needle" }], details: { kind: "ok", capability: "grep" } },
				},
			}),
		];
		const index = buildPathIndex(entries, { cwd: "/workspace" });
		deepStrictEqual(
			index.observations.map((observation) => observation.op),
			["grep"],
		);
	});

	it("keeps a task's acceptance through a gateway board update that closes it", () => {
		const acceptance = { expectedOutputs: ["out.txt"], verification: [{ check: "test" }] };
		const board = { boardId: "b", title: "t", tasks: [{ id: "1", status: "done", userTaskId: "u1" }] } as never;
		const tasks = [{ id: "u1", handedSessionId: "s1", acceptance }] as never;
		const window = [stamp(gatewayCall("t1", ToolNames.Tasks, { action: "done", id: "1" }) as Record<string, unknown>)];
		deepStrictEqual(activeUserTaskAcceptance(tasks, board, "s1", window)?.expectedOutputs, ["out.txt"]);
	});
});

describe("coordinator surface support", () => {
	it("catches narration of a gateway capability and names the gateway call", () => {
		const text = `${"Now I will use the grep tool to search the repository for the symbol. ".repeat(24)}`;
		const attached = ["read", "bash", "gateway"];
		strictEqual(assessToolProseLoop({ text, activeToolNames: attached }).kind, "ok");
		const assessment = assessToolProseLoop({ text, activeToolNames: attached, gatewayToolNames: ["grep", "web_read"] });
		strictEqual(assessment.kind, "loop");
		ok(assessment.kind === "loop" && assessment.reason.includes('gateway(op="call", capability="grep"'));
	});
});

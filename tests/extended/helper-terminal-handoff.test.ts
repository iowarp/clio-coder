import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { AgentEvent } from "../../src/engine/types.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import { startWorkerRun, type WorkerRunHandle } from "../../src/engine/worker-runtime.js";
import { attestedToolSignature } from "../../src/engine/worker-tools.js";
import { projectWorkerEventForStdout } from "../../src/worker/event-projection.js";
import { isReceiptBearingFrame, toolSignatureOf } from "../../src/worker/protocol.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const data = { findings: [{ claim: "No grounded evidence is available." }], needsSplit: false, proposedSubtasks: [] };
const submit = (args: unknown = data) => ({ name: "clio_submit_result", arguments: JSON.stringify(args) });
const longData = { ...data, findings: [{ claim: "Substantive finding. ".repeat(600) }] };
const write = { name: "write", arguments: JSON.stringify({ path: "forbidden.txt", content: "must not execute" }) };
const scenarios: Array<{
	name: string;
	rounds: Array<Array<ReturnType<typeof submit>> | string>;
	code: number;
	expectedData?: typeof data;
}> = [
	{
		name: "accepts a report larger than the old 8 KiB capture limit",
		rounds: [[submit(longData)]],
		code: 0,
		expectedData: longData,
	},
	{ name: "validated JSON text fallback", rounds: [JSON.stringify(data)], code: 0 },
	{ name: "prose never becomes structured evidence", rounds: ["Done.", "Done.", "Done."], code: 1 },
	{ name: "accepted handoff terminates without prose round", rounds: [[submit()]], code: 0 },
	{ name: "schema failure repairs once", rounds: [[submit({ findings: [] })], [submit()]], code: 0 },
	{
		name: "unobserved citation fails validation then repairs",
		rounds: [[submit({ ...data, findings: [{ claim: "invented", path: "missing.ts", line: 1 }] })], [submit()]],
		code: 0,
	},
	{ name: "work preceding handoff cannot execute", rounds: [[write, submit()], [submit()]], code: 0 },
	{ name: "work following handoff cannot execute", rounds: [[submit(), write], [submit()]], code: 0 },
	{ name: "duplicate handoffs are rejected", rounds: [[submit(), submit()], [submit()]], code: 0 },
	{ name: "work cannot reopen during repair", rounds: [[submit({ findings: [] })], [write], [submit()]], code: 0 },
	{
		name: "invalid arguments exhaust two repairs",
		rounds: [[submit({ findings: [] })], [submit({ findings: [] })], [submit({ findings: [] })]],
		code: 1,
	},
	{
		name: "malformed transport arguments fail closed",
		rounds: [[{ name: "clio_submit_result", arguments: "{" }]],
		code: 1,
	},
];
for (const scenario of scenarios) {
	test(`internal helper: ${scenario.name}`, { timeout: 15000 }, async () => {
		const env = await isolateClioEnv("clio-helper-terminal-");
		const requests: Array<{
			tools: Array<{ function: { name: string } }>;
			tool_choice?: unknown;
			parallel_tool_calls?: unknown;
		}> = [];
		const events: Array<AgentEvent | ClioWorkerEvent> = [];
		let worker: WorkerRunHandle | undefined;
		const server = createServer(async (req, res) => {
			requests.push(JSON.parse(await readRequestBody(req)));
			const round = scenario.rounds[requests.length - 1] ?? [submit({ findings: [] })];
			res.setHeader("content-type", "text/event-stream");
			res.end(
				`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta: typeof round === "string" ? { content: round } : { role: "assistant", tool_calls: round.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: "function", function: call })) }, finish_reason: typeof round === "string" ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			worker = startWorkerRun(
				{
					agentId: "scout",
					systemPrompt: "Inspect and return a Scout report.",
					task: "Summarize available evidence.",
					target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
					runtime: litellm,
					wireModelId: "fixture",
					apiKey: "fixture",
					thinkingLevel: "off",
					modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
					allowedTools: ["write"],
					budget: { mode: "advisory", toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 150 },
					product: "orientation",
					noSkills: true,
					cwd: env.dir,
					autonomy: "full-auto",
					helperResult: true,
					resultContract: { kind: "scout-report" },
				},
				(event) => {
					events.push(event);
					if (event.type === "clio_coder_helper_result") worker?.steer?.("Attempt another write after acceptance.");
				},
			);
			const result = await worker.promise;
			strictEqual(result.exitCode, scenario.code, JSON.stringify(result));
			strictEqual(requests.length, scenario.rounds.length);
			ok(requests[0]);
			ok(
				requests[0].tools.some((tool) => tool.function.name === "write"),
				"fixture must expose a real work tool before terminal lock",
			);
			strictEqual(
				toolSignatureOf(requests[0].tools.map((tool) => tool.function.name)),
				attestedToolSignature({
					allowedTools: ["write"],
					toolsSupported: true,
					helperResult: true,
					agentId: "scout",
					task: "Summarize available evidence.",
				}),
			);
			strictEqual(existsSync(join(env.dir, "forbidden.txt")), false);
			if (scenario.rounds.some((round) => Array.isArray(round) && round.some((call) => call.name === "write"))) {
				const deniedWrite = events.find((event) => event.type === "tool_execution_end" && event.toolName === "write");
				ok(deniedWrite?.type === "tool_execution_end");
				strictEqual(deniedWrite.isError, true);
				ok(/mixed or duplicate|Work tools are disabled/.test(JSON.stringify(deniedWrite.result)));
			}
			const accepted = events.filter((event) => event.type === "clio_coder_helper_result");
			strictEqual(accepted.length, scenario.code === 0 ? 1 : 0);
			if (accepted[0]) {
				deepStrictEqual(accepted[0].payload, { version: 1, kind: "scout-report", data: scenario.expectedData ?? data });
				strictEqual(projectWorkerEventForStdout(accepted[0]), accepted[0]);
				strictEqual(isReceiptBearingFrame(accepted[0]), true);
			}
			for (const request of requests.slice(1)) {
				deepStrictEqual(
					request.tools.map((tool) => tool.function.name),
					["clio_submit_result"],
				);
				strictEqual(request.tool_choice, "required");
				strictEqual(request.parallel_tool_calls, false);
			}
			if (scenario.code === 1 && scenario.rounds.length === 3)
				strictEqual(
					events.filter(
						(event) => event.type === "clio_coder_run_outcome" && event.payload.outcomeCode === "result_contract_exhausted",
					).length,
					1,
				);
		} finally {
			worker?.abort();
			await worker?.promise;
			await closeServer(server);
			env.restore();
		}
	});
}

test("tool-disabled targets attest no terminal helper tool", () => {
	strictEqual(
		attestedToolSignature({ allowedTools: ["write"], toolsSupported: false, helperResult: true }),
		attestedToolSignature({ allowedTools: ["write"], toolsSupported: false }),
	);
});

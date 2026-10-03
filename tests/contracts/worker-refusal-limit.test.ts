import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { AgentEvent } from "../../src/engine/types.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import { startWorkerRun } from "../../src/engine/worker-runtime.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../src/worker/spec-contract.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type Round = Array<{ name: string; arguments: string }> | { text: string };

/** Drive a deny-posture worker against scripted model rounds; commands only ever park, never run. */
async function runDenyWorker(rounds: Round[]) {
	const env = await isolateClioEnv("clio-worker-refusal-");
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync(join(env.dir, "mark.sh"), '#!/bin/sh\nprintf "x\\n" >> count.txt\n');
	chmodSync(join(env.dir, "mark.sh"), 0o755);
	const events: Array<AgentEvent | ClioWorkerEvent> = [];
	const toolResults: string[] = [];
	let requests = 0;
	const server = createServer(async (req, res) => {
		const body = JSON.parse(await readRequestBody(req)) as { messages?: Array<{ role: string; content?: unknown }> };
		const last = body.messages?.at(-1);
		if (last?.role === "tool") toolResults.push(JSON.stringify(last.content));
		const round = rounds[requests] ?? rounds.at(-1) ?? { text: "done" };
		requests += 1;
		res.setHeader("content-type", "text/event-stream");
		const delta = Array.isArray(round)
			? {
					role: "assistant",
					tool_calls: round.map((call, index) => ({
						index,
						id: `call_${requests}_${index}`,
						type: "function",
						function: call,
					})),
				}
			: { role: "assistant", content: round.text };
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: Array.isArray(round) ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const worker = startWorkerRun(
			{
				agentId: "coder",
				systemPrompt: "Run the marker script when asked.",
				task: "Run ./mark.sh.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
				allowedTools: ["bash"],
				budget: { mode: "advisory", toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 150 },
				noSkills: true,
				cwd: env.dir,
				onPermission: "deny",
			},
			(event) => events.push(event),
		);
		const result = await worker.promise;
		const resolved = events.flatMap((event) =>
			event.type === "clio_coder_permission_resolved" ? [event.payload.reason ?? ""] : [],
		);
		return { result, resolved, requests, toolResults };
	} finally {
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
}

const mark = (arg: string) => ({ name: "bash", arguments: JSON.stringify({ command: `./mark.sh ${arg}` }) });

describe("worker execute refusals", () => {
	it("returns a refusal to the model and ends only at the third refused command", { timeout: 30_000 }, async () => {
		const recovered = await runDenyWorker([[mark("one")], { text: "done without the script" }]);
		strictEqual(recovered.result.exitCode, 0, "one refusal no longer ends the run");
		strictEqual(recovered.requests, 2, "the model got a turn after the refusal");
		strictEqual(recovered.toolResults.length, 1);
		ok(/permission denied by policy/u.test(recovered.toolResults[0] ?? ""), recovered.toolResults[0]);

		const stuck = await runDenyWorker([[mark("one")], [mark("two")], [mark("three")], [mark("four")]]);
		strictEqual(stuck.result.exitCode, WORKER_EXIT_PERMISSION_REQUIRED);
		strictEqual(stuck.requests, 3, "the third refusal ends the run before another model request");
		strictEqual(stuck.resolved.length, 3);
		const final = stuck.resolved.at(-1) ?? "";
		ok(final.startsWith("permission refusal limit reached"), final);
		deepStrictEqual(
			["./mark.sh one", "./mark.sh two", "./mark.sh three"].map((command) => final.includes(`\`${command}\``)),
			[true, true, true],
			final,
		);
	});
});

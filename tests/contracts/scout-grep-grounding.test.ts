import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { AgentEvent } from "../../src/engine/types.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import { startWorkerRun, type WorkerRunHandle } from "../../src/engine/worker-runtime.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SOURCE = [
	"export interface OverlayHandles {",
	"\topenUsage(): void;",
	"}",
	"",
	"export function wireOverlays(handles: OverlayHandles): void {",
	"\tconst openUsageOverlayState = handles.openUsage;",
	"\topenUsageOverlayState();",
	"}",
].join("\n");

type Call = { name: string; arguments: string };
const grep: Call = {
	name: "grep",
	// The worker searches the scratch workspace, which is its process directory.
	arguments: JSON.stringify({ pattern: "openUsageOverlayState", path: "{WORKSPACE}" }),
};
const submit = (line: number): Call => ({
	name: "clio_submit_result",
	arguments: JSON.stringify({
		findings: [{ claim: "The usage overlay opener is bound to a local.", path: "overlays.ts", line }],
		needsSplit: false,
		proposedSubtasks: [],
	}),
});

async function runScout(rounds: Call[][]) {
	const env = await isolateClioEnv("clio-scout-grep-grounding-");
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync(join(env.dir, "overlays.ts"), SOURCE);
	const events: Array<AgentEvent | ClioWorkerEvent> = [];
	let requests = 0;
	let worker: WorkerRunHandle | undefined;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		const round = (rounds[requests] ?? rounds.at(-1) ?? []).map((call) => ({
			...call,
			arguments: call.arguments.replace("{WORKSPACE}", env.dir),
		}));
		requests += 1;
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: round.map((call, index) => ({ index, id: `call_${requests}_${index}`, type: "function", function: call })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "scout",
				systemPrompt: "Inspect and return a Scout report.",
				task: "Find where the usage overlay opener is bound.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
				allowedTools: ["grep"],
				budget: { mode: "advisory", toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 150 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
				helperResult: true,
				resultContract: { kind: "scout-report" },
			},
			(event) => events.push(event),
		);
		const result = await worker.promise;
		return { result, events, requests };
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
}

test("a Scout may cite the line a grep match showed it", { timeout: 15_000 }, async () => {
	const { result, events, requests } = await runScout([[grep], [submit(6)]]);
	strictEqual(result.exitCode, 0, JSON.stringify(events.filter((event) => event.type === "clio_coder_run_outcome")));
	strictEqual(requests, 2, "the citation was accepted without a repair round");
	const accepted = events.filter((event) => event.type === "clio_coder_helper_result");
	strictEqual(accepted.length, 1);
	ok(accepted[0]?.type === "clio_coder_helper_result");
	deepStrictEqual(
		(accepted[0].payload.data as { findings: Array<{ line: number }> }).findings.map((finding) => finding.line),
		[6],
	);
});

test("a line the grep did not show still fails grounding", { timeout: 15_000 }, async () => {
	const { result, events } = await runScout([[grep], [submit(2)], [submit(2)], [submit(2)]]);
	strictEqual(result.exitCode, 1);
	const exhausted = events.find((event) => event.type === "clio_coder_run_outcome");
	ok(exhausted?.type === "clio_coder_run_outcome");
	strictEqual(exhausted.payload.outcomeCode, "result_contract_exhausted");
	ok(/overlays\.ts:2 \(this run read only 6-6, 7-7\)/u.test(exhausted.payload.detail ?? ""), exhausted.payload.detail);
});

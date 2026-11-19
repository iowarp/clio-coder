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

type Reply = { toolCall: { name: string; arguments: string } } | { text: string } | { status: number; error: string };
type Body = {
	tools?: unknown[];
	response_format?: { type?: string; json_schema?: { schema?: { properties?: Record<string, unknown> } } };
	messages: Array<{ role: string; content?: unknown }>;
};

const MARKDOWN_REVIEW = "## Plan Review\n\n### Claim coverage: **PASS**\n\nEvery claim maps to a paragraph.";
const REPORT = JSON.stringify({
	verdict: "pass",
	checks: [{ name: "claim coverage", passed: true, evidence: "plan.md maps every claim to a paragraph." }],
});

/** A WTF-P-shaped read-only reviewer: it reads, answers in Markdown, then is repaired. */
async function runReviewer(
	replies: Reply[],
	structuredOutputs: "json-schema" | "none",
	bounds: { mode: "advisory" | "enforced"; toolCalls: number; hardCap: number; contract: boolean } = {
		mode: "advisory",
		toolCalls: 18,
		hardCap: 150,
		contract: true,
	},
) {
	const env = await isolateClioEnv("clio-contract-enforcement-");
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync(join(env.dir, "plan.md"), "claim one maps to P2\n");
	const bodies: Body[] = [];
	const events: Array<AgentEvent | ClioWorkerEvent> = [];
	let worker: WorkerRunHandle | undefined;
	const server = createServer(async (req, res) => {
		bodies.push(JSON.parse(await readRequestBody(req)) as Body);
		const reply = replies[bodies.length - 1] ?? replies.at(-1);
		if (reply === undefined) throw new Error("no scripted reply");
		if ("status" in reply) {
			res.statusCode = reply.status;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error" } }));
			return;
		}
		const delta =
			"toolCall" in reply
				? {
						role: "assistant",
						tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: reply.toolCall }],
					}
				: { role: "assistant", content: reply.text };
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: "toolCall" in reply ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "reviewer",
				systemPrompt: "Review the plan.",
				task: "Review plan.md.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true, structuredOutputs },
				allowedTools: ["read"],
				budget: {
					mode: bounds.mode,
					toolCalls: bounds.toolCalls,
					readReserve: 0,
					synthesis: true,
					hardCap: bounds.hardCap,
				},
				product: "orientation",
				noSkills: true,
				readOnly: true,
				cwd: env.dir,
				...(bounds.contract ? { resultContract: { kind: "verifier-report" as const } } : {}),
			},
			(event) => events.push(event),
		);
		const result = await worker.promise;
		return { result, bodies, events };
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
}

const read = { toolCall: { name: "read", arguments: JSON.stringify({ path: "plan.md" }) } };
const lastToolText = (body: Body | undefined) => JSON.stringify(body?.messages.filter((m) => m.role === "tool").at(-1));

test("a prose answer is repaired in a final-only round bound to the contract's schema", {
	timeout: 15_000,
}, async () => {
	const { result, bodies, events } = await runReviewer(
		[read, { text: MARKDOWN_REVIEW }, { text: REPORT }],
		"json-schema",
	);
	strictEqual(result.exitCode, 0, JSON.stringify(events.filter((event) => event.type === "clio_coder_run_outcome")));
	strictEqual(bodies.length, 3);
	// Work rounds keep their tools and carry no schema.
	ok((bodies[1]?.tools ?? []).length > 0);
	strictEqual(bodies[1]?.response_format, undefined);
	// Item 8: the reminder is a host reminder on the tail after the read's result, never inside a tool result (D4).
	const tail = bodies[1]?.messages.at(-1);
	strictEqual(tail?.role, "user");
	ok(JSON.stringify(tail).includes("<system-reminder>\\n[result contract: verifier-report]"), JSON.stringify(tail));
	ok(!lastToolText(bodies[1]).includes("[result contract:"), lastToolText(bodies[1]));
	ok(!lastToolText(bodies[2]).includes("[result contract:"), lastToolText(bodies[2]));
	// Item 7: the repair round ships no tools and binds the reply to the verifier schema.
	strictEqual((bodies[2]?.tools ?? []).length, 0);
	strictEqual(bodies[2]?.response_format?.type, "json_schema");
	ok(bodies[2]?.response_format?.json_schema?.schema?.properties?.verdict !== undefined);
});

test("a model without schema support keeps the prompt-only repair with its tools", { timeout: 15_000 }, async () => {
	const { result, bodies } = await runReviewer([read, { text: MARKDOWN_REVIEW }, { text: REPORT }], "none");
	strictEqual(result.exitCode, 0);
	strictEqual(bodies[2]?.response_format, undefined);
	ok((bodies[2]?.tools ?? []).length > 0, "an advisory repair keeps its tools");
	ok(JSON.stringify(bodies[1]?.messages.at(-1)).includes("[result contract: verifier-report]"));
});

test("a server that refuses the schema gets the same round once without it", { timeout: 15_000 }, async () => {
	const { result, bodies } = await runReviewer(
		[
			read,
			{ text: MARKDOWN_REVIEW },
			{ status: 400, error: "400 response_format json_schema is not supported" },
			{ text: REPORT },
		],
		"json-schema",
	);
	strictEqual(result.exitCode, 0);
	strictEqual(bodies.length, 4);
	strictEqual(bodies[2]?.response_format?.type, "json_schema");
	strictEqual(bodies[3]?.response_format, undefined);
	strictEqual((bodies[3]?.tools ?? []).length, 0);
});

test("each tool round extends the previous request byte for byte, its reminder included (Astra #5)", {
	timeout: 15_000,
}, async () => {
	const { result, bodies } = await runReviewer([read, read, { text: REPORT }], "none");
	strictEqual(result.exitCode, 0);
	strictEqual(bodies.length, 3);
	const previous = bodies[1]?.messages ?? [];
	deepStrictEqual(bodies[2]?.messages.slice(0, previous.length), previous);
	ok(JSON.stringify(bodies[2]?.messages.at(-1)).includes("[result contract: verifier-report]"));
});

test("a capped reporting worker whose locked replies are only tool-call markup fails as missing output", {
	timeout: 15_000,
}, async () => {
	const markup = { text: '<tool_call>\n{"name":"read","arguments":{"path":"plan.md"}}\n</tool_call>' };
	const { result, bodies, events } = await runReviewer([read, markup, markup], "none", {
		mode: "enforced",
		toolCalls: 1,
		hardCap: 1,
		contract: false,
	});
	const outcomes = events.filter((event) => event.type === "clio_coder_run_outcome");
	strictEqual(result.exitCode, 1, JSON.stringify(outcomes));
	strictEqual(bodies.length, 3, "the markup-only reply is re-prompted exactly once");
	const outcome = outcomes.at(-1) as { payload?: { outcomeCode?: string; detail?: string } } | undefined;
	strictEqual(outcome?.payload?.outcomeCode, "worker_final_output_missing");
	ok(outcome?.payload?.detail?.includes("only tool-call markup"), outcome?.payload?.detail);
});

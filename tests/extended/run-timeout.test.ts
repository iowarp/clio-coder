import { match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type HeadlessScratch, headlessScratch, runCli, sealedReceipt } from "../harness/headless-run.js";
import { closeServer, seedOpenAICompatToolOrchestrator } from "../harness/openai-compat-fixture.js";

type Step = { kind: "tool"; name: string; arguments: Record<string, unknown> } | { kind: "stall" } | { kind: "text" };

/**
 * An OpenAI-compatible provider that walks `steps` by the number of tool
 * results already in the conversation. A `stall` step sends the stream headers
 * and then nothing, holding the response open until the server closes; no
 * timer is involved, so the test process is never kept alive by it.
 */
async function scriptedProvider(steps: ReadonlyArray<Step>): Promise<{ server: Server; url: string; streams: number }> {
	const state = { streams: 0 };
	const server = createServer(async (request: IncomingMessage, response) => {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.statusCode = 404;
			response.end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { stream?: boolean; messages?: Array<{ role?: string }> };
		if (payload.stream === false) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "probe" } }] }));
			return;
		}
		state.streams += 1;
		const step = steps[(payload.messages ?? []).filter((message) => message.role === "tool").length] ?? {
			kind: "text",
		};
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (step.kind === "stall") {
			response.flushHeaders();
			return;
		}
		const delta =
			step.kind === "tool"
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call-${step.name}`,
								type: "function",
								function: { name: step.name, arguments: JSON.stringify(step.arguments) },
							},
						],
					}
				: { role: "assistant", content: "finished" };
		response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
		response.write(
			`data: ${JSON.stringify({
				choices: [{ index: 0, delta: {}, finish_reason: step.kind === "tool" ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		server,
		url,
		get streams() {
			return state.streams;
		},
	};
}

describe("clio-coder run --timeout", () => {
	const servers: Server[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => closeServer(server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	async function headlessTurn(steps: ReadonlyArray<Step>, autonomy: string, flags: ReadonlyArray<string>) {
		const scratch = headlessScratch("clio-coder-run-timeout-");
		scratches.push(scratch);
		const provider = await scriptedProvider(steps);
		servers.push(provider.server);
		seedOpenAICompatToolOrchestrator(scratch.configDir, provider.url, autonomy);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		const turn = await runCli(
			["--no-context-files", "--no-skills", "run", "--autonomy", autonomy, ...flags, "Apply the change."],
			{ env: scratch.env, cwd: project, timeoutMs: 60_000 },
		);
		return { turn, scratch, provider };
	}

	it("ends a stalled run with exit 124 and a sealed timed_out receipt", async () => {
		const { turn, scratch, provider } = await headlessTurn([{ kind: "stall" }], "auto-edit", ["--timeout", "2"]);
		strictEqual(turn.code, 124, turn.stderr);
		ok(provider.streams >= 1, "the run must have been waiting on the model");
		ok(turn.elapsedMs >= 2_000, `exited before the limit: ${turn.elapsedMs}ms`);
		ok(turn.elapsedMs < 12_000, `took ${turn.elapsedMs}ms to honor a 2s limit`);
		match(turn.stderr, /--timeout 2s elapsed/);
		const { receipt, envelope } = sealedReceipt(scratch.stateDir);
		strictEqual(receipt.outcome, "timed_out");
		strictEqual(receipt.exitCode, 124);
		strictEqual(envelope.status, "interrupted");
		match(receipt.outcomeDetail ?? "", /timed out after 2s \(--timeout\)/);
	});

	it("leaves a run that finishes inside the limit untouched and does not hold the process open", async () => {
		const { turn, scratch } = await headlessTurn([], "auto-edit", ["--timeout", "300"]);
		strictEqual(turn.code, 0, turn.stderr);
		ok(turn.elapsedMs < 30_000, `an unref'd timer must not hold the process: ${turn.elapsedMs}ms`);
		const { receipt } = sealedReceipt(scratch.stateDir);
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.exitCode, 0);
	});

	it("reports a timeout, not a no-op, when --fail-on-noop is also set", async () => {
		// The write is denied at suggest, which would make the run a no-op; the
		// model then stalls, and the timeout is what ends it.
		const { turn, scratch } = await headlessTurn(
			[{ kind: "tool", name: "write", arguments: { path: "c3.txt", content: "x\n" } }, { kind: "stall" }],
			"suggest",
			["--timeout", "2", "--fail-on-noop"],
		);
		strictEqual(turn.code, 124, turn.stderr);
		const { receipt } = sealedReceipt(scratch.stateDir);
		strictEqual(receipt.outcome, "timed_out");
		notStrictEqual(receipt.outcomeDetail, "noop");
		strictEqual(receipt.noop, true);
		ok((receipt.safety?.blockedAttempts.length ?? 0) > 0);
	});

	it("treats a missing, non-positive, or non-numeric value as a usage error", async () => {
		const scratch = headlessScratch("clio-coder-run-timeout-usage-");
		scratches.push(scratch);
		for (const value of ["0", "-3", "abc", "Infinity"]) {
			const turn = await runCli(["run", "--timeout", value, "task"], { env: scratch.env, cwd: scratch.root });
			strictEqual(turn.code, 2, `${value}: ${turn.stderr}`);
			match(turn.stderr, /--timeout must be a positive number of seconds/);
		}
		const missing = await runCli(["run", "--timeout"], { env: scratch.env, cwd: scratch.root });
		strictEqual(missing.code, 2, missing.stderr);
		match(missing.stderr, /--timeout requires a value/);
		const agent = await runCli(["run", "--timeout", "5", "--agent", "coder", "task"], {
			env: scratch.env,
			cwd: scratch.root,
		});
		strictEqual(agent.code, 2, agent.stderr);
		match(agent.stderr, /--timeout applies to the main agent, not --agent dispatch/);
	});
});

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import {
	type CapturedRequest,
	contextElements,
	startCaptureServer,
	tappedCli,
	wireElements,
} from "../harness/context-capture.js";
import { headlessScratch, runCli } from "../harness/headless-run.js";
import { seedOpenAICompatToolOrchestrator } from "../harness/openai-compat-fixture.js";

/**
 * ContextFold surface capture through the real entry points: the built CLI's `clio-coder run` and `clio-coder acp`
 * as subprocesses against the capture server. These run the bundle in dist/, so they belong to the full tier, whose
 * pretest refuses a dist/ built from another commit; the core tier runs from source and would test a stale bundle.
 */

describe("surface capture", () => {
	for (const surface of ["headless run", "acp"] as const) {
		it(`${surface}: every adapter payload carries the context its attempt seam finalized`, {
			timeout: 300_000,
		}, async (t) => {
			const server = await startCaptureServer((_request, index) =>
				index === 0 ? { calls: [{ id: "call_1", name: "read", arguments: { path: "notes.txt" } }] } : { text: "done" },
			);
			const scratch = headlessScratch("cf-capture-");
			t.after(async () => {
				await server.close();
				scratch.cleanup();
			});
			seedOpenAICompatToolOrchestrator(scratch.configDir, server.url, "yolo");
			const project = path.join(scratch.root, "project");
			mkdirSync(project);
			writeFileSync(path.join(project, "notes.txt"), "body a\n");
			const tapFile = path.join(scratch.root, "session-capture.jsonl");
			const cli = tappedCli(tapFile);
			const prompt = "read notes.txt";
			if (surface === "headless run") {
				const result = await runCli(["--no-context-files", "--no-skills", "run", prompt], {
					env: scratch.env,
					cwd: project,
					timeoutMs: 240_000,
					...cli,
				});
				strictEqual(result.code, 0, result.stderr);
			} else {
				const env = Object.fromEntries(
					Object.entries(scratch.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
				);
				const acp = createStdioTransport(
					process.execPath,
					[...cli.node, cli.cli, "--no-context-files", "--no-skills", "acp"],
					{
						cwd: project,
						env,
					},
				);
				t.signal.addEventListener("abort", () => void acp.forceTerminate(), { once: true });
				try {
					await acp.request("initialize", { protocolVersion: 1 });
					const { sessionId } = await acp.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
					const turn = await acp.request<{ stopReason: string }>("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text: prompt }],
					});
					strictEqual(turn.stopReason, "end_turn");
				} finally {
					await acp.forceTerminate();
				}
			}
			const tapped = readFileSync(tapFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Context);
			ok(server.requests.length >= 2, "the tool round and the answer both reached the server");
			ok(wireElements(server.requests.at(-1) as CapturedRequest).some((element) => element.startsWith("result:")));
			deepStrictEqual(server.requests.map(wireElements), tapped.map(contextElements));
		});
	}
});

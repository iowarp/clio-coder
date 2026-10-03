import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { closeServer, readRequestBody, seedOpenAICompatToolOrchestrator } from "../harness/openai-compat-fixture.js";
import { readRunJournal } from "../harness/run-journal.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;
const SOURCE = "coords = [0, 1, 3]\n";
const EXPLANATION =
	"grid.py:1 defines coords = [0, 1, 3], so the spacing is three explicit coordinates. The type conversion, differentiator selection and coefficient code are absent from this fixture, so none is cited. No files changed.";
const REPORT = JSON.stringify({
	mutatedPaths: [],
	validations: [
		{ name: "read grid.py", passed: true, evidence: "grid.py:1 defines coords = [0, 1, 3]; no command ran." },
	],
	summary: EXPLANATION,
});

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			child.kill("SIGTERM");
		}, 30_000);
		const hardTimer = setTimeout(() => child.kill("SIGKILL"), 35_000);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			clearTimeout(hardTimer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			clearTimeout(hardTimer);
			if (expired) reject(new Error(`bounded fixture timed out\n${stdout}\n${stderr}`));
			else resolve({ code, stdout, stderr });
		});
	});
}

// Scripted loopback models exercise the real parent, worker repair loop, and
// sealed receipts. They prove transport/settlement, not live model reliability.
for (const scenario of ["dependent-repair", "exhausted"] as const) {
	test(`built Documenter recovery: ${scenario}`, { timeout: 60_000 }, async (t) => {
		const scratch = makeScratchHome("clio-coder-documenter-recovery-");
		const requests: Array<{ role: string; history: string }> = [];
		const fixtureErrors: string[] = [];
		let documenterRounds = 0;
		let parentRounds = 0;
		let final = "";
		const server = createServer(async (req, res) => {
			if (req.method === "GET" && req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }));
				return;
			}
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
				res.writeHead(404);
				res.end();
				return;
			}
			const body = JSON.parse(await readRequestBody(req)) as {
				messages?: Array<{ role: string; content?: unknown }>;
				stream?: boolean;
			};
			const system = JSON.stringify(body.messages?.filter((m) => m.role === "system"));
			const history = JSON.stringify(body.messages);
			const role = system.includes("# Documenter") ? "documenter" : system.includes("# Scout") ? "scout" : "parent";
			requests.push({ role, history });
			let text = "fixture probe";
			let tool: { name: string; arguments: Record<string, unknown> } | null = null;
			try {
				if (body.stream !== false) {
					const intent = { read_roots: ["grid.py"], write_roots: [] };
					const docTask = {
						agent: "documenter",
						intent,
						task:
							"Explain the spacing type, differentiator selection, and coefficient calculation in 150-200 words with file:line citations. Do not edit files.",
					};
					if (role === "parent") {
						parentRounds += 1;
						if (parentRounds === 1) {
							tool = {
								name: "dispatch",
								arguments: {
									mode: "pipeline",
									tasks: [{ agent: "scout", intent, task: "Read grid.py and identify its coordinate representation." }, docTask],
								},
							};
						} else {
							// A conforming result arrives inline in the compact line; the
							// delivery guidance rides only on the full labels of a run that failed.
							if (scenario !== "exhausted") {
								match(history, /documenter · run [a-z0-9]+ · mutation-report/u);
								match(history, /three explicit coordinates/u);
							} else {
								match(history, /terminal Documenter result/u);
								match(history, /do not repeatedly read/u);
								match(history, /outcome=failed/u);
							}
							const ids = [
								...new Set([...history.matchAll(/runs=([a-z0-9, ]+)/gu)].flatMap((m) => m[1]?.split(/, */u) ?? [])),
							];
							strictEqual(ids.length, 2);
							const outcomes =
								scenario === "exhausted"
									? "Scout succeeded; Documenter failed after its bounded result repairs. The requested explanation is unavailable."
									: "Scout and dependent Documenter succeeded.";
							final = `${outcomes} Run IDs: ${ids.join(", ")}.${scenario === "exhausted" ? "" : ` ${EXPLANATION}`}`;
							text = final;
						}
					} else if (!body.messages?.some((m) => m.role === "tool")) {
						tool = { name: "read", arguments: { path: "grid.py", offset: 1, limit: 1 } };
					} else if (role === "scout") {
						text = JSON.stringify({
							findings: [{ claim: "coords holds three coordinates", path: "grid.py", line: 1 }],
							needsSplit: false,
							proposedSubtasks: [],
						});
					} else {
						documenterRounds += 1;
						match(system, /summary.*explanation/u);
						if (documenterRounds === 1 || scenario === "exhausted") text = "invalid Documenter result";
						else {
							match(history, /clio-result-contract-repair-1/u);
							match(history, /16384 UTF-8 bytes/u);
							match(history, /Preserve the requested explanation/u);
							text = REPORT;
						}
					}
				}
			} catch (error) {
				fixtureErrors.push(String(error));
				text = "fixture assertion failed";
			}
			const message = tool
				? {
						role: "assistant",
						tool_calls: [
							{
								id: `fixture-${requests.length}`,
								type: "function",
								function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
							},
						],
					}
				: { role: "assistant", content: text };
			const finish = tool ? "tool_calls" : "stop";
			if (body.stream === false) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({ id: "fixture", model: "mock-model", choices: [{ index: 0, message, finish_reason: finish }] }),
				);
			} else {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const delta = tool
					? { ...message, tool_calls: message.tool_calls?.map((call) => ({ index: 0, ...call })) }
					: message;
				for (const choice of [
					{ index: 0, delta },
					{ index: 0, delta: {}, finish_reason: finish },
				]) {
					res.write(
						`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "mock-model", choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
					);
				}
				res.end("data: [DONE]\n\n");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const workspace = join(scratch.dir, "workspace");
			mkdirSync(workspace);
			writeFileSync(join(workspace, "grid.py"), SOURCE);
			const env = {
				...process.env,
				...scratch.env,
				TMPDIR: scratch.dir,
				NODE_ENV: "test",
				CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
			};
			const doctor = await run(["doctor", "--fix"], workspace, env);
			strictEqual(doctor.code, 0, doctor.stderr);
			seedOpenAICompatToolOrchestrator(
				join(scratch.dir, "config"),
				`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				"yolo",
			);
			const result = await run(
				[
					"run",
					"--json",
					"--autonomy",
					"yolo",
					"Use a read-only Scout then Documenter pipeline for grid.py; report the explanation or a precise limitation.",
				],
				workspace,
				env,
			);
			deepStrictEqual(fixtureErrors, [], result.stderr);
			// A Documenter that exhausts its repairs is a dispatched worker that did not deliver.
			strictEqual(result.code, scenario === "exhausted" ? 1 : 0, result.stderr);
			doesNotMatch(result.stderr, /receipt write failed/u);
			strictEqual(readFileSync(join(workspace, "grid.py"), "utf8"), SOURCE);
			strictEqual(parentRounds, 2);
			strictEqual(documenterRounds, scenario === "exhausted" ? 3 : 2);
			const journal = readRunJournal(join(scratch.dir, "state"));
			ok(journal);
			strictEqual(journal.receipts.length, 3);
			for (const receipt of journal.receipts) {
				const envelope = journal.envelopes.get(receipt.runId);
				ok(envelope);
				ok(verifyReceiptIntegrity(receipt, envelope).ok);
				ok(envelope.endedAt);
				ok(!["running", "queued", "stale"].includes(envelope.status));
			}
			const doc = journal.receipts.find((r) => r.agentId === "documenter");
			const parent = journal.receipts.find((r) => r.agentId === "main-agent");
			const scout = journal.receipts.find((r) => r.agentId === "scout");
			ok(doc && parent && scout);
			strictEqual(scout.outcome, "succeeded");
			strictEqual(doc.outcome, scenario === "exhausted" ? "failed" : "succeeded");
			strictEqual(doc.quality.resultContract?.conformance, scenario === "exhausted" ? "fail" : "pass");
			strictEqual(doc.output?.text, scenario === "exhausted" ? "invalid Documenter result" : REPORT);
			const wire = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string;
							delta?: string;
							message?: { role?: string; stopReason?: string; content?: Array<{ type: string; textLength?: number }> };
						},
				);
			strictEqual(
				wire
					.filter((event) => event.type === "text_delta")
					.map((event) => event.delta)
					.join(""),
				final,
			);
			const terminal = wire
				.filter(
					(event) =>
						event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "stop",
				)
				.at(-1);
			strictEqual(terminal?.message?.content?.find((part) => part.type === "text")?.textLength, final.length);
			strictEqual(parent.outcome, scenario === "exhausted" ? "failed" : "succeeded");
			strictEqual(doc.toolActivity?.mutatingSucceeded, false);
			strictEqual(doc.exitCode, scenario === "exhausted" ? 1 : 0);
			strictEqual(parent.toolStats.find((s) => s.tool === "monitor")?.count ?? 0, 0);
			ok(doc.pipeline, "the intended dependent Documenter must actually run in the pipeline");
			t.diagnostic(
				JSON.stringify({
					scenario,
					parentRounds,
					documenterRounds,
					runs: journal.receipts.map((r) => ({
						id: r.runId,
						agent: r.agentId,
						outcome: r.outcome,
						conformance: r.quality.resultContract?.conformance,
					})),
				}),
			);
		} finally {
			await closeServer(server);
			scratch.cleanup();
		}
	});
}

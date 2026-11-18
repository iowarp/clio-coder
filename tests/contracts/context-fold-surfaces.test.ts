import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { ACP_CONTEXT_LEDGER_METHOD } from "../../src/engine/acp/types.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";
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

	for (const surface of ["headless run", "acp"] as const) {
		for (const cached of [false, true]) {
			it(`${surface}: ${cached ? "a cached route sends every superseded read whole" : "an uncached route's payload is the session's after the S0 commit"}`, {
				timeout: 300_000,
			}, async (t) => {
				const server = await startCaptureServer((_request, index) =>
					index < 2
						? { calls: [{ id: `call_${index + 1}`, name: "read", arguments: { path: "notes.txt" } }] }
						: { text: "done" },
				);
				const scratch = headlessScratch("cf-superseded-");
				t.after(async () => {
					await server.close();
					scratch.cleanup();
				});
				seedOpenAICompatToolOrchestrator(scratch.configDir, server.url, "yolo");
				const settingsFile = path.join(scratch.configDir, "settings.yaml");
				// Room for two 34 KiB reads below the trigger, so only S0 can act.
				let yaml = readFileSync(settingsFile, "utf8").replace("contextWindow: 32768", "contextWindow: 262144");
				if (!cached)
					yaml = yaml.replace(
						"    wireModels:\n      - mock-model",
						"    cache:\n      retention: none\n    wireModels:\n      - mock-model",
					);
				writeFileSync(settingsFile, yaml);
				const project = path.join(scratch.root, "project");
				mkdirSync(project);
				const line = `${"n".repeat(67)}\n`;
				writeFileSync(path.join(project, "notes.txt"), line.repeat(Math.ceil((34 * 1024) / line.length)));
				const tapFile = path.join(scratch.root, "session-capture.jsonl");
				const cli = tappedCli(tapFile);
				const prompt = "read notes.txt twice";
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
						{ cwd: project, env },
					);
					t.signal.addEventListener("abort", () => void acp.forceTerminate(), { once: true });
					try {
						await acp.request("initialize", { protocolVersion: 1 });
						const { sessionId } = await acp.request<{ sessionId: string }>("session/new", {
							cwd: project,
							mcpServers: [],
						});
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
					.map((entry) => JSON.parse(entry) as Context);
				strictEqual(server.requests.length, 3, "two read rounds and the answer reached the server");
				const results = wireElements(server.requests.at(-1) as CapturedRequest).filter((element) =>
					element.startsWith("result:"),
				);
				strictEqual(results.length, 2);
				const sent = server.requests.map(wireElements);
				if (cached) {
					ok(
						sent.every((elements) => elements.every((element) => !element.includes("reason=superseded_call"))),
						"no superseded marker on a cached route",
					);
					strictEqual(results[0], results[1], "both reads reach the model whole");
				} else {
					ok(results[0]?.startsWith("result:[evicted ref=r1 reason=superseded_call by="), results[0]?.slice(0, 200));
					ok((results[1]?.length ?? 0) > 34 * 1024, "the covering read stays whole");
				}
				deepStrictEqual(sent, tapped.map(contextElements), "the adapter payloads are the session's requests");
			});
		}
	}

	for (const surface of ["headless run", "acp"] as const) {
		it(`${surface}: a host insert survives a rebuild and a reopen once, where live held it`, {
			timeout: 300_000,
		}, async (t) => {
			// A work turn that ends with its board open is carried on by the open-tasks nudge: an in-run host insert.
			const server = await startCaptureServer((_request, index) =>
				index === 0
					? {
							calls: [{ id: "call_1", name: "tasks", arguments: { action: "plan", title: "Board", tasks: ["one", "two"] } }],
						}
					: { text: `answer ${index}` },
			);
			const scratch = headlessScratch("cf-insert-");
			t.after(async () => {
				await server.close();
				scratch.cleanup();
			});
			seedOpenAICompatToolOrchestrator(scratch.configDir, server.url, "yolo");
			const project = path.join(scratch.root, "project");
			mkdirSync(project);
			const tapFile = path.join(scratch.root, "session-capture.jsonl");
			const cli = tappedCli(tapFile);
			const prompts = ["work through the board", "after a rebuild", "after a reopen"];
			if (surface === "headless run") {
				// Each later run is a fresh process that rebuilds its live history from the ledger.
				for (const [index, prompt] of prompts.entries()) {
					const result = await runCli(
						["--no-context-files", "--no-skills", "run", ...(index > 0 ? ["--continue"] : []), prompt],
						{ env: scratch.env, cwd: project, timeoutMs: 240_000, ...cli },
					);
					strictEqual(result.code, 0, result.stderr);
				}
			} else {
				const env = Object.fromEntries(
					Object.entries(scratch.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
				);
				const open = () =>
					createStdioTransport(process.execPath, [...cli.node, cli.cli, "--no-context-files", "--no-skills", "acp"], {
						cwd: project,
						env,
					});
				let sessionId = "";
				const prompt = async (acp: ReturnType<typeof open>, text: string) => {
					const turn = await acp.request<{ stopReason: string }>("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text }],
					});
					strictEqual(turn.stopReason, "end_turn");
				};
				// One session per process: each later prompt is a fresh process that loads the session from the ledger.
				for (const [index, text] of prompts.entries()) {
					const acp = open();
					t.signal.addEventListener("abort", () => void acp.forceTerminate(), { once: true });
					try {
						await acp.request("initialize", { protocolVersion: 1 });
						if (index === 0)
							({ sessionId } = await acp.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] }));
						else await acp.request("session/load", { sessionId, cwd: project, mcpServers: [] });
						await prompt(acp, text);
					} finally {
						await acp.forceTerminate();
					}
				}
			}
			const requests = server.requests.map(wireElements);
			// The system prompt is recompiled per process; the conversation is what the ledger rebuilds.
			const conversation = requests.map((elements) => elements.filter((element) => !element.startsWith("system:")));
			const isInsert = (element: string) => element.startsWith("user:<system-reminder>\n[Clio Coder] Task board");
			const liveAt = conversation.findIndex((elements) => elements.some(isInsert));
			ok(liveAt > 0, "the nudge's insert reached the live request");
			const live = conversation[liveAt] ?? [];
			strictEqual(live.filter(isInsert).length, 1, "live carries it once");
			const later = conversation.slice(liveAt + 1);
			ok(later.length >= 2, "the rebuilt request and the reopened request were captured");
			for (const elements of later) {
				strictEqual(elements.filter(isInsert).length, 1, "each later request carries it once");
				deepStrictEqual(elements.slice(0, live.length), live, "at the position live held it");
			}
			const tapped = readFileSync(tapFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => contextElements(JSON.parse(line) as Context));
			deepStrictEqual(tapped, requests, "the adapter payloads are the captured requests");
		});
	}

	it("headless run: `context working-set --verify` matches every main attempt to its receipt across an eviction and a checkpoint (ContextFold CF-9, F14)", {
		timeout: 300_000,
	}, async (t) => {
		const turns: Record<string, string[]> = {
			"read the first notes": ["a.txt", "b.txt", "c.txt", "d.txt"],
			"read the later notes": ["e.txt", "f.txt"],
		};
		// A request without tools is the summary call; a turn reads its files one call at a time.
		const server = await startCaptureServer((request) => {
			if (!Array.isArray(request.body.tools)) return { text: syntheticCompactionSummary("read the notes") };
			const elements = wireElements(request);
			let opened = elements.length - 1;
			while (
				opened >= 0 &&
				!(elements[opened]?.startsWith("user:") && Object.keys(turns).some((prompt) => elements[opened]?.includes(prompt)))
			)
				opened -= 1;
			const files = Object.entries(turns).find(([prompt]) => elements[opened]?.includes(prompt))?.[1] ?? [];
			const reads = elements.slice(opened + 1).filter((element) => element.startsWith("result:")).length;
			const next = files[reads];
			return next ? { calls: [{ id: `call_${next}`, name: "read", arguments: { path: next } }] } : { text: "done" };
		});
		const scratch = headlessScratch("cf-verify-");
		t.after(async () => {
			await server.close();
			scratch.cleanup();
		});
		seedOpenAICompatToolOrchestrator(scratch.configDir, server.url, "yolo");
		const project = path.join(scratch.root, "project");
		mkdirSync(project);
		const line = `${"n".repeat(67)}\n`;
		for (const file of Object.values(turns).flat())
			writeFileSync(path.join(project, file), line.repeat(Math.ceil((22 * 1024) / line.length)));
		// The first run evicts under a short protected tail; the second, without the working set, checkpoints.
		const settingsFile = path.join(scratch.configDir, "settings.yaml");
		const settings = [
			(yaml: string) => yaml.replace("    protectLastSteps: 8", "    protectLastSteps: 2"),
			(yaml: string) => yaml.replace(/(\n {2}workingSet:\n(?: {4}.*\n)*?) {4}enabled: true\n/, "$1    enabled: false\n"),
		];
		for (const [index, prompt] of Object.keys(turns).entries()) {
			const yaml = readFileSync(settingsFile, "utf8");
			const changed = settings[index]?.(yaml) ?? yaml;
			ok(changed !== yaml, "the settings edit applied");
			writeFileSync(settingsFile, changed);
			const result = await runCli(
				["--no-context-files", "--no-skills", "run", ...(index > 0 ? ["--continue"] : []), prompt],
				{ env: scratch.env, cwd: project, timeoutMs: 240_000 },
			);
			strictEqual(result.code, 0, result.stderr);
		}
		const sessionsRoot = path.join(scratch.stateDir, "sessions");
		const [cwdHash = ""] = readdirSync(sessionsRoot);
		const [id = ""] = readdirSync(path.join(sessionsRoot, cwdHash));
		const kinds = readFileSync(path.join(sessionsRoot, cwdHash, id, "current.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((entry) => (JSON.parse(entry) as { kind?: string }).kind);
		ok(kinds.includes("contextEviction") && kinds.includes("compactionSummary"), "the session folded both ways");
		const verify = await runCli(["context", "working-set", "--verify", id], { env: scratch.env, cwd: project });
		strictEqual(verify.code, 0, verify.stdout + verify.stderr);
		const attempts = verify.stdout.split("\n").filter((row) => / attempt \d+: /u.test(row));
		const main = attempts.filter((row) => row.includes(" main attempt "));
		ok(main.length >= 8, verify.stdout);
		deepStrictEqual(
			main.filter((row) => !row.endsWith(": verified")),
			[],
			"every main attempt is verified",
		);
		ok(
			attempts.some((row) => row.endsWith(": not-verifiable (summary call)")),
			verify.stdout,
		);
		ok(verify.stdout.includes("fold decisions: 0 missing, 0 duplicate, 0 orphan"), verify.stdout);
	});

	it("acp: usage_update and /context read one figure after an eviction and after a reopen", {
		timeout: 300_000,
	}, async (t) => {
		const server = await startCaptureServer((_request, index) =>
			index < 2
				? { calls: [{ id: `call_${index + 1}`, name: "read", arguments: { path: "notes.txt" } }] }
				: { text: "done" },
		);
		const scratch = headlessScratch("cf-usage-");
		t.after(async () => {
			await server.close();
			scratch.cleanup();
		});
		seedOpenAICompatToolOrchestrator(scratch.configDir, server.url, "yolo");
		const settingsFile = path.join(scratch.configDir, "settings.yaml");
		// The uncached route above: the second read supersedes the first, and S0 commits an eviction mid-turn.
		writeFileSync(
			settingsFile,
			readFileSync(settingsFile, "utf8")
				.replace("contextWindow: 32768", "contextWindow: 262144")
				.replace(
					"    wireModels:\n      - mock-model",
					"    cache:\n      retention: none\n    wireModels:\n      - mock-model",
				),
		);
		const project = path.join(scratch.root, "project");
		mkdirSync(project);
		const line = `${"n".repeat(67)}\n`;
		writeFileSync(path.join(project, "notes.txt"), line.repeat(Math.ceil((34 * 1024) / line.length)));
		const env = Object.fromEntries(
			Object.entries(scratch.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
		const cli = tappedCli(path.join(scratch.root, "session-capture.jsonl"));
		let sessionId = "";
		const figures: Array<{ used: number; ledger: number }> = [];
		for (const reopen of [false, true]) {
			const acp = createStdioTransport(
				process.execPath,
				[...cli.node, cli.cli, "--no-context-files", "--no-skills", "acp"],
				{
					cwd: project,
					env,
				},
			);
			t.signal.addEventListener("abort", () => void acp.forceTerminate(), { once: true });
			const used: number[] = [];
			acp.onNotification("session/update", (params) => {
				const update = (params as { update?: { sessionUpdate?: string; used?: number } }).update;
				if (update?.sessionUpdate === "usage_update" && typeof update.used === "number") used.push(update.used);
			});
			try {
				await acp.request("initialize", { protocolVersion: 1 });
				if (!reopen) {
					({ sessionId } = await acp.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] }));
					const turn = await acp.request<{ stopReason: string }>("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text: "read notes.txt twice" }],
					});
					strictEqual(turn.stopReason, "end_turn");
				} else await acp.request("session/load", { sessionId, cwd: project, mcpServers: [] });
				await new Promise((resolve) => setImmediate(resolve));
				const ledger = await acp.request<{ usedTokens: number }>(ACP_CONTEXT_LEDGER_METHOD, { sessionId });
				ok(used.length > 0, "a usage_update was sent");
				figures.push({ used: used.at(-1) ?? -1, ledger: ledger.usedTokens });
			} finally {
				await acp.forceTerminate();
			}
		}
		const results = wireElements(server.requests.at(-1) as CapturedRequest).filter((element) =>
			element.startsWith("result:"),
		);
		ok(results[0]?.startsWith("result:[evicted ref=r1 reason=superseded_call by="), "the S0 eviction committed");
		const [live, reopened] = figures;
		ok(live && reopened && live.used > 0);
		strictEqual(live.used, live.ledger, "usage_update and /context read one figure after the eviction");
		// The capture server reports 10 input tokens per call; the view prices the retained 34 KiB read instead.
		ok(live.used > (34 * 1024) / 4, `usage_update reads the view, not the provider's report: ${live.used}`);
		strictEqual(reopened.used, reopened.ledger, "and after the reopen");
	});
});

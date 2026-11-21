import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { requestFits } from "../../src/domains/context/budget/request-fit.js";
import { createWorkerContextGuard, WorkerContextExhaustedError } from "../../src/domains/context/worker/pressure.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { estimateAgentContextBreakdown } from "../../src/domains/session/context-accounting.js";
import {
	recommendedOutputTokens,
	requestOutputReserve,
	setGlobalDefaultMaxOutputTokens,
} from "../../src/engine/apis/output-budget.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { startWorkerRun, type WorkerRunHandle } from "../../src/engine/worker-runtime.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const scenarios = [
	{ name: "trusted project, low", level: "low", project: 16384, trust: true, expected: 16384 },
	{ name: "trusted project, medium", level: "medium", project: 16384, trust: true, expected: 16384 },
	{ name: "trusted project, xhigh", level: "xhigh", project: 16384, trust: true, expected: 16384 },
	{ name: "trusted local override", level: "low", project: 16384, local: 12288, trust: true, expected: 12288 },
	{ name: "untrusted project", level: "low", project: 16384, trust: false, expected: 8192 },
	{ name: "changed project after trust", level: "low", project: 16384, trust: true, changed: true, expected: 8192 },
	{ name: "malformed trusted project", level: "low", malformed: true, trust: true, expected: 8192 },
	{ name: "user settings only", level: "low", trust: false, expected: 8192 },
] as const;

for (const scenario of scenarios) {
	test(`worker request honors output settings: ${scenario.name}`, { timeout: 10000 }, async () => {
		const env = await isolateClioEnv("clio-coder-worker-output-settings-");
		const workspace = join(env.dir, "project");
		const requests: Array<Record<string, unknown>> = [];
		let worker: WorkerRunHandle | undefined;
		const server = createServer(async (req, res) => {
			requests.push(JSON.parse(await readRequestBody(req)) as Record<string, unknown>);
			res.setHeader("content-type", "text/event-stream");
			res.end(
				`data: ${JSON.stringify({ model: "dynamo/qwen3.8-27b", choices: [{ index: 0, delta: { content: "Complete." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		try {
			mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
			mkdirSync(join(env.dir, "config"), { recursive: true });
			const user = structuredClone(DEFAULT_SETTINGS);
			user.chat.maxOutputTokens = 8192;
			writeFileSync(join(env.dir, "config/settings.yaml"), JSON.stringify(user));
			const projectFile = join(workspace, ".clio-coder/settings.yaml");
			if ("project" in scenario)
				writeFileSync(projectFile, JSON.stringify({ version: 2, chat: { maxOutputTokens: scenario.project } }));
			if ("local" in scenario)
				writeFileSync(
					join(workspace, ".clio-coder/settings.local.yaml"),
					JSON.stringify({ version: 2, chat: { maxOutputTokens: scenario.local } }),
				);
			if ("malformed" in scenario) writeFileSync(projectFile, "chat: [broken\n");
			if (scenario.trust) {
				const snapshot = captureProjectSurface(workspace, "settings");
				ok(snapshot.contentHash);
				recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
			}
			if ("changed" in scenario)
				writeFileSync(projectFile, JSON.stringify({ version: 2, chat: { maxOutputTokens: 24576 } }));
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			worker = startWorkerRun(
				{
					agentId: "output-settings-fixture",
					systemPrompt: "Reply Complete.",
					task: "Finish.",
					target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
					runtime: litellm,
					wireModelId: "dynamo/qwen3.8-27b",
					apiKey: "fixture",
					thinkingLevel: scenario.level,
					modelCapabilities: { contextWindow: 131072, maxTokens: 131072, tools: true },
					allowedTools: [],
					budget: { mode: "advisory", toolCalls: 40, synthesis: true, hardCap: 60 },
					product: "orientation",
					noSkills: true,
					cwd: workspace,
				},
				() => {},
			);
			strictEqual((await worker.promise).exitCode, 0);
			strictEqual(requests.length, 1);
			strictEqual(requests[0]?.max_tokens, scenario.expected);
			strictEqual(requests[0]?.reasoning_effort, scenario.level);
			deepStrictEqual(requests[0]?.allowed_openai_params, ["reasoning_effort"]);
		} finally {
			worker?.abort();
			await worker?.promise;
			await closeServer(server);
			setGlobalDefaultMaxOutputTokens(DEFAULT_SETTINGS.chat.maxOutputTokens);
			env.restore();
		}
	});
}

test("worker pressure admits what main-loop admission admits and keeps input room under a window-sized recommendation (D5, D1-5)", () => {
	const user = (chars: number): AgentMessage => ({
		role: "user",
		content: [{ type: "text", text: "x".repeat(chars) }],
		timestamp: 0,
	});
	const admits = (model: { api: string }, window: number, messages: AgentMessage[]): boolean => {
		try {
			createWorkerContextGuard(() => "unused")({
				messages,
				systemPrompt: "",
				tools: [],
				contextWindow: window,
				outputReserve: (tokens) => requestOutputReserve(model, undefined, window, tokens),
			});
			return true;
		} catch (error) {
			if (error instanceof WorkerContextExhaustedError) return false;
			throw error;
		}
	};
	try {
		// A profile recommending the whole serving window must not collapse the pressure ceiling (D5).
		setGlobalDefaultMaxOutputTokens(0);
		const wide = { api: "openai-completions", clioCoder: { quirks: { outputTokens: 131072 } } };
		strictEqual(recommendedOutputTokens(wide, 131072), 65536);
		ok(admits(wide, 131072, [user(40_000)]), "a 10K-token request must fit a 131072-token window");
		// On a wire-clamped transport the worker admits exactly what the main loop's fit check admits (D1-5);
		// a fixed quarter-window reserve used to refuse a 100K-token fork the parent had admitted.
		const model = { api: "openai-completions" };
		const window = 131072;
		let admittedAboveFixedReserve = false;
		for (const chars of [392_000, 400_000, 416_000, 424_000]) {
			const messages = [user(chars)];
			const tokens = Object.values(estimateAgentContextBreakdown({ systemPrompt: "", tools: [], messages })).reduce(
				(sum, value) => sum + value,
				0,
			);
			const parent =
				tokens <= Math.floor(window * 0.8) &&
				requestFits(tokens, requestOutputReserve(model, undefined, window, tokens), window);
			strictEqual(admits(model, window, messages), parent, `${tokens}-token request`);
			if (parent && tokens > window - window / 4) admittedAboveFixedReserve = true;
		}
		ok(admittedAboveFixedReserve, "the worker still reserves the full output budget the wire would clamp");
	} finally {
		setGlobalDefaultMaxOutputTokens(DEFAULT_SETTINGS.chat.maxOutputTokens);
	}
});

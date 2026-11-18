import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { entryRootEnv, entryRoots } from "../../src/domains/campaign/fold.js";
import { foldCampaignMetrics, parseRoster } from "../../src/domains/campaign/index.js";
import type { CampaignResult } from "../../src/domains/campaign/runner.js";
import type { Interview } from "../../src/domains/extensions/public-api-v2.js";
import {
	CLAUDE_AGENT_SDK_VERSION,
	ClaudeAgentSdkUnavailableError,
} from "../../src/domains/lifecycle/claude-sdk-install.js";
import {
	COPILOT_SDK_PACKAGE,
	COPILOT_SDK_VERSION,
	CopilotSdkUnavailableError,
	resolveCopilotSdkEntry,
} from "../../src/domains/lifecycle/copilot-sdk-install.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { runParkedInterview } from "../../src/tools/extension-interview.js";
import { type HeadlessScratch, headlessScratch } from "../harness/headless-run.js";
import {
	closeServer,
	hasToolExchange,
	type OpenAICompatFixture,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const DESK_MANIFEST = {
	id: "desk",
	name: "desk",
	version: "1.0.0",
	description: "A desk with one gate",
	runtime: {
		api: 2,
		entrypoint: "extension.mjs",
		tools: [
			{ name: "gate", description: "Ask the author a gate", actionClass: "execute", inputSchema: { type: "object" } },
		],
		ui: ["interview"],
	},
};
const DESK_SOURCE = `export default (api) => {
	api.tool("gate", () => ({ text: "asking", interview: { id: "gate", title: "Gate", step: { key: "s1", questions: [
		{ id: "choice", label: "Approve the introduction plan?", kind: "single", checkpoint: "plan-introduction",
			options: [{ value: "approve", label: "Approve" }, { value: "keep", label: "Keep" }] } ] } } }));
	api.interview("gate", () => ({ done: true, text: "sealed" }));
};
`;

const ENTRY = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

function cli(
	args: ReadonlyArray<string>,
	options: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ENTRY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

describe("campaign run folds one fixture across a roster", { timeout: 240_000 }, () => {
	let scratch: HeadlessScratch;
	let chat: OpenAICompatFixture;
	let fixture: string;

	before(async () => {
		scratch = headlessScratch("clio-campaign-");
		// The model asks the desk's gate once, then answers; the answers file approves it.
		chat = await startOpenAICompatFixture("Done.", {
			toolCall: (request) =>
				hasToolExchange(request)
					? null
					: { name: "gateway", arguments: { op: "call", capability: "extension_desk__gate", args: {} } },
		});
		seedOpenAICompatToolOrchestrator(scratch.configDir, chat.url);
		const desk = join(scratch.root, "desk");
		mkdirSync(desk);
		writeFileSync(join(desk, "clio-coder-extension.json"), JSON.stringify(DESK_MANIFEST));
		writeFileSync(join(desk, "extension.mjs"), DESK_SOURCE);
		const installed = await cli(["extensions", "install", desk, "--user"], { env: scratch.env, cwd: scratch.root });
		strictEqual(installed.status, 0, installed.stderr);
		fixture = join(scratch.root, "fixture");
		mkdirSync(join(fixture, ".planning"), { recursive: true });
		writeFileSync(join(fixture, ".planning", "state.json"), '{"phase":"outline"}\n');
		writeFileSync(join(fixture, "README.md"), "# paper\n");
		writeFileSync(
			join(scratch.root, "roster.yaml"),
			"roster:\n  - target: mock-chat\n    model: mock-model\n    label: mock\n  - target: absent-target\n    model: nope\n    thinking: low\n",
		);
		writeFileSync(join(scratch.root, "answers.yaml"), "answers:\n  - id: plan-introduction\n    choice: Approve\n");
	});

	after(async () => {
		await closeServer(chat.server);
		scratch.cleanup();
	});

	it("reports a row per entry with every metric field, a failing entry as failed, and leaves the fixture alone", async () => {
		const out = join(scratch.root, "out");
		const credentials = readFileSync(join(scratch.configDir, "credentials.yaml"), "utf8");
		const result = await cli(
			[
				"campaign",
				"run",
				"--fixture",
				fixture,
				"--roster",
				join(scratch.root, "roster.yaml"),
				"--answers",
				join(scratch.root, "answers.yaml"),
				"--prompt",
				"say done",
				"--out",
				out,
				"--timeout",
				"120",
				"--json",
			],
			{ env: scratch.env, cwd: scratch.root },
		);
		strictEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
		const campaign = JSON.parse(result.stdout) as CampaignResult;
		strictEqual(campaign.entries.length, 2);
		const [mock, broken] = campaign.entries;
		ok(mock && broken);

		strictEqual(mock.label, "mock");
		strictEqual(mock.status, "completed", JSON.stringify(mock));
		strictEqual(mock.exitCode, 0);
		ok(typeof mock.metrics.sessionId === "string", "the completed entry names its session");
		ok(mock.metrics.tokens !== null, "the completed entry carries C2's totals");
		ok(mock.metrics.tokens.calls >= 1);
		deepStrictEqual(mock.metrics.gates, {
			reached: ["plan-introduction"],
			interviews: 1,
			answered: 1,
			unscripted: 0,
			unanswered: 0,
		});
		ok(typeof mock.metrics.tokens.output === "number");

		strictEqual(broken.label, "absent-target/nope@low");
		strictEqual(broken.status, "failed");
		ok(broken.exitCode !== 0 && broken.exitCode !== null);
		ok(broken.error !== null, "a failed entry says why");

		for (const entry of campaign.entries) {
			deepStrictEqual(Object.keys(entry.metrics).sort(), ["gates", "loopGuardBlocks", "refusals", "sessionId", "tokens"]);
			ok(Array.isArray(entry.metrics.gates.reached));
			strictEqual(typeof entry.metrics.refusals.hookBlocks, "number");
			strictEqual(typeof entry.metrics.refusals.toolRefusals, "number");
			strictEqual(typeof entry.metrics.loopGuardBlocks, "number");
			strictEqual(typeof entry.wallMs, "number");
			const saved = JSON.parse(readFileSync(join(entry.dir, "entry.json"), "utf8")) as { label: string; status: string };
			deepStrictEqual([saved.label, saved.status], [entry.label, entry.status]);
			ok(existsSync(join(entry.dir, "project", "README.md")), "each entry works in its own fixture copy");
			ok(!existsSync(join(entry.dir, "home", "config")), "no copy of the operator's config is kept under --out");
		}
		deepStrictEqual(readdirSync(out).sort(), ["01-mock", "02-absent-target-nope-low"]);
		deepStrictEqual(readdirSync(fixture).sort(), [".planning", "README.md"]);
		strictEqual(readFileSync(join(scratch.configDir, "credentials.yaml"), "utf8"), credentials);
		const operatorSessions = existsSync(join(scratch.stateDir, "sessions"))
			? readdirSync(join(scratch.stateDir, "sessions"), { recursive: true }).filter((name) =>
					String(name).endsWith("meta.json"),
				)
			: [];
		deepStrictEqual(operatorSessions, [], "no entry wrote a session into the operator's state");

		const campaignArgs = (roster: string, answers: string, into: string): string[] => [
			"campaign",
			"run",
			"--fixture",
			fixture,
			"--roster",
			join(scratch.root, roster),
			"--answers",
			join(scratch.root, answers),
			"--prompt",
			"say done",
			"--out",
			into,
		];
		const reused = await cli(campaignArgs("roster.yaml", "answers.yaml", out), { env: scratch.env, cwd: scratch.root });
		strictEqual(reused.status, 2, "a used --out is refused before anything runs");

		// A gate the answers file does not script ends the run as unscripted, and the gate still counts as reached.
		writeFileSync(join(scratch.root, "only-mock.yaml"), "roster:\n  - target: mock-chat\n    model: mock-model\n");
		writeFileSync(
			join(scratch.root, "other-answers.yaml"),
			"answers:\n  - id: results-acceptance\n    choice: Approve\n",
		);
		const stopped = await cli(
			[...campaignArgs("only-mock.yaml", "other-answers.yaml", join(scratch.root, "out2")), "--json"],
			{
				env: scratch.env,
				cwd: scratch.root,
			},
		);
		strictEqual(stopped.status, 0, stopped.stderr);
		const [unscripted] = (JSON.parse(stopped.stdout) as CampaignResult).entries;
		ok(unscripted);
		deepStrictEqual([unscripted.status, unscripted.exitCode], ["unscripted", 5]);
		deepStrictEqual(unscripted.metrics.gates, {
			reached: ["plan-introduction"],
			interviews: 1,
			answered: 0,
			unscripted: 1,
			unanswered: 0,
		});
	});
});

function toolResult(toolName: string, details: Record<string, unknown>, isError = false): SessionEntry {
	return {
		kind: "message",
		role: "tool_result",
		turnId: `t-${Math.random()}`,
		parentTurnId: null,
		timestamp: "2026-11-16T00:00:00.000Z",
		payload: { toolCallId: "c", toolName, isError, result: { content: [], details } },
	} as SessionEntry;
}

function journalRecord(k: string, data: Record<string, unknown>): TelemetryRecord {
	return { k, t: "2026-11-16T00:00:00.000Z", ctx: { sessionId: "s1" }, data } as unknown as TelemetryRecord;
}

describe("campaign metrics fold", () => {
	it("counts gates, extension refusals and loop-guard blocks from the ledger and journal", () => {
		const metrics = foldCampaignMetrics(
			"s1",
			[
				toolResult("gateway", {
					capability: "extension_wtfp__gate",
					interview: { outcome: "done", checkpoints: ["plan-introduction"] },
				}),
				toolResult(
					"extension_wtfp__gate",
					{ interview: { outcome: "cancelled", reason: "unscripted", checkpoints: ["results-acceptance"] } },
					true,
				),
				toolResult("gateway", { capability: "extension_wtfp__record" }, true),
				// The shape an extension tool's error reaches the ledger in through the gateway: owner stamped, details empty.
				{
					...toolResult("gateway", {}, true),
					payload: { toolName: "gateway", isError: true, owner: { kind: "extension", id: "wtfp" }, result: { details: {} } },
				} as SessionEntry,
				toolResult("gateway", { capability: "data" }, true),
			],
			[
				journalRecord("hook.ran", { origin: "extension", hook: "before_tool", effectKinds: ["block_tool"] }),
				journalRecord("hook.ran", { origin: "user", hook: "before_tool", effectKinds: ["block_tool"] }),
				journalRecord("middleware.fired", { ruleId: "guard.loop", effects: ["block_tool"], hook: "before_tool" }),
				journalRecord("middleware.fired", { ruleId: "guard.loop", effects: ["annotate_tool_result"], hook: "after_tool" }),
			],
			null,
		);
		deepStrictEqual(metrics.gates, {
			reached: ["plan-introduction", "results-acceptance"],
			interviews: 2,
			answered: 1,
			unscripted: 1,
			unanswered: 0,
		});
		deepStrictEqual(metrics.refusals, { hookBlocks: 1, toolRefusals: 2 });
		strictEqual(metrics.loopGuardBlocks, 1);
		strictEqual(metrics.tokens, null);
	});

	it("a parked interview names the checkpoints it put to the author", async () => {
		const interview: Interview = {
			id: "gate",
			title: "Gates",
			step: {
				key: "gate.one",
				questions: [
					{
						id: "choice",
						label: "Approve the plan?",
						kind: "single",
						checkpoint: "plan-introduction",
						options: [{ value: "approve", label: "Approve" }],
					},
				],
			},
		};
		const parked = await runParkedInterview(
			{ ask: async () => ({ answers: [{ question: "Approve the plan?", answer: "Approve", options: ["Approve"] }] }) },
			interview,
			{ extensionId: "desk", title: "Desk" },
			async () => ({ done: true, text: "sealed" }),
		);
		deepStrictEqual(parked.checkpoints, ["plan-introduction"]);
	});

	it("a roster entry names one model and a unique label", () => {
		deepStrictEqual(parseRoster("roster:\n  - target: openai-codex\n    model: gpt-6-luna\n    thinking: high\n"), [
			{ target: "openai-codex", model: "gpt-6-luna", thinking: "high", label: "openai-codex/gpt-6-luna@high" },
		]);
		throws(
			() => parseRoster("roster:\n  - target: a\n    model: b\n  - target: a\n    model: b\n"),
			/roster\[1\]\.label/u,
		);
		throws(() => parseRoster("roster:\n  - target: a\n    model: b\n    thinking: hot\n"), /roster\[0\]\.thinking/u);
		throws(
			() => parseRoster("roster:\n  - target: a\n    model: b\n    effort: high\n"),
			/roster\[0\]\.effort: unknown key/u,
		);
		throws(() => parseRoster("entries: []\n"), /entries: unknown key/u);
	});
});

describe("campaign entry components", () => {
	it("an entry reads the operator's installed SDK, and a missing one names the operator's directory", async (t) => {
		const env = await isolateClioEnv("clio-campaign-components-");
		t.after(env.restore);
		delete process.env.CLIO_CODER_CLAUDE_SDK_DIR;
		const operatorComponents = join(env.dir, "operator-data", "components");
		const sdk = join(operatorComponents, "copilot-sdk", COPILOT_SDK_VERSION, "node_modules", COPILOT_SDK_PACKAGE);
		mkdirSync(sdk, { recursive: true });
		writeFileSync(
			join(sdk, "package.json"),
			JSON.stringify({ name: COPILOT_SDK_PACKAGE, version: COPILOT_SDK_VERSION, type: "module", exports: "./sdk.mjs" }),
		);
		writeFileSync(join(sdk, "sdk.mjs"), "export class CopilotClient {}\n");
		const configDir = process.env.CLIO_CODER_CONFIG_DIR ?? "";
		const roots = entryRoots(join(env.dir, "out", "01-luna", "home"), configDir, operatorComponents);
		Object.assign(process.env, entryRootEnv(roots));
		resetXdgCache();

		const entry = resolveCopilotSdkEntry();
		ok(entry !== null, "the entry resolves the operator's copilot-sdk");
		strictEqual(realpathSync(entry), realpathSync(join(sdk, "sdk.mjs")));

		// Without the component, the install hint names the operator's directory, never the entry's throwaway home.
		for (const [error, dir] of [
			[new CopilotSdkUnavailableError(), join(operatorComponents, "copilot-sdk", COPILOT_SDK_VERSION)],
			[new ClaudeAgentSdkUnavailableError(), join(operatorComponents, "claude-agent-sdk", CLAUDE_AGENT_SDK_VERSION)],
		] as const) {
			ok(error.message.includes(`separate component at ${dir};`), error.message);
			ok(!error.message.includes(roots.home), error.message);
		}
		deepStrictEqual(readdirSync(operatorComponents), ["copilot-sdk"]);
		strictEqual(existsSync(join(roots.data, "components")), false);
	});
});

/**
 * The pre-turn decision sites, end to end through the built binary.
 *
 * The contract every System One site makes is that an operator without a
 * decision model sees exactly the harness they had before the site existed.
 * Here that is checked at the only place it is observable: the chat request
 * the main model receives. A headless turn runs against a mock chat endpoint
 * with the turn sites unbound, then bound to a mock decision endpoint that
 * refuses, returns a malformed body, abstains, or answers too slowly, and every
 * one of those requests must be byte-identical to the unbound one. Only a
 * confident answer may change it, and then only by one hint line in the
 * submitted user message, with the tools and the system prompt untouched.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { TURN_SCOPE_HINT } from "../../src/domains/providers/sites/turn-scope.js";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	readRequestBody,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

type JevMode = "confident" | "unauthorized" | "malformed" | "abstain" | "slow";

interface JevFixture {
	server: Server;
	url: string;
	mode: JevMode;
	requests: Array<{ state: unknown; questions: Record<string, unknown> }>;
}

/** Answers every question id it is sent, in the shape the mode asks for. */
function answerFor(id: string, mode: JevMode, question: unknown): unknown {
	if (id.endsWith(".shape")) {
		const criteria = (question as { criteria: Record<string, string> }).criteria;
		const options = Object.keys(criteria);
		return mode === "abstain"
			? {
					type: "choice",
					choice: "single",
					confidence: 0.05,
					probabilities: Object.fromEntries(
						options.map((option) => [option, option === "single" ? 0.3 : 0.7 / (options.length - 1)]),
					),
				}
			: {
					type: "choice",
					choice: "single",
					confidence: 1,
					probabilities: Object.fromEntries(options.map((option) => [option, option === "single" ? 1 : 0])),
				};
	}
	if (mode === "abstain") return { type: "noul", noul: 0.5 };
	if (id === "turnScope.direct") return { type: "noul", noul: 0.95 };
	return { type: "noul", noul: 0.03 };
}

async function startJevFixture(): Promise<JevFixture> {
	const fixture: JevFixture = { server: null as unknown as Server, url: "", mode: "confident", requests: [] };
	fixture.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || req.url !== "/v1/systemone") {
			res.writeHead(404);
			res.end();
			return;
		}
		const body = JSON.parse(await readRequestBody(req)) as { state: unknown; questions: Record<string, unknown> };
		fixture.requests.push(body);
		if (fixture.mode === "unauthorized") {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "invalid api key" }));
			return;
		}
		// Past the host's 1.5s bound on the pre-turn brief.
		if (fixture.mode === "slow") await new Promise((resolve) => setTimeout(resolve, 2_500));
		const answers =
			fixture.mode === "malformed"
				? {}
				: Object.fromEntries(
						Object.entries(body.questions).map(([id, question]) => [id, answerFor(id, fixture.mode, question)]),
					);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ model: "jev-fixture", answers }));
	});
	await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
	fixture.url = `http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}`;
	return fixture;
}

/** Point the turn sites at the mock decision endpoint, or unbind them. */
function bindTurnSites(configDir: string, jevUrl: string, bound: boolean): void {
	const path = join(configDir, "settings.yaml");
	let yaml = readFileSync(path, "utf8");
	if (!yaml.includes("id: jev-fixture")) {
		yaml = yaml.replace(
			"      - mock-model\n",
			[
				"      - mock-model",
				"  - id: jev-fixture",
				"    runtime: typesafe-jev",
				`    url: ${jevUrl}/v1`,
				"    defaultModel: jev-latest",
				"    auth:",
				"      apiKeyEnvVar: CLIO_CODER_TEST_JEV_KEY",
				"",
			].join("\n"),
		);
		yaml = yaml.replace(
			/^ {2}profiles: \{\}$/m,
			"  profiles:\n    system-one:\n      target: jev-fixture\n      model: jev-latest",
		);
	}
	yaml = yaml.replace(
		/^ {2}decisionProfiles:(?: \{\}|\n(?: {4}.*\n)+)/m,
		bound
			? "  decisionProfiles:\n    turnScope: system-one\n    dispatchForecast: system-one\n"
			: "  decisionProfiles: {}\n",
	);
	writeFileSync(path, yaml, "utf8");
}

interface ChatRequest {
	messages: Array<{ role: string; content: unknown }>;
	tools?: unknown;
}

function lastUserText(request: ChatRequest): string {
	const user = [...request.messages].reverse().find((message) => message.role === "user");
	const content = user?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => (part as { text?: string }).text ?? "").join("");
	}
	return "";
}

describe("pre-turn decision sites through the built binary", { timeout: 180_000 }, () => {
	let scratch: HeadlessScratch;
	let chat: OpenAICompatFixture;
	let jev: JevFixture;

	before(async () => {
		scratch = headlessScratch("clio-turn-sites-");
		scratch.env.CLIO_CODER_TEST_JEV_KEY = "fixture-jev-key";
		chat = await startOpenAICompatFixture("Hello.");
		jev = await startJevFixture();
		seedOpenAICompatToolOrchestrator(scratch.configDir, chat.url, "auto-edit");
	});

	after(async () => {
		await closeServer(chat.server);
		await closeServer(jev.server);
		scratch.cleanup();
	});

	/** One headless turn; returns the first chat request it sent. */
	async function turn(bound: boolean, mode: JevMode): Promise<ChatRequest> {
		bindTurnSites(scratch.configDir, jev.url, bound);
		jev.mode = mode;
		const before = chat.requests.length;
		const result = await runCli(["run", "how are you? who are you?"], {
			env: scratch.env,
			cwd: scratch.root,
			timeoutMs: 60_000,
		});
		strictEqual(result.code, 0, `run failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
		const request = chat.requests[before];
		ok(request, "the turn sent no chat request");
		return request as unknown as ChatRequest;
	}

	it("sends no decision request and no hint when the sites are unbound", async () => {
		const jevBefore = jev.requests.length;
		const request = await turn(false, "confident");
		strictEqual(jev.requests.length, jevBefore);
		ok(!lastUserText(request).includes("[Scope]"));
		ok(!lastUserText(request).includes("[Plan]"));
	});

	it("keeps the chat request byte-identical to unbound whenever the decision model cannot answer", async () => {
		const unbound = JSON.stringify(await turn(false, "confident"));
		for (const mode of ["unauthorized", "malformed", "abstain", "slow"] as const) {
			const jevBefore = jev.requests.length;
			const bound = JSON.stringify(await turn(true, mode));
			ok(jev.requests.length > jevBefore, `${mode}: the bound sites never asked`);
			strictEqual(bound, unbound, `${mode}: the chat request changed`);
		}
	});

	it("adds only the hint line on a confident answer, with tools and system prompt untouched", async () => {
		const unbound = await turn(false, "confident");
		const jevBefore = jev.requests.length;
		const hinted = await turn(true, "confident");
		strictEqual(jev.requests.length, jevBefore + 1, "both turn sites must share one decision request");
		const sent = jev.requests.at(-1);
		ok(sent);
		deepStrictEqual(Object.keys(sent.questions).sort(), [
			"dispatchForecast.dispatch",
			"dispatchForecast.shape",
			"turnScope.direct",
		]);
		ok(lastUserText(hinted).includes(TURN_SCOPE_HINT), "the scope hint is missing");
		ok(!lastUserText(hinted).includes("[Plan]"), "a low dispatch forecast must not hint");
		deepStrictEqual(hinted.tools, unbound.tools);
		deepStrictEqual(hinted.messages[0], unbound.messages[0]);
		strictEqual(lastUserText(hinted).replace(`${TURN_SCOPE_HINT}`, "").length > 0, true);
	});
});

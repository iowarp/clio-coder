/**
 * Speculative dispatch through the built binary.
 *
 * A headless turn runs with `dispatchForecast` bound to a mock decision
 * endpoint and a scripted main model that dispatches Documenter. When the
 * forecast names Documenter, the dispatch adopts the process held for it, the
 * worker attests against the spec it was handed and the run seals a receipt
 * that verifies. When the forecast names another recipe, the dispatch spawns
 * cold. Either way, no worker process outlives the run. With the leaf off the
 * forecast is asked exactly its two questions and nothing is held.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse, stringify } from "yaml";

import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	readRequestBody,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { readRunJournal } from "../harness/run-journal.js";

interface JevFixture {
	server: Server;
	url: string;
	predict: string;
	requests: Array<{ questions: Record<string, unknown> }>;
}

async function startJev(): Promise<JevFixture> {
	const fixture: JevFixture = { server: null as unknown as Server, url: "", predict: "documenter", requests: [] };
	fixture.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const body = JSON.parse(await readRequestBody(req)) as { questions: Record<string, unknown> };
		fixture.requests.push(body);
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) {
			if (id === "dispatchForecast.dispatch") answers[id] = { type: "noul", noul: 0.95 };
			else if (id === "dispatchForecast.shape")
				answers[id] = { type: "choice", choice: "single", confidence: 1, probabilities: { single: 1 } };
			else if (id === "dispatchForecast.recipe")
				answers[id] = {
					type: "choice",
					choice: fixture.predict,
					confidence: 0.95,
					probabilities: { [fixture.predict]: 0.97 },
				};
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ model: "jev-fixture", answers }));
	});
	await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
	fixture.url = `http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}`;
	return fixture;
}

interface WireMessage {
	role: string;
	content?: unknown;
}

function isMain(request: Record<string, unknown>): boolean {
	return Array.isArray(request.tools) && request.tools.some((tool) => tool.function?.name === "dispatch");
}

function hasToolResult(request: Record<string, unknown>): boolean {
	return ((request.messages ?? []) as WireMessage[]).some((message) => message.role === "tool");
}

const REPORT = JSON.stringify({
	mutatedPaths: [],
	validations: [
		{
			name: "Read the task",
			passed: true,
			evidence: "The task asks for a one-paragraph explanation and forbids edits.",
		},
	],
	summary: "The project is a fixture workspace with nothing to change.",
});

/** Every live worker entry process whose working directory is `cwd`. Linux only. */
function workersIn(cwd: string): number[] {
	const pids: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
			if (!cmdline.includes("worker/entry.js")) continue;
			if (readlinkSync(`/proc/${name}/cwd`) === cwd) pids.push(Number(name));
		} catch {
			// Exited while listing.
		}
	}
	return pids;
}

describe("speculative dispatch through the built binary", {
	timeout: 180_000,
	skip: process.platform !== "linux",
}, () => {
	let scratch: HeadlessScratch;
	let chat: OpenAICompatFixture;
	let jev: JevFixture;

	before(async () => {
		scratch = headlessScratch("clio-speculative-");
		scratch.env.CLIO_CODER_TEST_JEV_KEY = "fixture-jev-key";
		chat = await startOpenAICompatFixture((request) => (isMain(request) ? "Documenter finished." : REPORT), {
			toolCall: (request) =>
				isMain(request) && !hasToolResult(request)
					? {
							name: "dispatch",
							arguments: {
								agent: "documenter",
								task: "Explain this workspace in one paragraph. Do not edit files.",
							},
							id: "dispatch-documenter",
						}
					: null,
		});
		jev = await startJev();
		seedOpenAICompatToolOrchestrator(scratch.configDir, chat.url, "full-auto");
	});

	after(async () => {
		await closeServer(chat.server);
		await closeServer(jev.server);
		scratch.cleanup();
	});

	function configure(speculativeDispatch: boolean): void {
		const path = join(scratch.configDir, "settings.yaml");
		const settings = parse(readFileSync(path, "utf8"));
		settings.targets = [
			...settings.targets.filter((target: { id: string }) => target.id !== "jev-fixture"),
			{
				id: "jev-fixture",
				runtime: "typesafe-jev",
				url: `${jev.url}/v1`,
				defaultModel: "jev-latest",
				auth: { apiKeyEnvVar: "CLIO_CODER_TEST_JEV_KEY" },
			},
		];
		settings.fleet.default.target = "mock-chat";
		settings.fleet.default.model = "mock-model";
		settings.fleet.profiles = { "system-one": { target: "jev-fixture", model: "jev-latest" } };
		settings.fleet.decisionProfiles = { dispatchForecast: "system-one" };
		settings.fleet.speculativeDispatch = speculativeDispatch;
		writeFileSync(path, stringify(settings));
	}

	async function turn(speculativeDispatch: boolean, predict: string) {
		configure(speculativeDispatch);
		jev.predict = predict;
		const before = new Set(readRunJournal(scratch.stateDir)?.envelopes.keys() ?? []);
		const jevBefore = jev.requests.length;
		const result = await runCli(
			["run", "--json", "--autonomy", "full-auto", "Ask Documenter to explain this workspace."],
			{
				env: scratch.env,
				cwd: scratch.root,
				timeoutMs: 90_000,
			},
		);
		strictEqual(result.code, 0, `run failed\nstdout=${result.stdout.slice(-2000)}\nstderr=${result.stderr}`);
		const journal = readRunJournal(scratch.stateDir);
		ok(journal);
		const runs = [...journal.envelopes.values()].filter((run) => !before.has(run.id) && run.agentId === "documenter");
		strictEqual(runs.length, 1, "the turn dispatched one documenter run");
		const run = runs[0];
		ok(run);
		const receipt = journal.receipts.find((entry) => entry.runId === run.id);
		ok(receipt, "the run sealed no receipt");
		return { run, receipt, jevRequest: jev.requests[jevBefore] };
	}

	it("adopts the held process when the forecast names the recipe dispatched", async () => {
		const { run, receipt, jevRequest } = await turn(true, "documenter");
		ok(jevRequest);
		ok("dispatchForecast.recipe" in jevRequest.questions, "the leaf on asks the recipe question");
		ok(run.timing?.heldWorkerAdoptedAt, "the dispatch spawned cold despite a matching forecast");
		strictEqual(receipt.outcome, "succeeded", receipt.outcomeDetail ?? "");
		ok(verifyReceiptIntegrity(receipt, run).ok, "the adopted run's receipt does not verify");
		deepStrictEqual(workersIn(scratch.root), [], "a worker process outlived the run");
	});

	it("spawns cold when the forecast names another recipe, and leaves nothing behind", async () => {
		const { run, receipt } = await turn(true, "coder");
		strictEqual(run.timing?.heldWorkerAdoptedAt, undefined);
		strictEqual(receipt.outcome, "succeeded", receipt.outcomeDetail ?? "");
		deepStrictEqual(workersIn(scratch.root), [], "the unused held process outlived the run");
	});

	it("asks the forecast its two questions and holds nothing with the leaf off", async () => {
		const { run, jevRequest } = await turn(false, "documenter");
		ok(jevRequest);
		deepStrictEqual(Object.keys(jevRequest.questions).sort(), ["dispatchForecast.dispatch", "dispatchForecast.shape"]);
		strictEqual(run.timing?.heldWorkerAdoptedAt, undefined);
	});
});

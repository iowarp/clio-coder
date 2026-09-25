import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

const CLI = join(new URL("../..", import.meta.url).pathname, "dist", "cli", "index.js");

/**
 * Two sessions on one machine share settings.yaml. A model another session
 * saved there is the default for new sessions only: continuing a session
 * resumes the route that session last ran on, and never writes it back.
 */
describe("resuming a session keeps the route it ran on", { timeout: 180_000 }, () => {
	let scratch: HeadlessScratch;
	let chat: OpenAICompatFixture;

	const settingsPath = (): string => join(scratch.configDir, "settings.yaml");
	const readChatRoute = (): { target: unknown; model: unknown } => {
		const saved = parseYaml(readFileSync(settingsPath(), "utf8")) as { chat: { target: unknown; model: unknown } };
		return { target: saved.chat.target, model: saved.chat.model };
	};
	const saveChatModel = (model: string): void => {
		const saved = parseYaml(readFileSync(settingsPath(), "utf8")) as { chat: { model: string } };
		saved.chat.model = model;
		writeFileSync(settingsPath(), stringifyYaml(saved), "utf8");
	};

	async function turn(args: ReadonlyArray<string>): Promise<string> {
		const before = chat.requests.length;
		const result = await runCli(["run", ...args], { env: scratch.env, cwd: scratch.root, timeoutMs: 60_000 });
		strictEqual(result.code, 0, `run failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
		const request = chat.requests[before];
		ok(request, "the turn sent no chat request");
		return String(request.model);
	}

	before(async () => {
		scratch = headlessScratch("clio-resume-route-");
		chat = await startOpenAICompatFixture("Noted.", {
			models: [
				{ id: "mock-model", object: "model" },
				{ id: "other-model", object: "model" },
			],
		});
		seedOpenAICompatOrchestrator(scratch.configDir, chat.url);
		const yaml = readFileSync(settingsPath(), "utf8");
		writeFileSync(settingsPath(), yaml.replace("      - mock-model", "      - mock-model\n      - other-model"), "utf8");
	});

	after(async () => {
		await closeServer(chat.server);
		scratch.cleanup();
	});

	it("continues on the session's model after another session saved a different default", async () => {
		strictEqual(await turn(["remember the number 7"]), "mock-model");
		// What a second session in another project does when it saves a model globally.
		saveChatModel("other-model");
		strictEqual(await turn(["--continue", "what was the number?"]), "mock-model");
		// Restoring the session's route is session-local; the saved default stands.
		deepStrictEqual(readChatRoute(), { target: "mock-chat", model: "other-model" });
		// A fresh session starts from the saved default, as before.
		strictEqual(await turn(["a new question"]), "other-model");
	});

	it("lets an explicit --model beat the resumed route", async () => {
		saveChatModel("mock-model");
		strictEqual(await turn(["pick a colour"]), "mock-model");
		strictEqual(await turn(["--continue", "--model", "other-model", "and another"]), "other-model");
		deepStrictEqual(readChatRoute(), { target: "mock-chat", model: "mock-model" });
		// The flag moved the session, so the session's newest route is the flag's.
		strictEqual(await turn(["--continue", "and one more"]), "other-model");
		deepStrictEqual(readChatRoute(), { target: "mock-chat", model: "mock-model" });
	});

	it("restores the route when an ACP client loads the session", async () => {
		saveChatModel("mock-model");
		strictEqual(await turn(["an acp-bound question"]), "mock-model");
		saveChatModel("other-model");
		const client = createStdioTransport(
			process.execPath,
			[CLI, "--no-context-files", "--no-skills", "acp", "--cwd", scratch.root],
			{
				cwd: scratch.root,
				env: Object.fromEntries(
					Object.entries(scratch.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
				),
			},
		);
		try {
			await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "contract", version: "1" } });
			const listed = await client.request<{ sessions: Array<{ sessionId: string }> }>("_clio-coder/session/list", {});
			const sessionId = listed.sessions[0]?.sessionId;
			ok(sessionId, "no session to load");
			await client.request("session/load", { sessionId, cwd: scratch.root, mcpServers: [] });
			const route = await client.request<Record<string, unknown>>("_clio-coder/settings/get_safe", {});
			strictEqual(JSON.stringify(route).includes('"mock-model"'), true, JSON.stringify(route));
			const before = chat.requests.length;
			await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "still there?" }] }, 60_000);
			strictEqual(chat.requests[before]?.model, "mock-model");
			await client.request("session/close", { sessionId });
		} finally {
			client.close();
		}
		deepStrictEqual(readChatRoute(), { target: "mock-chat", model: "other-model" });
	});
});

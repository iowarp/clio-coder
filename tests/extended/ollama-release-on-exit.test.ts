import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";

const MODEL = "fixture:latest";

interface OllamaFixture {
	server: Server;
	url: string;
	resident: Set<string>;
	/** Every `/api/generate` body, which is the only way Ollama releases a model. */
	releases: Array<{ model: string; keep_alive: unknown }>;
	chats: number;
}

/**
 * A recording Ollama server. `stallChat` answers the chat with one chunk and
 * then holds the stream open, so a run is mid-turn when it is stopped.
 * `hangRelease` accepts the release request and never answers it.
 */
async function ollamaFixture(options: { stallChat?: boolean; hangRelease?: boolean } = {}): Promise<OllamaFixture> {
	const state = { chats: 0 };
	const resident = new Set<string>();
	const releases: OllamaFixture["releases"] = [];
	const server = createServer(async (req, res) => {
		const raw = req.method === "POST" ? await readRequestBody(req) : "";
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") {
			res.end(JSON.stringify({ models: [...resident].map((model) => ({ model, name: model })) }));
			return;
		}
		if (req.url === "/api/tags") {
			res.end(JSON.stringify({ models: [{ model: MODEL, name: MODEL }] }));
			return;
		}
		if (req.url === "/api/version") {
			res.end(JSON.stringify({ version: "0.34.0" }));
			return;
		}
		if (req.url === "/api/show") {
			res.end(
				JSON.stringify({
					capabilities: ["completion"],
					model_info: { "general.architecture": "fixture", "fixture.context_length": 32768 },
				}),
			);
			return;
		}
		if (req.url === "/api/generate") {
			const body = JSON.parse(raw) as { model: string; keep_alive: unknown };
			releases.push({ model: body.model, keep_alive: body.keep_alive });
			if (options.hangRelease) return;
			resident.delete(body.model);
			res.end(JSON.stringify({ done: true }));
			return;
		}
		if (req.url === "/api/chat") {
			const body = JSON.parse(raw) as { model: string };
			state.chats += 1;
			resident.add(body.model);
			const chunk = { model: body.model, message: { role: "assistant", content: "hello" }, done: false };
			res.write(`${JSON.stringify(chunk)}\n`);
			if (options.stallChat) return;
			res.end(
				`${JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 })}\n`,
			);
			return;
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: "not found" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		server,
		url,
		resident,
		releases,
		get chats() {
			return state.chats;
		},
	};
}

function seedOllamaOrchestrator(configDir: string, url: string): void {
	const p = join(configDir, "settings.yaml");
	const patched = readFileSync(p, "utf8")
		.replace(
			/^targets:.*$/m,
			[
				"targets:",
				"  - id: local-ollama",
				"    runtime: ollama-native",
				`    url: ${url}`,
				`    defaultModel: ${MODEL}`,
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: local-ollama")
		.replace(/^ {2}model: null$/m, `  model: ${MODEL}`);
	writeFileSync(p, patched, "utf8");
}

describe("clio-coder run releases the Ollama models it loaded on exit (#379)", () => {
	const servers: Server[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => closeServer(server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	async function headlessRun(fixture: OllamaFixture, flags: ReadonlyArray<string> = []) {
		servers.push(fixture.server);
		const scratch = headlessScratch("clio-coder-ollama-release-");
		scratches.push(scratch);
		seedOllamaOrchestrator(scratch.configDir, fixture.url);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		return runCli(["--no-context-files", "--no-skills", "run", ...flags, "say hello"], {
			env: scratch.env,
			cwd: project,
			timeoutMs: 60_000,
		});
	}

	it("sends keep_alive 0 for a model the run loaded", async () => {
		const fixture = await ollamaFixture();
		const turn = await headlessRun(fixture);
		strictEqual(turn.code, 0, turn.stderr);
		ok(fixture.chats >= 1, "the run must have reached the model");
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
		strictEqual(fixture.resident.has(MODEL), false);
	});

	it("leaves a model that was already resident before the run", async () => {
		const fixture = await ollamaFixture();
		fixture.resident.add(MODEL);
		const turn = await headlessRun(fixture);
		strictEqual(turn.code, 0, turn.stderr);
		ok(fixture.chats >= 1, "the run must have reached the model");
		deepStrictEqual(fixture.releases, []);
		strictEqual(fixture.resident.has(MODEL), true);
	});

	it("releases on a --timeout exit and keeps exit 124", async () => {
		const fixture = await ollamaFixture({ stallChat: true });
		const turn = await headlessRun(fixture, ["--timeout", "2"]);
		strictEqual(turn.code, 124, turn.stderr);
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	});

	it("keeps the exit code when the release hangs", async () => {
		const fixture = await ollamaFixture({ hangRelease: true });
		const turn = await headlessRun(fixture);
		strictEqual(turn.code, 0, turn.stderr);
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	});
});

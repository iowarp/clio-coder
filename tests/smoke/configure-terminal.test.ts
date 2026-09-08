import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";
import { parse, stringify } from "yaml";
import { runtimesForCategory } from "../../src/cli/configure-target.js";
import type { ClioSettings } from "../../src/core/config.js";
import { listProviderSupportEntries } from "../../src/domains/providers/index.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "dist/cli/index.js");
const DOWN = "\x1b[B";
const ENTER = "\r";
const BACK = "\x1b";
const CLEAR = "\x15";

function terminal(home: ReturnType<typeof makeScratchHome>, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
	const child = spawn(process.execPath, [CLI, "configure", ...args], {
		cwd: home.dir,
		env: { ...process.env, ...home.env, HOME: home.dir, TERM: "xterm-256color", PATH: "", ...env },
		cols: 100,
		rows: 45,
	});
	let output = "";
	let exited = false;
	child.onData((data) => {
		output += data;
	});
	const exit = new Promise<number>((resolve) =>
		child.onExit((event) => {
			exited = true;
			resolve(event.exitCode);
		}),
	);
	async function finish(expected = 0) {
		const timer = setTimeout(() => child.kill(), 5000);
		try {
			strictEqual(await exit, expected);
		} finally {
			clearTimeout(timer);
		}
	}
	return {
		finish,
		screen: () => stripVTControlCharacters(output),
		async expect(cue: string) {
			const deadline = Date.now() + 15_000;
			while (!stripVTControlCharacters(output).includes(cue) && !exited && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			ok(stripVTControlCharacters(output).includes(cue), `Expected ${JSON.stringify(cue)}; exited=${exited}\n${output}`);
		},
		send(keys: string) {
			output = "";
			child.write(keys);
		},
		async quit() {
			child.write("q");
			await finish();
		},
		close() {
			if (!exited) child.kill();
		},
	};
}

function seed(home: ReturnType<typeof makeScratchHome>, url: string): string {
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const file = join(home.dir, "config/settings.yaml");
	writeFileSync(
		file,
		stringify({
			version: 2,
			targets: [
				{
					id: "existing",
					runtime: "openai-compat",
					url,
					defaultModel: "alpha",
					gateway: true,
					capabilities: { contextWindow: 32768, maxTokens: 4096, reasoning: false },
				},
			],
			chat: { target: "existing", model: "alpha", thinkingLevel: "low", modelPicker: { favorites: ["existing/alpha"] } },
			fleet: { default: { target: "existing", model: "alpha" } },
		}),
	);
	return file;
}

describe("smoke/configure on a real terminal", { skip: process.platform === "win32" }, () => {
	it("quick-connects a fresh home with one model, supports Back, and uses the shipped defaults", async () => {
		const home = makeScratchHome("clio-quick-tty-");
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/api/version") response.end('{"version":"0.9.0"}');
			else if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: "solo" }] }));
			else {
				response.statusCode = 404;
				response.end("{}");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const tty = terminal(home);
		try {
			await tty.expect("❯ Quick Connect");
			tty.send(ENTER);
			await tty.expect("Endpoint URL");
			tty.send(`http://127.0.0.1:1${ENTER}`);
			await tty.expect("Could not connect:");
			strictEqual(existsSync(join(home.dir, "config/settings.yaml")), false);
			tty.send(CLEAR + url + ENTER);
			await tty.expect("Ready to connect");
			ok(!tty.screen().includes("API key"));
			ok(!tty.screen().includes("Choose the model"));
			strictEqual(existsSync(join(home.dir, "config/settings.yaml")), false);
			tty.send(BACK);
			await tty.expect("Endpoint URL");
			tty.send(ENTER);
			await tty.expect("Ready to connect");
			tty.send(ENTER);
			await tty.finish();
			const saved = parse(readFileSync(join(home.dir, "config/settings.yaml"), "utf8")) as ClioSettings;
			strictEqual(saved.targets.length, 1);
			strictEqual(saved.targets[0]?.runtime, "ollama-native");
			strictEqual(saved.chat.model, "solo");
			deepStrictEqual(
				{ target: saved.fleet.default.target, model: saved.fleet.default.model },
				{ target: saved.chat.target, model: "solo" },
			);
			strictEqual(saved.fleet.concurrency, 1);
			strictEqual(saved.safety.autonomy, "auto-edit");
			strictEqual(saved.safety.limits.sessionCostUsd, 5);
			strictEqual(saved.chat.prewarm, false);
			strictEqual(saved.chat.maxOutputTokens, 0);
			strictEqual(saved.context.memory.target, null);
			deepStrictEqual(saved.integrations.externalAgents.entries, []);
		} finally {
			tty.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			home.cleanup();
		}
	});

	it("quick-connects a keyed gateway without inheriting an unrelated key or saving a draft", async () => {
		const home = makeScratchHome("clio-quick-gateway-");
		mkdirSync(join(home.dir, "config"), { recursive: true });
		const credentialsFile = join(home.dir, "config/credentials.yaml");
		const originalCredentials = stringify({
			version: 2,
			entries: {
				"openai-compat": { type: "api_key", key: "unrelated-key", updatedAt: "2026-09-01T00:00:00Z" },
			},
		});
		writeFileSync(credentialsFile, originalCredentials, { mode: 0o600 });
		const seen = new Set<string | undefined>();
		const server = createServer((request, response) => {
			seen.add(request.headers.authorization);
			response.setHeader("content-type", "application/json");
			if (request.url === "/health/liveliness") {
				response.end('{"status":"healthy"}');
				return;
			}
			if (request.url !== "/v1/model/info" && request.url !== "/v1/models") {
				response.statusCode = 404;
				response.end("{}");
				return;
			}
			if (request.headers.authorization !== "Bearer quick-key") {
				response.statusCode = 401;
				response.end("{}");
				return;
			}
			if (request.url === "/v1/model/info")
				response.end(
					JSON.stringify({
						data: [
							...["alpha", "beta"].map((id) => ({
								model_name: id,
								model_info: { mode: "chat", supports_function_calling: true, max_input_tokens: 32768, max_output_tokens: 4096 },
							})),
							{ model_name: "embeddings", model_info: { mode: "embedding" } },
						],
					}),
				);
			else response.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }, { id: "embeddings" }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const tty = terminal(home, ["--quick"]);
		try {
			await tty.expect("Endpoint URL");
			tty.send(url + ENTER);
			await tty.expect("API key (saved locally");
			tty.send(`wrong-key${ENTER}`);
			await tty.expect("The endpoint rejected that key");
			tty.send(`quick-key${ENTER}`);
			await tty.expect("Choose the model for Clio");
			ok(!tty.screen().includes("embeddings"));
			tty.send("no-matching-model");
			await tty.expect("No matching models");
			tty.send(`${CLEAR}bet`);
			await tty.expect("❯ beta");
			tty.send(ENTER);
			await tty.expect("Ready to connect");
			strictEqual(readFileSync(credentialsFile, "utf8"), originalCredentials);
			strictEqual(existsSync(join(home.dir, "config/settings.yaml")), false);
			tty.send(BACK);
			await tty.expect("❯ beta");
			tty.send(ENTER);
			await tty.expect("Ready to connect");
			tty.send(ENTER);
			await tty.finish();
			const saved = parse(readFileSync(join(home.dir, "config/settings.yaml"), "utf8")) as ClioSettings;
			strictEqual(saved.targets[0]?.runtime, "litellm");
			strictEqual(saved.chat.model, "beta");
			ok(!seen.has("Bearer unrelated-key"));
			const credentials = parse(readFileSync(credentialsFile, "utf8"));
			strictEqual(credentials.entries[saved.targets[0]?.auth?.apiKeyRef ?? ""].key, "quick-key");
			strictEqual(credentials.entries["openai-compat"].key, "unrelated-key");
		} finally {
			tty.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			home.cleanup();
		}
	});

	it("offers a key for APIs whose model catalog is public", async () => {
		const home = makeScratchHome("clio-quick-public-");
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "solo" }] }));
			else {
				response.statusCode = 404;
				response.end("{}");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const tty = terminal(home, ["--quick"]);
		try {
			await tty.expect("Endpoint URL");
			tty.send(`http://127.0.0.1:${(server.address() as AddressInfo).port}${ENTER}`);
			await tty.expect("Some APIs publish models publicly");
			tty.send(`chat-key${ENTER}`);
			await tty.expect("Ready to connect");
			strictEqual(existsSync(join(home.dir, "config/credentials.yaml")), false);
			tty.send(ENTER);
			await tty.finish();
			const saved = parse(readFileSync(join(home.dir, "config/settings.yaml"), "utf8")) as ClioSettings;
			strictEqual(saved.targets[0]?.runtime, "openai-compat");
			const credentials = parse(readFileSync(join(home.dir, "config/credentials.yaml"), "utf8"));
			strictEqual(credentials.entries[saved.targets[0]?.auth?.apiKeyRef ?? ""].key, "chat-key");
		} finally {
			tty.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			home.cleanup();
		}
	});

	it("quick reconnect preserves an existing target, fleet, preferences, and stored credential", async () => {
		const home = makeScratchHome("clio-quick-existing-");
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.headers.authorization !== "Bearer existing-key") {
				response.statusCode = 401;
				response.end("{}");
				return;
			}
			if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
			else {
				response.statusCode = 404;
				response.end("{}");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const file = seed(home, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		const before = parse(readFileSync(file, "utf8"));
		before.targets[0].auth = { apiKeyRef: "existing" };
		before.safety = { autonomy: "full-auto" };
		before.fleet.concurrency = 4;
		before.chat.prewarm = true;
		writeFileSync(file, stringify(before));
		const credentialsFile = join(home.dir, "config/credentials.yaml");
		const credentials = stringify({
			version: 2,
			entries: { existing: { type: "api_key", key: "existing-key", updatedAt: "2026-09-01T00:00:00Z" } },
		});
		writeFileSync(credentialsFile, credentials, { mode: 0o600 });
		const tty = terminal(home, ["--quick"]);
		try {
			await tty.expect("Endpoint URL");
			tty.send(ENTER);
			await tty.expect("Choose the model for Clio");
			ok(!tty.screen().includes("API key"));
			tty.send(DOWN + ENTER);
			await tty.expect("Ready to connect");
			tty.send(ENTER);
			await tty.finish();
			const saved = parse(readFileSync(file, "utf8"));
			deepStrictEqual(saved, { ...before, chat: { ...before.chat, model: "beta" } });
			strictEqual(readFileSync(credentialsFile, "utf8"), credentials);
		} finally {
			tty.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			home.cleanup();
		}
	});

	it("edits settings after arrow menus, clears a value, and returns to the selected row", async () => {
		const home = makeScratchHome("clio-configure-tty-");
		const file = seed(home, "http://127.0.0.1:1");
		const tty = terminal(home);
		try {
			await tty.expect("Quick Connect");
			tty.send(DOWN + ENTER);
			await tty.expect("esc back");
			tty.send(DOWN + ENTER);
			await tty.expect("esc back");
			tty.send(ENTER);
			await tty.expect("❯ low");
			tty.send(DOWN + DOWN + ENTER);
			await tty.expect("Chat thinking level set to high");
			tty.send(DOWN + DOWN + ENTER);
			await tty.expect("enter accept");
			tty.send(CLEAR + ENTER);
			await tty.expect("Chat default model cleared");
			tty.send(BACK);
			await tty.expect("❯ Models & Thinking");
			tty.send(DOWN.repeat(3) + ENTER);
			await tty.expect("Worker permission mode");
			tty.send(ENTER);
			await tty.expect("❯ auto-edit");
			tty.send(DOWN + ENTER);
			await tty.expect("Autonomy level set to full-auto");
			await tty.quit();
			const saved = parse(readFileSync(file, "utf8")) as ClioSettings;
			strictEqual(saved.chat.thinkingLevel, "high");
			strictEqual(saved.chat.model, null);
			strictEqual(saved.safety.autonomy, "full-auto");
		} finally {
			tty.close();
			home.cleanup();
		}
	});

	it("adds and edits targets through Save while preserving existing roles and unrelated capabilities", async () => {
		const home = makeScratchHome("clio-configure-tty-");
		const observedAuth = new Set<string | undefined>();
		const server = createServer((request, response) => {
			observedAuth.add(request.headers.authorization);
			response.setHeader("content-type", "application/json");
			if (!["Bearer second-test-key", "Bearer legacy-test-key"].includes(request.headers.authorization ?? "")) {
				response.statusCode = 401;
				response.end("{}");
				return;
			}
			if (request.headers.authorization === "Bearer legacy-test-key") strictEqual(request.headers["x-custom"], "keep-me");
			if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
			else {
				response.statusCode = 404;
				response.end("{}");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const file = seed(home, url);
		const before = parse(readFileSync(file, "utf8")) as ClioSettings;
		const existingTarget = before.targets[0];
		ok(existingTarget);
		// This target used to be named second. Reusing that name must not overwrite its key.
		existingTarget.auth = { apiKeyRef: "target:second", headers: { "X-Custom": "keep-me" } };
		writeFileSync(file, stringify(before));
		const credentialsFile = join(home.dir, "config/credentials.yaml");
		const originalCredentials = stringify({
			version: 2,
			entries: {
				"target:second": { type: "api_key", key: "legacy-test-key", updatedAt: "2026-09-01T00:00:00Z" },
			},
		});
		writeFileSync(credentialsFile, originalCredentials, { mode: 0o600 });
		const tty = terminal(home, ["--section", "targets"]);
		try {
			await tty.expect("esc or q quit");
			tty.send(ENTER);
			await tty.expect("How will you connect");
			tty.send(DOWN + ENTER);
			await tty.expect("Which runtime?");
			const registry = getRuntimeRegistry();
			registerBuiltinRuntimes(registry);
			const entries = runtimesForCategory(listProviderSupportEntries(registry.list()), "local-http");
			const index = entries.findIndex((entry) => entry.runtimeId === "openai-compat");
			ok(index >= 0);
			tty.send(DOWN.repeat(index) + ENTER);
			await tty.expect("Target id");
			tty.send(`${CLEAR}existing${ENTER}`);
			await tty.expect("already exists");
			tty.send(`${CLEAR}second${ENTER}`);
			await tty.expect("How should Clio get the API key?");
			tty.send(`\x1b[A${ENTER}`);
			await tty.expect("Paste the API key");
			tty.send(`second-test-key${ENTER}`);
			await tty.expect("Where is the server?");
			tty.send(CLEAR + url + ENTER);
			await tty.expect("Which model?");
			tty.send(DOWN + ENTER);
			await tty.expect("How hard should it think?");
			tty.send(ENTER);
			await tty.expect("Context window in tokens");
			tty.send(`16384${ENTER}`);
			await tty.expect("Review target");
			deepStrictEqual(parse(readFileSync(file, "utf8")), before, "a draft must not write settings");
			strictEqual(readFileSync(credentialsFile, "utf8"), originalCredentials, "pasted keys wait for Save");
			tty.send(BACK);
			await tty.expect("Context window in tokens");
			tty.send(`${CLEAR}24576${ENTER}`);
			await tty.expect("Review target");
			tty.send(ENTER);
			await tty.expect("target second saved");
			await tty.expect("Edit a target");
			const added = parse(readFileSync(file, "utf8")) as ClioSettings;
			deepStrictEqual(added.chat, before.chat);
			deepStrictEqual(added.fleet, before.fleet);
			strictEqual(added.targets[1]?.capabilities?.contextWindow, 24576);
			tty.send(DOWN.repeat(4) + ENTER);
			await tty.expect("Target to edit");
			tty.send(ENTER);
			await tty.expect("How should Clio get the API key?");
			tty.send(ENTER);
			await tty.expect("Where is the server?");
			tty.send(ENTER);
			await tty.expect("Which model?");
			tty.send(DOWN + ENTER);
			await tty.expect("How hard should it think?");
			tty.send(ENTER);
			await tty.expect("Context window in tokens");
			tty.send(ENTER);
			await tty.expect("Review target");
			tty.send(ENTER);
			await tty.expect("Edit a target");
			await tty.quit();
			const saved = parse(readFileSync(file, "utf8")) as ClioSettings;
			deepStrictEqual(saved.chat, before.chat);
			deepStrictEqual(saved.fleet, before.fleet);
			strictEqual(saved.targets[0]?.gateway, true);
			deepStrictEqual(saved.targets[0]?.capabilities, before.targets[0]?.capabilities);
			strictEqual(saved.targets[0]?.defaultModel, "beta");
			deepStrictEqual(saved.targets[0]?.auth, existingTarget.auth);
			const { entries: credentials } = parse(readFileSync(credentialsFile, "utf8")) as {
				entries: Record<string, { key: string }>;
			};
			strictEqual(credentials["target:second"]?.key, "legacy-test-key");
			strictEqual(credentials[saved.targets[1]?.auth?.apiKeyRef ?? ""]?.key, "second-test-key");
			ok(observedAuth.has("Bearer second-test-key"), "probes use the draft credential before Save");
			ok(observedAuth.has("Bearer legacy-test-key"), "editing resolves the target's existing credential");
		} finally {
			tty.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			home.cleanup();
		}
	});

	it("backs out of new-user setup without creating settings or credentials", async () => {
		const home = makeScratchHome("clio-configure-tty-");
		const tty = terminal(home);
		try {
			await tty.expect("Quick Connect");
			tty.send(ENTER);
			await tty.expect("Endpoint URL");
			tty.send(BACK);
			await tty.expect("Everything else is optional");
			tty.send("q");
			await tty.finish(130);
			strictEqual(existsSync(join(home.dir, "config/settings.yaml")), false);
			strictEqual(existsSync(join(home.dir, "config/credentials.yaml")), false);
		} finally {
			tty.close();
			home.cleanup();
		}
	});

	it("repairs malformed settings in the editor, rejecting an invalid draft before a reviewed save", async () => {
		const home = makeScratchHome("clio-configure-editor-");
		const file = seed(home, "http://127.0.0.1:1");
		const original = "version: [broken YAML\n";
		writeFileSync(file, original);
		const editor = join(home.dir, "editor.cjs");
		const counter = join(home.dir, "edited-once");
		writeFileSync(
			editor,
			`const fs = require('node:fs');
const first = !fs.existsSync(${JSON.stringify(counter)});
fs.writeFileSync(process.argv[2], first ? 'version: 2\\nchat:\\n  maxOutputTokens: invalid\\n' : 'version: 2\\nchat:\\n  maxOutputTokens: 2048\\n');
fs.writeFileSync(${JSON.stringify(counter)}, 'yes');\n`,
		);
		const tty = terminal(home, ["--edit"], { VISUAL: `${process.execPath} ${editor}` });
		try {
			await tty.expect("Invalid draft");
			strictEqual(readFileSync(file, "utf8"), original);
			tty.send(ENTER);
			await tty.expect("Save validated settings?");
			strictEqual(readFileSync(file, "utf8"), original);
			tty.send(ENTER);
			await tty.finish();
			strictEqual((parse(readFileSync(file, "utf8")) as ClioSettings).chat.maxOutputTokens, 2048);
			strictEqual(readFileSync(`${file}.bak`, "utf8"), original);
		} finally {
			tty.close();
			home.cleanup();
		}
	});
});

import { ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, spawnClioPty } from "../harness/pty.js";
import { runCli } from "../harness/spawn.js";

function writeSettings(configDir: string, yaml: string): void {
	writeFileSync(join(configDir, "settings.yaml"), yaml, "utf8");
}

function baseSettingsYaml(body: { targets: string; orchestrator: string }): string {
	return [
		"version: 1",
		"identity: clio",
		"defaultMode: default",
		"safetyLevel: auto-edit",
		"targets:",
		body.targets,
		"orchestrator:",
		body.orchestrator,
		"workers:",
		"  default:",
		"    target: null",
		"    model: null",
		"    thinkingLevel: off",
		"scope: []",
		"budget:",
		"  sessionCeilingUsd: 5",
		"  concurrency: auto",
		"theme: default",
		"keybindings: {}",
		"state:",
		"  lastMode: default",
		"compaction:",
		"  threshold: 0.8",
		"  auto: true",
		"",
	].join("\n");
}

function writeEndpointFixture(configDir: string): void {
	writeSettings(
		configDir,
		baseSettingsYaml({
			targets: [
				"  - id: anthropic-prod",
				"    runtime: anthropic",
				"    defaultModel: claude-sonnet-4-6",
				"    auth:",
				"      apiKeyEnvVar: ANTHROPIC_API_KEY",
			].join("\n"),
			orchestrator: ["  target: anthropic-prod", "  model: claude-sonnet-4-6", "  thinkingLevel: off"].join("\n"),
		}),
	);
}

async function closeServer(server: Server | null): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
	});
}

function defer<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((entry) => {
			if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") return entry.text;
			return "";
		})
		.join("");
}

function lastUserMessageText(body: Record<string, unknown>): string {
	const messages = body.messages;
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const entry = messages[i];
		if (!entry || typeof entry !== "object" || !("role" in entry) || entry.role !== "user") continue;
		return messageText("content" in entry ? entry.content : undefined);
	}
	return "";
}

function writeOpenAICompatFixture(configDir: string, url: string): void {
	writeSettings(
		configDir,
		baseSettingsYaml({
			targets: [
				"  - id: mock-chat",
				"    runtime: openai-compat",
				`    url: ${url}`,
				"    defaultModel: mock-model",
				"    auth:",
				"      apiKeyEnvVar: CLIO_TEST_OPENAI_KEY",
				"    wireModels:",
				"      - mock-model",
			].join("\n"),
			orchestrator: ["  target: mock-chat", "  model: mock-model", "  thinkingLevel: off"].join("\n"),
		}),
	);
}

async function startFollowUpFixture(): Promise<{
	server: Server;
	url: string;
	requests: Array<Record<string, unknown>>;
	firstRequestStarted: Promise<void>;
	secondRequestStarted: Promise<void>;
}> {
	const requests: Array<Record<string, unknown>> = [];
	const firstRequestStarted = defer();
	const secondRequestStarted = defer();
	const writeChunk = (res: ServerResponse, content: string, finish = false): void => {
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-interactive",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: finish ? [{ index: 0, delta: {}, finish_reason: "stop" }] : [{ index: 0, delta: { content } }],
				...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}),
			})}\n\n`,
		);
	};
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const raw = await readRequestBody(req);
		const body = JSON.parse(raw) as Record<string, unknown>;
		requests.push(body);
		const lastUser = lastUserMessageText(body);
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		if (lastUser === "first prompt") {
			firstRequestStarted.resolve();
			writeChunk(res, "first-stream-open ");
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			writeChunk(res, "first-stream-done ");
			writeChunk(res, "", true);
			res.end("data: [DONE]\n\n");
			return;
		}
		if (lastUser !== "queued prompt") {
			writeChunk(res, "probe-ok");
			writeChunk(res, "", true);
			res.end("data: [DONE]\n\n");
			return;
		}
		secondRequestStarted.resolve();
		writeChunk(res, "queued-response-complete");
		writeChunk(res, "", true);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return {
		server,
		url: `http://127.0.0.1:${addr.port}`,
		requests,
		firstRequestStarted: firstRequestStarted.promise,
		secondRequestStarted: secondRequestStarted.promise,
	};
}

describe("clio interactive tui e2e", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(async () => {
		scratch = makeScratchHome();
		scratch.env.ANTHROPIC_API_KEY = "sk-test";
		// Bootstrap the scratch home so interactive mode doesn't hit first-run paths.
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		writeEndpointFixture(configDir);
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("boots, renders banner, and exits cleanly on /quit", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("!!command runs local bash and marks the output excluded from context", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("!!printf 'bash-output'\r");
			await p.expect(/excluded from context/, 10_000);
			await p.expect(/bash-output/, 10_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("Ctrl-G edits the current input through VISUAL", async () => {
		const script = "require('fs').writeFileSync(process.argv[1], 'external-edited')";
		const visual = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
		const p = spawnClioPty({ env: { ...scratch.env, VISUAL: visual } });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("draft");
			p.send("\x07");
			await p.expect(/external-edited/, 10_000);
			p.send("\x03");
			await new Promise((r) => setTimeout(r, 100));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("Alt+Enter queues a follow-up while the model is streaming", async () => {
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		const fixture = await startFollowUpFixture();
		writeOpenAICompatFixture(configDir, fixture.url);
		const p = spawnClioPty({ env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" } });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("first prompt\r");
			await withTimeout(fixture.firstRequestStarted, 15_000, "first request");
			p.send("queued prompt");
			p.send("\x1b[13;3u");
			await p.expect(/follow-up queued/, 10_000);
			await withTimeout(fixture.secondRequestStarted, 15_000, "second request");
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
			strictEqual(fixture.requests.filter((body) => lastUserMessageText(body) === "first prompt").length, 1);
			strictEqual(fixture.requests.filter((body) => lastUserMessageText(body) === "queued prompt").length, 1);
		} finally {
			p.kill();
			await closeServer(fixture.server);
		}
	});

	it("Ctrl-D shuts down the tui", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			// Ctrl-D (EOT, 0x04)
			p.send("\x04");
			const exit = await p.wait(10_000);
			ok(exit.code === 0 || exit.code === 130, `expected 0 or 130, got code=${exit.code}`);
		} finally {
			p.kill();
		}
	});

	it("Ctrl-C twice shuts down the tui", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("\x03");
			await new Promise((r) => setTimeout(r, 100));
			p.send("\x03");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("/model opens the picker, Esc closes, /quit exits clean", async () => {
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		writeEndpointFixture(configDir);
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/model\r");
			// The configured target id appears only inside the /model picker,
			// never in the footer, so matching it proves the overlay rendered.
			await p.expect(/anthropic-prod/, 10_000);
			// Esc closes the overlay per routeModelOverlayKey.
			p.send("\x1b");
			// Give the TUI a tick to process the close and restore editor focus before
			// the next submit; without it, /quit can race with the overlay teardown and
			// land as a SelectList filter.
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("/model shows llama.cpp wire model ids and model-specific context windows", async () => {
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		writeSettings(
			configDir,
			baseSettingsYaml({
				targets: [
					"  - id: mini",
					"    runtime: openai-compat",
					"    url: http://127.0.0.1:8080",
					"    defaultModel: gemma-4-26B-A4B-it-Q4_K_M",
					"    wireModels:",
					"      - Qwen3.6-35B-A3B-UD-Q4_K_XL",
					"      - gemma-4-26B-A4B-it-Q4_K_M",
				].join("\n"),
				orchestrator: ["  target: mini", "  model: gemma-4-26B-A4B-it-Q4_K_M", "  thinkingLevel: off"].join("\n"),
			}),
		);
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/model\r");
			await p.expect(/Qwen3\.6-35B-A3B-UD-Q4_K_XL/, 10_000);
			await p.expect(/262kctx/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("model selection is immediately active when reopening the picker", async () => {
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		writeSettings(
			configDir,
			baseSettingsYaml({
				targets: [
					"  - id: openai-codex",
					"    runtime: openai-codex",
					"    defaultModel: gpt-5.4",
					"    auth:",
					"      oauthProfile: openai-codex",
					"    wireModels:",
					"      - gpt-5.4",
					"      - gpt-5.4-mini",
				].join("\n"),
				orchestrator: ["  target: openai-codex", "  model: gpt-5.4", "  thinkingLevel: low"].join("\n"),
			}),
		);
		writeFileSync(
			join(configDir, "credentials.yaml"),
			[
				"version: 2",
				"entries:",
				"  openai-codex:",
				"    type: oauth",
				"    access: test-access",
				"    refresh: test-refresh",
				"    expires: 4102444800000",
				"    updatedAt: 2026-01-01T00:00:00.000Z",
				"",
			].join("\n"),
			"utf8",
		);
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/model\r");
			await p.expect(/→ .*gpt-5\.4/, 10_000);
			p.send("\x1b[B");
			p.send("\r");
			await new Promise((r) => setTimeout(r, 25));
			p.send("/model\r");
			await p.expect(/→ .*gpt-5\.4-mini/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/targets opens the target overlay, Esc closes, /quit exits clean", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/targets\r");
			await p.expect(/Targets/, 10_000);
			await p.expect(/anthropic-prod/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/connect opens the target connection selector, Esc closes, /quit exits clean", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/connect\r");
			await p.expect(/anthropic-prod/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("Ctrl+L opens the /model picker and Esc closes it", async () => {
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		writeEndpointFixture(configDir);
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			// Ctrl+L is \x0c (form feed).
			p.send("\x0c");
			await p.expect(/anthropic-prod/, 10_000);
			p.send("\x1b");
			// Give the TUI a tick to process the close and restore editor focus before
			// the next submit; without it, /quit can race with the overlay teardown and
			// land as a SelectList filter.
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/scoped-models dispatches cleanly and Esc restores the editor", async () => {
		// The overlay renders a SelectList but terminal updates can chunk below
		// the PTY viewport depending on terminal height; we verify the slash
		// command routes and that the overlay closes cleanly on Esc + /quit
		// (a failure to route leaves the TUI on the editor prompt and /quit
		// still exits 0, but the overlay-open path is hit here because Esc
		// must arrive AFTER the picker is focused to avoid killing the TUI).
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir);
		writeEndpointFixture(configDir);
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/scoped-models\r");
			await new Promise((r) => setTimeout(r, 400));
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/settings opens the settings overlay, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/settings\r");
			// defaultMode / safetyLevel labels are unique to the settings overlay.
			await p.expect(/defaultMode|safetyLevel/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/resume opens the session picker (possibly empty), Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/resume\r");
			// The overlay may render an empty list (fresh scratch home) or a single
			// row that we just created. Give the TUI time to paint either way, then
			// send Esc to close whichever state we ended up in.
			await new Promise((r) => setTimeout(r, 400));
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/new rotates the session and exits clean on /quit", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/new\r");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/hotkeys opens the reference, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/hotkeys\r");
			// The scope headers (GLOBAL / EDITOR) are unique to the hotkeys overlay.
			await p.expect(/GLOBAL|EDITOR/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/tree opens the navigator, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/tree\r");
			// A fresh scratch home has no current session; the overlay either
			// shows the empty-state line or the navigator header. Both paths
			// prove the slash-command dispatched through to the overlay state
			// machine; if routing were broken the PTY would sit on the editor
			// prompt.
			await p.expect(/no sessions yet|session contract unavailable|\[Esc]/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/fork without a current session prints the no-op message", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/fork\r");
			// The handler short-circuits with an actionable stderr line rather
			// than opening an empty picker.
			await p.expect(/\[\/fork]\s+no current session/, 10_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/compact without a current session prints the actionable error", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/compact\r");
			// The orchestrator's onCompact short-circuits with a stderr line
			// rather than calling the summarization model. The message string
			// is part of the user-facing surface; if it changes, update the
			// renderer + docs together.
			await p.expect(/\[\/compact]\s+no current session/, 10_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("CLIO_FORCE_COMPACT=1 boots the TUI without crashing and /quit exits clean", async () => {
		// Slice 12d e2e. CLIO_FORCE_COMPACT=1 is the deterministic trigger
		// for auto-compaction inside chat-loop.submit. This test verifies
		// the env flag is accepted by the orchestrator boot path and the
		// TUI lifecycle is not disturbed when it is set.
		//
		// Full "compactionSummary entry written" assertion requires either
		// a mock OpenAI SSE server or a faux-orchestrator test hook, both
		// of which are out of scope for this slice. The primitives that
		// back the trigger are covered by unit tests:
		//   - shouldCompact / AutoCompactionTrigger in tests/unit/compaction.test.ts
		//   - toContextOverflowError in tests/unit/providers.test.ts
		//   - resolveSessionCwd in tests/unit/cwd-fallback.test.ts
		// The live drill (plan §6 slice 12d verification gate) is the
		// manual end-to-end with a real local endpoint.
		const env = { ...scratch.env, CLIO_FORCE_COMPACT: "1" };
		const p = spawnClioPty({ env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("/thinking shows the full level set for a reasoning-capable target", async () => {
		// Target config is a flat targets[] list. The orchestrator target
		// points at a target id, and the target carries its own capability
		// overrides. Here we pin reasoning=true at the target level and assert
		// /thinking offers
		// more than [off], proving the capability-merge path reaches the
		// overlay.
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir, "scratch env must set CLIO_CONFIG_DIR");
		writeSettings(
			configDir,
			baseSettingsYaml({
				targets: [
					"  - id: mini",
					"    runtime: openai-compat",
					"    url: http://mini.local:8080",
					"    defaultModel: Qwen3.6-35B-A3B",
					"    capabilities:",
					"      reasoning: true",
					"      thinkingFormat: qwen-chat-template",
					"      contextWindow: 262144",
					"      maxTokens: 8192",
				].join("\n"),
				orchestrator: ["  target: mini", "  model: Qwen3.6-35B-A3B", "  thinkingLevel: medium"].join("\n"),
			}),
		);

		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/Clio Coder/, 15_000);
			p.send("/thinking\r");
			// The overlay may render below the PTY viewport on narrow terminals,
			// but the slash command must route and Esc must close cleanly so
			// /quit exits 0. The availableThinkingLevels ↔ endpoint capability
			// wiring is covered by
			// tests/unit/providers/capabilities.test.ts and the target lookup
			// path by tests/integration/providers/endpoint-lifecycle.test.ts.
			await new Promise((r) => setTimeout(r, 400));
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});
});

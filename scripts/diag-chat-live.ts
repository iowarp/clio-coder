import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GOLDPATH_SETTINGS = "/tmp/clio-goldpath-51034/settings.yaml";
const PROMPT = "Say exactly PONG.";
const STREAM_TIMEOUT_MS = 180_000;
const failures: string[] = [];

function emit(status: "OK" | "FAIL" | "SKIP" | "INFO", label: string, detail?: string): void {
	const suffix = detail ? ` ${detail}` : "";
	const line = `[diag-chat-live] ${status.padEnd(4)} ${label}${suffix}\n`;
	if (status === "FAIL") process.stderr.write(line);
	else process.stdout.write(line);
}

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		emit("OK", label);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	emit("FAIL", label, detail ? `(${detail})` : undefined);
}

function readUtf8(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeText(stream: NodeJS.WritableStream, text: string, delayMs = 5): Promise<void> {
	for (const char of text) {
		stream.write(char);
		await sleep(delayMs);
	}
}

async function waitForResult(
	label: string,
	probe: () => { ok: true; detail: string } | { ok: false; detail: string },
	timeoutMs = 20_000,
	pollMs = 25,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastDetail = "";
	while (Date.now() <= deadline) {
		const result = probe();
		lastDetail = result.detail;
		if (result.ok) return result.detail;
		await sleep(pollMs);
	}
	throw new Error(`${label}: ${lastDetail}`);
}

async function run(): Promise<void> {
	if (process.env.CLIO_DIAG_LIVE !== "1") {
		emit("SKIP", "CLIO_DIAG_LIVE!=1");
		return;
	}
	if (!existsSync(GOLDPATH_SETTINGS)) {
		check("settings:file-present", false, GOLDPATH_SETTINGS);
		process.exit(1);
	}

	const projectRoot = process.cwd();
	const tempRoot = mkdtempSync(join(tmpdir(), "clio-diag-chat-live-"));
	const childPath = join(projectRoot, ".diag-chat-live-child.ts");
	const writeLogPath = join(tempRoot, "diag-chat-live.log");
	const tsxPath = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
	const eventBusUrl = pathToFileURL(join(projectRoot, "src/core/event-bus.ts")).href;
	const configUrl = pathToFileURL(join(projectRoot, "src/core/config.ts")).href;
	const xdgUrl = pathToFileURL(join(projectRoot, "src/core/xdg.ts")).href;
	const chatLoopUrl = pathToFileURL(join(projectRoot, "src/interactive/chat-loop.ts")).href;
	const interactiveUrl = pathToFileURL(join(projectRoot, "src/interactive/index.ts")).href;

	const childSource = `
import { readSettings } from ${JSON.stringify(configUrl)};
import { clioDataDir } from ${JSON.stringify(xdgUrl)};
import { createSafeEventBus } from ${JSON.stringify(eventBusUrl)};
import { createChatLoop } from ${JSON.stringify(chatLoopUrl)};
import { startInteractive } from ${JSON.stringify(interactiveUrl)};

const KNOWN_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"google",
	"groq",
	"mistral",
	"openrouter",
	"amazon-bedrock",
	"llamacpp",
	"lmstudio",
	"ollama",
	"openai-compat",
]);

const bus = createSafeEventBus();
const modes = {
	current: () => "default",
	setMode: (next) => next,
	cycleNormal: () => "default",
	visibleTools: () => new Set(["read", "write", "edit", "bash", "grep", "glob", "ls", "web_fetch"]),
	isToolVisible: () => true,
	isActionAllowed: () => true,
	requestSuper: () => {},
	confirmSuper: () => "super",
};

const settings = readSettings();
const orchestratorProvider = settings.orchestrator.provider ?? settings.provider.active ?? "llamacpp";
const providers = {
	list: () => [
		{
			id: orchestratorProvider,
			displayName: orchestratorProvider,
			tier: "native",
			available: true,
			reason: "diag",
			health: {
				providerId: orchestratorProvider,
				status: "healthy",
				lastCheckAt: null,
				lastError: null,
				latencyMs: null,
			},
		},
	],
	getAdapter: () => null,
	probeAll: async () => {},
	probeEndpoints: async () => {},
	probeAllLive: async () => {},
	probeEndpointsLive: async () => {},
	credentials: {
		hasKey: () => false,
		set: () => {},
		remove: () => {},
	},
};

const observability = {
	telemetry: () => ({ counters: {}, histograms: {} }),
	metrics: () => ({ counters: {}, histograms: {} }),
	sessionCost: () => 0,
	costEntries: () => [],
	recordTokens: () => {},
};

const dispatch = {
	dispatch: async () => {
		throw new Error("dispatch not used in diag-chat-live");
	},
	listRuns: () => [],
	getRun: () => null,
	abort: () => {},
	drain: async () => {},
};

const chat = createChatLoop({
	getSettings: () => readSettings(),
	modes,
	knownProviders: () => KNOWN_PROVIDERS,
});

chat.onEvent((event) => {
	if (event.type === "thinking_delta") {
		process.stderr.write("[child] thinking " + event.partialThinking.replace(/\\s+/g, " ").trim() + "\\n");
	}
	if (event.type === "text_delta") {
		process.stderr.write("[child] text " + event.partialText.replace(/\\s+/g, " ").trim() + "\\n");
	}
});

async function main() {
	const run = startInteractive({
		bus,
		modes,
		providers,
		dispatch,
		observability,
		chat,
		dataDir: clioDataDir(),
		onShutdown: async () => {},
	});
	process.stderr.write("[child] ready\\n");
	const code = await run;
	process.stderr.write("[child] exit " + String(code) + "\\n");
	process.exit(code);
}

main().catch((err) => {
	process.stderr.write("[child] crash " + (err instanceof Error ? err.stack ?? err.message : String(err)) + "\\n");
	process.exit(1);
});
`;

	writeFileSync(join(tempRoot, "settings.yaml"), readFileSync(GOLDPATH_SETTINGS, "utf8"));
	writeFileSync(childPath, childSource, "utf8");

	const child: ChildProcessWithoutNullStreams = spawn(tsxPath, [childPath], {
		cwd: projectRoot,
		env: {
			...process.env,
			CLIO_HOME: tempRoot,
			PI_TUI_WRITE_LOG: writeLogPath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});

	try {
		await waitForResult("child-ready", () => ({
			ok: stderr.includes("[child] ready\n"),
			detail: stderr,
		}));

		const startMs = Date.now();
		await typeText(child.stdin, PROMPT);
		child.stdin.write("\r");

		await waitForResult(
			"thinking-delta",
			() => ({
				ok: stderr.includes("[child] thinking "),
				detail: stderr,
			}),
			STREAM_TIMEOUT_MS,
		);
		await waitForResult(
			"text-delta-pong",
			() => ({
				ok: stderr.includes("[child] text PONG"),
				detail: stderr,
			}),
			STREAM_TIMEOUT_MS,
		);
		const rendered = await waitForResult(
			"chat-panel-renders-pong",
			() => {
				const log = readUtf8(writeLogPath);
				return {
					ok: log.includes("clio: PONG"),
					detail: log,
				};
			},
			STREAM_TIMEOUT_MS,
		);

		emit("INFO", "elapsed-ms", String(Date.now() - startMs));
		check("event:thinking-delta-seen", stderr.includes("[child] thinking "), stderr);
		check("event:text-delta-contains-pong", stderr.includes("[child] text PONG"), stderr);
		check("panel:renders-pong", rendered.includes("clio: PONG"), rendered);

		child.stdin.write("\x04");
		const exit = await Promise.race([
			exitPromise,
			sleep(10_000).then(() => {
				throw new Error(`child-exit-timeout: ${stderr}`);
			}),
		]);
		if (exit.signal !== null) {
			throw new Error(`child-exit-signal: ${JSON.stringify(exit)}`);
		}
		check("child:exit-cleanly", exit.code === 0, JSON.stringify(exit));
	} finally {
		if (child.exitCode === null && !child.killed) {
			child.kill("SIGKILL");
			await exitPromise.catch(() => {});
		}
		rmSync(childPath, { force: true });
		rmSync(tempRoot, { recursive: true, force: true });
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-chat-live] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-chat-live] PASS\n");
}

run().catch((err) => {
	process.stderr.write(`[diag-chat-live] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});

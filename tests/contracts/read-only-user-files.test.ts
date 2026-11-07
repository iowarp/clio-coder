import { deepEqual, equal, match, ok } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import {
	closeServer,
	type OpenAICompatFixture,
	type OpenAICompatToolCallScript,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// The 0.7.0 read-only contract: no file outside Clio's home changes. Clio still
// writes its own home, so a read-only run keeps its session. The test
// fingerprints the workspace (less Clio's project directory, and with its Git
// metadata, where a workspace snapshot would land) and a sentinel directory
// outside both, and never looks at the home.

const root = mkdtempSync(join(tmpdir(), "clio-coder-read-only-user-files-"));
const home = join(root, "home");
const work = join(root, "work");
const sentinel = join(root, "sentinel");
const runTmp = join(root, "tmp");
const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
let fixture: OpenAICompatFixture;
/** The tool call the fixture answers a main-agent turn with; null replies with text. */
let mainToolCall: OpenAICompatToolCallScript | null = null;
/** The tool results the main agent sent back, newest last. */
const toolResults: string[] = [];
/** The tool call a dispatched worker's first turn makes, and the results it sent back. */
let workerToolCall: OpenAICompatToolCallScript | null = null;
const workerResults: string[] = [];

before(async () => {
	fixture = await startOpenAICompatFixture("done", {
		toolCall: (request) => {
			// Only a read-only worker's conversation carries the dispatch read-only section.
			const worker = JSON.stringify(request.messages ?? []).includes("# Read-only run");
			const result = lastToolResult(request);
			if (result === null) return worker ? workerToolCall : mainToolCall;
			(worker ? workerResults : toolResults).push(result);
			return null;
		},
	});
	mkdirSync(join(home, "config"), { recursive: true });
	mkdirSync(work);
	mkdirSync(sentinel);
	mkdirSync(runTmp);
	writeFileSync(join(work, "notes.txt"), "workspace\n");
	// Older than the index, so a later `git status` finds it clean and rewrites nothing.
	const past = new Date(Date.now() - 3_600_000);
	utimesSync(join(work, "notes.txt"), past, past);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
			cwd: work,
			stdio: "ignore",
		});
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("status", "--porcelain");
	writeFileSync(join(sentinel, "keep.txt"), "sentinel\n");
	writeFileSync(join(home, "config", "settings.yaml"), DEFAULT_SETTINGS_YAML);
	seedOpenAICompatToolOrchestrator(join(home, "config"), fixture.url);
});
after(async () => {
	await closeServer(fixture.server);
	rmSync(root, { recursive: true, force: true });
});

function lastToolResult(request: Record<string, unknown>): string | null {
	const messages = request.messages;
	if (!Array.isArray(messages)) return null;
	const tool = messages.filter((message) => (message as { role?: unknown }).role === "tool").at(-1) as
		| { content?: unknown }
		| undefined;
	if (tool === undefined) return null;
	return typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
}

const bwrap = (() => {
	const availability = sandboxAvailability();
	return availability.available && availability.backend === "bwrap";
})();

function writeSettings(change: (settings: Record<string, Record<string, unknown>>) => void = () => {}): void {
	const file = join(home, "config", "settings.yaml");
	writeFileSync(file, DEFAULT_SETTINGS_YAML);
	seedOpenAICompatToolOrchestrator(join(home, "config"), fixture.url);
	const settings = parseYaml(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
	change(settings);
	writeFileSync(file, stringifyYaml(settings));
}

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function clio(args: string[]): Promise<Result> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...scratchClioEnvVars(home),
		HOME: home,
		TMPDIR: runTmp,
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
	};
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry, ...args], {
			cwd: work,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/** Every entry under `dir` with its kind, mode, size, mtime and content hash; `skip` names top-level entries left out. */
function fingerprint(dir: string, skip: ReadonlyArray<string> = []): string[] {
	const rows: string[] = [];
	const walk = (current: string): void => {
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			if (current === dir && skip.includes(name)) continue;
			const stat = lstatSync(path);
			const facts = `${relative(dir, path)}\t${stat.mode}\t${stat.mtimeMs}`;
			if (stat.isDirectory()) {
				rows.push(`${facts}\td`);
				walk(path);
			} else {
				const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
				rows.push(`${facts}\t${stat.size}\t${digest}`);
			}
		}
	};
	walk(dir);
	return rows.sort();
}

const userFiles = () => ({ workspace: fingerprint(work, [".clio-coder"]), sentinel: fingerprint(sentinel) });

function sessionIds(): string[] {
	const dir = join(home, "state", "sessions");
	if (!existsSync(dir)) return [];
	const ids: string[] = [];
	const walk = (current: string): void => {
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			if (lstatSync(path).isDirectory()) walk(path);
			else ids.push(relative(dir, path));
		}
	};
	walk(dir);
	return ids.sort();
}

describe("--read-only leaves every user file unchanged", { timeout: 600_000 }, () => {
	let baseline: ReturnType<typeof userFiles>;
	before(() => {
		baseline = userFiles();
	});

	it("a read-only run keeps its session, and --continue resumes it read-only", async () => {
		mainToolCall = null;
		const before = sessionIds();
		const first = await clio(["--no-context-files", "run", "--read-only", "Say done."]);
		equal(first.code, 0, first.stderr);
		match(first.stderr, /clio-coder run: session \S+\n/u);
		ok(!/not kept|keeps no session|writes nothing to the Clio home/u.test(first.stderr), first.stderr);
		const recorded = sessionIds();
		ok(recorded.length > before.length, "the read-only run recorded its session");
		const resumed = await clio(["--no-context-files", "run", "--read-only", "--continue", "Say done again."]);
		equal(resumed.code, 0, resumed.stderr);
		deepEqual(userFiles(), baseline);
	});

	// One command tries the workspace, the sentinel and Clio's state root,
	// then writes its private /tmp, which is where TMPDIR points. The state
	// path is assembled at run time, so the sandbox, not the floor's reading
	// of the command text, is what keeps it out.
	const shellCommand = (): string =>
		[
			`echo changed > ${join(work, "notes.txt")}`,
			`echo changed > ${join(sentinel, "keep.txt")}`,
			`touch ${join(work, "planted.txt")} ${join(sentinel, "planted.txt")}`,
			`s=sta; touch "${home}/$\{s}te/planted"`,
			`echo scratch > "$TMPDIR/probe" && echo "tmp-ok $TMPDIR"`,
			`touch ${join(work, "planted.txt")}`,
		].join("; ");

	for (const autonomy of ["default", "yolo"] as const) {
		it(`a contained shell command runs at ${autonomy} and changes no user file`, { skip: !bwrap }, async () => {
			writeSettings();
			mainToolCall = { name: "bash", arguments: { command: shellCommand() } };
			toolResults.length = 0;
			await clio(["--no-context-files", "run", "--read-only", "--autonomy", autonomy, "Run the probe."]);
			const output = toolResults.join("\n");
			match(output, /tmp-ok \/tmp\b/u, output);
			match(output, /this run is read-only, so this command could write only to its scratch directory/u, output);
			equal(existsSync(join(home, "state", "planted")), false, "Clio's state root stays read-only to the command");
			deepEqual(userFiles(), baseline);
		});
	}

	it("an unsandboxed or uncontained shell command is refused", async () => {
		writeSettings((settings) => {
			settings.safety = { ...settings.safety, sandbox: "off" };
		});
		mainToolCall = { name: "bash", arguments: { command: shellCommand() } };
		toolResults.length = 0;
		await clio(["--no-context-files", "run", "--read-only", "Run the probe."]);
		match(toolResults.join("\n"), /bash denied: this (?:run|task) is read-only/u);
		writeSettings();
		mainToolCall = { name: "bash", arguments: { command: shellCommand(), unsandboxed: true } };
		toolResults.length = 0;
		await clio(["--no-context-files", "run", "--read-only", "Run the probe."]);
		match(toolResults.join("\n"), /bash denied: this (?:run|task) is read-only/u);
		deepEqual(userFiles(), baseline);
	});

	// The worker is a coder, a workspace-edit recipe, so only the inherited
	// constraint makes it read-only.
	const workerWrite = (): OpenAICompatToolCallScript => ({
		name: "write",
		arguments: { path: join(work, "notes.txt"), content: "changed by a worker\n" },
	});

	it("a dispatched worker inherits read-only and changes no user file", async () => {
		writeSettings();
		mainToolCall = { name: "dispatch", arguments: { agent: "coder", task: "Rewrite notes.txt." } };
		workerToolCall = workerWrite();
		toolResults.length = 0;
		workerResults.length = 0;
		await clio(["--no-context-files", "run", "--read-only", "Delegate the edit."]);
		ok(toolResults.length > 0, "the main agent got the dispatch result");
		ok(!/dispatch denied/u.test(toolResults.join("\n")), toolResults.join("\n"));
		match(workerResults.join("\n"), /write denied: this (?:run|task) is read-only/u, workerResults.join("\n"));
		deepEqual(userFiles(), baseline);
	});

	it("run --agent coder --read-only runs the worker read-only", async () => {
		writeSettings();
		mainToolCall = null;
		workerToolCall = workerWrite();
		workerResults.length = 0;
		await clio(["--no-context-files", "run", "--agent", "coder", "--read-only", "Rewrite notes.txt."]);
		match(workerResults.join("\n"), /write denied: this (?:run|task) is read-only/u, workerResults.join("\n"));
		deepEqual(userFiles(), baseline);
	});
});

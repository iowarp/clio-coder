import { deepEqual, equal, match, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
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
// fingerprints the workspace (less Clio's project directory) and a sentinel
// directory outside both, and never looks at the home.

const root = mkdtempSync(join(tmpdir(), "clio-coder-read-only-user-files-"));
const home = join(root, "home");
const work = join(root, "work");
const sentinel = join(root, "sentinel");
const runTmp = join(root, "tmp");
const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
let fixture: OpenAICompatFixture;
/** The tool call the fixture answers a main-agent turn with; null replies with text. */
let mainToolCall: OpenAICompatToolCallScript | null = null;

before(async () => {
	fixture = await startOpenAICompatFixture("done", {
		toolCall: (request) => (hasToolResult(request) ? null : mainToolCall),
	});
	mkdirSync(join(home, "config"), { recursive: true });
	mkdirSync(work);
	mkdirSync(sentinel);
	mkdirSync(runTmp);
	writeFileSync(join(work, "notes.txt"), "workspace\n");
	writeFileSync(join(sentinel, "keep.txt"), "sentinel\n");
	writeFileSync(join(home, "config", "settings.yaml"), DEFAULT_SETTINGS_YAML);
	seedOpenAICompatToolOrchestrator(join(home, "config"), fixture.url);
});
after(async () => {
	await closeServer(fixture.server);
	rmSync(root, { recursive: true, force: true });
});

function hasToolResult(request: Record<string, unknown>): boolean {
	const messages = request.messages;
	return Array.isArray(messages) && messages.some((message) => (message as { role?: unknown }).role === "tool");
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
});

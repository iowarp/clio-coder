import { deepEqual, equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// The 0.7.0 contract: `--read-only` writes nothing to a set-up Clio home. One
// writable run sets the home up with a session, telemetry and run records; every
// read-only surface after it must leave the whole tree byte for byte as it was.

const root = mkdtempSync(join(tmpdir(), "clio-coder-read-only-home-"));
const home = join(root, "home");
const work = join(root, "work");
const runTmp = join(root, "tmp");
const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
let fixture: OpenAICompatFixture;

before(async () => {
	fixture = await startOpenAICompatFixture("done");
	mkdirSync(join(home, "config"), { recursive: true });
	mkdirSync(work);
	mkdirSync(runTmp);
	writeFileSync(join(home, "config", "settings.yaml"), DEFAULT_SETTINGS_YAML);
	seedOpenAICompatOrchestrator(join(home, "config"), fixture.url);
});
after(async () => {
	await closeServer(fixture.server);
	rmSync(root, { recursive: true, force: true });
});

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function clio(args: string[], stdin?: (child: ReturnType<typeof spawn>) => void): Promise<Result> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...scratchClioEnvVars(home),
		HOME: home,
		TMPDIR: runTmp,
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
	};
	delete env.NODE_COMPILE_CACHE;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry, ...args], {
			cwd: work,
			env,
			stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
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
		stdin?.(child);
	});
}

/** Every entry under the home with its kind, mode, size, mtime and content hash. */
function treeHash(): string[] {
	const rows: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = lstatSync(path);
			const facts = `${relative(home, path)}\t${stat.mode}\t${stat.mtimeMs}`;
			if (stat.isDirectory()) {
				rows.push(`${facts}\td`);
				walk(path);
			} else {
				const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
				rows.push(`${facts}\t${stat.size}\t${digest}`);
			}
		}
	};
	walk(home);
	return rows.sort();
}

describe("--read-only leaves a set-up Clio home unchanged", { timeout: 300_000 }, () => {
	let baseline: string[] = [];
	it("a writable run sets the home up with a session and its records", async () => {
		const setup = await clio(["--no-context-files", "run", "Say done."]);
		equal(setup.code, 0, setup.stderr);
		baseline = treeHash();
		ok(
			baseline.some((row) => row.startsWith(join("state", "sessions"))),
			"the writable run kept its session",
		);
	});

	const surfaces: Array<[string, string[], ((child: ReturnType<typeof spawn>) => void)?]> = [
		["run --read-only", ["--no-context-files", "run", "--read-only", "Say done."]],
		["run --read-only --continue", ["--no-context-files", "run", "--read-only", "--continue", "Say done."]],
		["run --read-only --agent", ["--no-context-files", "run", "--read-only", "--agent", "coder", "--json", "Say done."]],
		["doctor", ["doctor"]],
	];
	for (const [name, args, stdin] of surfaces) {
		it(`${name} writes nothing to it`, async () => {
			const requests = fixture.requests.length;
			const result = await clio(args, stdin);
			if (name === "doctor") ok(result.stdout.includes("Clio Coder version"), result.stdout + result.stderr);
			else {
				// The fixture's plain "done" does not satisfy a dispatched agent's result
				// contract, so that run fails after its worker's model calls; only the home matters.
				ok(name.endsWith("--agent") ? result.code === 1 : result.code === 0, `${result.stderr}\n${result.stdout}`);
				ok(fixture.requests.length > requests, `${name} reached the model`);
			}
			deepEqual(treeHash(), baseline, `${name} changed the Clio home`);
		});
	}

	it("left no private home behind", () => {
		deepEqual(
			readdirSync(runTmp).filter((name) => name.startsWith("clio-coder-read-only-")),
			[],
		);
	});
});

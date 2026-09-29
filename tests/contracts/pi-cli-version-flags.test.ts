import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { piCliRuntime } from "../../src/domains/providers/runtimes/external-cli-peers.js";
import { buildPiCliArgs, startPiCliWorkerRun } from "../../src/engine/external-cli/pi.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";

/**
 * Pi 0.99.0 stopped loading its builtin llama.cpp provider under
 * `--no-extensions`, so the launcher asks the binary its version once and adds
 * `-e builtin:llama.cpp` only where that flag exists. The fake `pi` answers
 * `--version` from the scenario beside it and logs every probe and launch
 * there. Each case gets its own directory because the probe is cached per
 * resolved binary path for the life of the process.
 */

const FAKE_PI = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(process.argv[1]);
const scenario = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
if (process.argv[2] === "--version") {
  appendFileSync(join(here, "probes.log"), "probe\\n");
  process.stdout.write(scenario.version + "\\n");
  process.exitCode = scenario.versionExit;
} else {
  for await (const _chunk of process.stdin) {}
  appendFileSync(join(here, "launches.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
  for (const line of [
    { type: "session", id: "session-1" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PONG" }], stopReason: "stop", usage: { input: 2, output: 1 } } },
    { type: "agent_settled" },
  ]) process.stdout.write(JSON.stringify(line) + "\\n");
}
`;

const BUILTIN = "-e builtin:llama.cpp";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakePi(version: string, versionExit = 0): { root: string; binary: string } {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-pi-version-"));
	directories.push(root);
	const binary = join(root, "pi");
	writeFileSync(binary, FAKE_PI);
	chmodSync(binary, 0o755);
	writeFileSync(join(root, "scenario.json"), JSON.stringify({ version, versionExit }));
	return { root, binary };
}

function lines(path: string): string[] {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

const probes = (root: string): number => lines(join(root, "probes.log")).length;
const launches = (root: string): string[][] =>
	lines(join(root, "launches.jsonl")).map((line) => JSON.parse(line) as string[]);

function input(root: string, patch: Partial<WorkerRunInput> = {}): WorkerRunInput {
	return {
		systemPrompt: "Stay within the task.",
		agentId: "builder",
		task: "Reply PONG.",
		target: { id: "pi", runtime: piCliRuntime.id },
		runtime: piCliRuntime,
		wireModelId: "llamacpp/qwen",
		allowedTools: [],
		budget: { toolCalls: 20, readReserve: 0, synthesis: true, hardCap: 50 },
		autonomy: "default",
		cwd: root,
		...patch,
	};
}

function start(root: string, binary: string, patch: Partial<WorkerRunInput> = {}) {
	return startPiCliWorkerRun(input(root, patch), () => undefined, {
		binary,
		workspaceRoot: root,
		environment: { PATH: process.env.PATH, HOME: root },
	});
}

describe("Pi CLI launcher flags", { skip: process.platform === "win32" }, () => {
	it("adds the builtin llama.cpp provider only when the probe reports Pi 0.99.0 or newer", async () => {
		const rows: Array<[version: string, versionExit: number, builtin: boolean]> = [
			["0.98.7", 0, false],
			["0.99.0", 0, true],
			["1.2.0", 0, true],
			["pi built from source", 0, false],
			["0.99.0", 1, false],
		];
		await Promise.all(
			rows.map(async ([version, versionExit, builtin]) => {
				const label = `${version} exiting ${versionExit}`;
				const { root, binary } = fakePi(version, versionExit);
				const result = await start(root, binary).promise;
				equal(result.exitCode, 0, label);
				equal(probes(root), 1, label);
				const [args, ...rest] = launches(root);
				equal(rest.length, 0, label);
				ok(args, label);
				deepStrictEqual(args, buildPiCliArgs(input(root), builtin), label);
				ok(args.includes("--no-extensions"), label);
				equal(args.join(" ").includes(BUILTIN), builtin, label);
			}),
		);
	});

	it("shares one probe per binary across concurrent launches and a caller cancelled during it", async () => {
		const { root, binary } = fakePi("0.99.0");
		const caller = new AbortController();
		const cancelled = start(root, binary, { signal: caller.signal });
		// The probe is a subprocess, so it is still running when the caller gives up.
		caller.abort(new Error("operator pressed escape"));
		const concurrent = [start(root, binary), start(root, binary)];

		const stopped = await cancelled.promise;
		equal(stopped.exitCode, 1);
		const message = stopped.messages[0];
		equal(message?.role === "assistant" ? message.stopReason : undefined, "aborted");

		const results = await Promise.all(concurrent.map((handle) => handle.promise));
		deepStrictEqual(
			results.map((result) => result.exitCode),
			[0, 0],
		);
		equal(probes(root), 1, "one probe serves every launch of the binary");
		const launched = launches(root);
		equal(launched.length, 2, "the cancelled caller launched no worker");
		for (const args of launched) ok(args.join(" ").includes(BUILTIN), "the cancelled caller left the probe intact");
	});
});

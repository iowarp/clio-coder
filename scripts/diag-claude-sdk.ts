/**
 * Phase 8 diag. Hermetic smoke test for the Claude Agent SDK adapter and its
 * worker subprocess. Does NOT attempt to install `@anthropic-ai/claude-agent-sdk`.
 *
 * Asserts:
 *   1. claudeSdkAdapter.tier === "sdk".
 *   2. canSatisfy with empty credentials → ok:false.
 *   3. canSatisfy with ANTHROPIC_API_KEY present → ok:true.
 *   4. Build + spawn dist/worker/sdk-entry.js without the SDK installed;
 *      collect NDJSON, assert `sdk_missing` event present, exit code 2.
 *   5. RUNTIME_ADAPTERS includes an adapter with id "claude-sdk".
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { claudeSdkAdapter } from "../src/domains/providers/runtimes/claude-sdk.js";
import { RUNTIME_ADAPTERS } from "../src/domains/providers/runtimes/index.js";

interface NdjsonEvent {
	type: string;
	[key: string]: unknown;
}

const projectRoot = process.cwd();
const workerJs = path.join(projectRoot, "dist/worker/sdk-entry.js");

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-claude-sdk] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-claude-sdk] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function spawnWorker(): Promise<{ exitCode: number; events: NdjsonEvent[]; stderr: string }> {
	const child = spawn(process.execPath, [workerJs], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: projectRoot,
		env: { ...process.env },
	});

	const stdoutLines: string[] = [];
	let stdoutBuf = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdoutBuf += chunk.toString("utf8");
		while (true) {
			const nl = stdoutBuf.indexOf("\n");
			if (nl === -1) break;
			stdoutLines.push(stdoutBuf.slice(0, nl));
			stdoutBuf = stdoutBuf.slice(nl + 1);
		}
	});

	let stderrBuf = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBuf += chunk.toString("utf8");
	});

	// Empty stdin — the stub doesn't read a WorkerSpec.
	child.stdin.end();

	const exitCode: number = await new Promise((resolve, reject) => {
		child.on("close", (code) => resolve(code ?? -1));
		child.on("error", reject);
	});

	if (stdoutBuf.length > 0) {
		stdoutLines.push(stdoutBuf);
		stdoutBuf = "";
	}

	const events: NdjsonEvent[] = [];
	for (const line of stdoutLines) {
		if (line.trim().length === 0) continue;
		events.push(JSON.parse(line) as NdjsonEvent);
	}

	return { exitCode, events, stderr: stderrBuf };
}

async function main(): Promise<void> {
	// 1. tier
	check("adapter:tier-sdk", claudeSdkAdapter.tier === "sdk", `tier=${claudeSdkAdapter.tier}`);

	// 2. canSatisfy with no creds
	const verdictEmpty = claudeSdkAdapter.canSatisfy({ modelId: "x", credentialsPresent: new Set<string>() });
	check("canSatisfy:empty-creds-false", verdictEmpty.ok === false, `got ${JSON.stringify(verdictEmpty)}`);

	// 3. canSatisfy with creds
	const verdictFull = claudeSdkAdapter.canSatisfy({
		modelId: "x",
		credentialsPresent: new Set<string>(["ANTHROPIC_API_KEY"]),
	});
	check("canSatisfy:creds-present-true", verdictFull.ok === true, `got ${JSON.stringify(verdictFull)}`);

	// 5. registry contains adapter
	const inRegistry = RUNTIME_ADAPTERS.find((a) => String(a.id) === "claude-sdk");
	check("registry:contains-claude-sdk", inRegistry !== undefined, inRegistry ? "" : "not found");

	// 4. spawn worker stub
	console.log("[diag-claude-sdk] building dist/ ...");
	execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	if (!existsSync(workerJs)) {
		failures.push(`worker:dist-missing ${workerJs}`);
		process.stderr.write(`[diag-claude-sdk] FAIL worker:dist-missing ${workerJs}\n`);
	} else {
		const run = await spawnWorker();
		check("worker:exit-code-2", run.exitCode === 2, `exit=${run.exitCode}; stderr=${JSON.stringify(run.stderr.trim())}`);
		const types = run.events.map((e) => e.type);
		check("worker:emitted-sdk_missing", types.includes("sdk_missing"), `types=${JSON.stringify(types)}`);
		check("worker:emitted-agent_start", types.includes("agent_start"), `types=${JSON.stringify(types)}`);
		check("worker:emitted-agent_end", types.includes("agent_end"), `types=${JSON.stringify(types)}`);
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-claude-sdk] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-claude-sdk] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-claude-sdk] ERROR ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});

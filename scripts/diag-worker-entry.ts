/**
 * Worker subprocess end-to-end diag.
 *
 * Builds the worker bundle, spawns `dist/worker/entry.js` as a child process,
 * pipes a WorkerSpec over stdin, and asserts the worker produces the expected
 * NDJSON event stream. Uses the pi-ai faux provider so no network call is made
 * and no provider credentials are required.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

interface WorkerSpec {
	systemPrompt: string;
	task: string;
	providerId: string;
	modelId: string;
	sessionId?: string;
	apiKey?: string;
}

interface AgentEventShape {
	type: string;
	[key: string]: unknown;
}

interface WorkerRunDiag {
	exitCode: number;
	events: AgentEventShape[];
	eventTypes: string[];
	stderr: string;
}

const projectRoot = process.cwd();
const workerJs = path.join(projectRoot, "dist/worker/entry.js");

async function runWorker(spec: WorkerSpec, envOverrides: NodeJS.ProcessEnv): Promise<WorkerRunDiag> {
	const child = spawn(process.execPath, [workerJs], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			...envOverrides,
		},
		cwd: projectRoot,
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

	child.stdin.write(JSON.stringify(spec));
	child.stdin.end();

	const exitCode: number = await new Promise((resolve, reject) => {
		child.on("close", (code) => resolve(code ?? -1));
		child.on("error", reject);
	});

	if (stdoutBuf.length > 0) {
		stdoutLines.push(stdoutBuf);
		stdoutBuf = "";
	}

	const events: AgentEventShape[] = [];
	for (const line of stdoutLines) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line) as AgentEventShape);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`diag:worker-entry: non-JSON stdout line: ${JSON.stringify(line)} (${msg})`);
			process.exit(1);
		}
	}

	return {
		exitCode,
		events,
		eventTypes: events.map((event) => event.type),
		stderr: stderrBuf,
	};
}

console.log("diag:worker-entry: building dist/ ...");
execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
if (!existsSync(workerJs)) {
	console.error(`diag:worker-entry: build did not produce ${workerJs}`);
	process.exit(1);
}

const spec: WorkerSpec = {
	systemPrompt: "you are a test agent",
	task: "say hello",
	providerId: "faux",
	modelId: "faux-model",
};

const successEnv: NodeJS.ProcessEnv = {
	CLIO_WORKER_FAUX: "1",
	CLIO_WORKER_FAUX_MODEL: "faux-model",
	CLIO_WORKER_FAUX_TEXT: "hello from faux worker",
};
const errorEnv: NodeJS.ProcessEnv = {
	...successEnv,
	CLIO_WORKER_FAUX_STOP_REASON: "error",
	CLIO_WORKER_FAUX_ERROR_MESSAGE: "synthetic faux failure",
};

console.log(`diag:worker-entry: spawning ${path.relative(projectRoot, workerJs)} (success case) ...`);
const success = await runWorker(spec, successEnv);

console.log(`diag:worker-entry: spawning ${path.relative(projectRoot, workerJs)} (error case) ...`);
const failure = await runWorker(spec, errorEnv);

let failed = 0;
function assert(cond: boolean, label: string): void {
	if (cond) {
		console.log(`ok   ${label}`);
	} else {
		console.error(`FAIL ${label}`);
		failed++;
	}
}

assert(
	success.exitCode === 0,
	`worker success exit code is 0 (got ${success.exitCode}${success.stderr.length > 0 ? `; stderr: ${success.stderr.trim()}` : ""})`,
);
assert(success.eventTypes.includes("agent_start"), `success emitted at least one "agent_start" event`);
assert(success.eventTypes.includes("agent_end"), `success emitted at least one "agent_end" event`);
assert(success.events.length >= 2, `success emitted at least 2 events total (got ${success.events.length})`);

assert(
	failure.exitCode === 1,
	`worker error exit code is 1 (got ${failure.exitCode}${failure.stderr.length > 0 ? `; stderr: ${failure.stderr.trim()}` : ""})`,
);
assert(failure.eventTypes.includes("agent_start"), `error case emitted at least one "agent_start" event`);
assert(failure.eventTypes.includes("agent_end"), `error case emitted at least one "agent_end" event`);
assert(
	failure.stderr.includes("synthetic faux failure"),
	`error case logs faux failure to stderr (got ${JSON.stringify(failure.stderr.trim())})`,
);

if (failed > 0) {
	console.error(`\ndiag:worker-entry: ${failed} assertion(s) failed`);
	console.error(`success events (${success.events.length}): ${JSON.stringify(success.eventTypes)}`);
	console.error(`error events (${failure.events.length}): ${JSON.stringify(failure.eventTypes)}`);
	if (success.stderr.length > 0) console.error(`success stderr:\n${success.stderr}`);
	if (failure.stderr.length > 0) console.error(`error stderr:\n${failure.stderr}`);
	process.exit(1);
}

console.log(`\ndiag:worker-entry: ok (success=${success.events.length} events; error=${failure.events.length} events)`);

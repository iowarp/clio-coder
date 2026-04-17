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

const projectRoot = process.cwd();
const workerJs = path.join(projectRoot, "dist/worker/entry.js");

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

const env: NodeJS.ProcessEnv = {
	...process.env,
	CLIO_WORKER_FAUX: "1",
	CLIO_WORKER_FAUX_MODEL: "faux-model",
	CLIO_WORKER_FAUX_TEXT: "hello from faux worker",
};

console.log(`diag:worker-entry: spawning ${path.relative(projectRoot, workerJs)} ...`);
const child = spawn(process.execPath, [workerJs], {
	stdio: ["pipe", "pipe", "pipe"],
	env,
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

const eventTypes = events.map((e) => e.type);

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
	exitCode === 0,
	`worker exit code is 0 (got ${exitCode}${stderrBuf.length > 0 ? `; stderr: ${stderrBuf.trim()}` : ""})`,
);
assert(eventTypes.includes("agent_start"), `emitted at least one "agent_start" event`);
assert(eventTypes.includes("agent_end"), `emitted at least one "agent_end" event`);
assert(events.length >= 2, `emitted at least 2 events total (got ${events.length})`);

if (failed > 0) {
	console.error(`\ndiag:worker-entry: ${failed} assertion(s) failed`);
	console.error(`events seen (${events.length}): ${JSON.stringify(eventTypes)}`);
	if (stderrBuf.length > 0) console.error(`stderr:\n${stderrBuf}`);
	process.exit(1);
}

console.log(`\ndiag:worker-entry: ok (${events.length} events; types=${JSON.stringify(eventTypes)})`);

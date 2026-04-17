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
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { startWorkerRun, type EndpointSpec } from "../src/engine/worker-runtime.js";

interface WorkerSpec {
	systemPrompt: string;
	task: string;
	providerId: string;
	modelId: string;
	sessionId?: string;
	apiKey?: string;
	endpointName?: string;
	endpointSpec?: EndpointSpec;
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

interface StubServer {
	url: string;
	requests: Array<{ method: string; url: string; authorization: string; body: string }>;
	close(): Promise<void>;
}

function startStubOpenAIServer(): Promise<StubServer> {
	const requests: StubServer["requests"] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const authorization = String(req.headers.authorization ?? "");
			requests.push({ method: req.method ?? "", url: req.url ?? "", authorization, body });

			if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				const id = "stub-cmpl-1";
				const first = {
					id,
					object: "chat.completion.chunk",
					model: "stub-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }],
				};
				const last = {
					id,
					object: "chat.completion.chunk",
					model: "stub-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
				};
				res.write(`data: ${JSON.stringify(first)}\n\n`);
				res.write(`data: ${JSON.stringify(last)}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		});
	});

	return new Promise<StubServer>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				requests,
				close: () =>
					new Promise<void>((r) => {
						server.close(() => r());
					}),
			});
		});
	});
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

// Local-endpoint subprocess bootstrap. Spawn the worker against a stub OpenAI-compat
// HTTP server and assert that threading EndpointSpec through the WorkerSpec lets
// the worker resolve a local-engine model without re-reading settings.yaml. This
// guards against regressions of the S10 bootstrap gap (getModel throwing on
// llamacpp/lmstudio before emitting a single event).
const stub = await startStubOpenAIServer();
try {
	const endpointName = "stub";
	const localSpec: WorkerSpec = {
		systemPrompt: "you are a test agent",
		task: "reply pong",
		providerId: "openai-compat",
		modelId: `stub-model@${endpointName}`,
		endpointName,
		endpointSpec: {
			url: stub.url,
			default_model: "stub-model",
			api_key: "stub-bearer",
		},
	};
	console.log(`diag:worker-entry: spawning ${path.relative(projectRoot, workerJs)} (local-endpoint case) ...`);
	const local = await runWorker(localSpec, {});

	assert(
		local.exitCode === 0,
		`local-endpoint worker exit code is 0 (got ${local.exitCode}${local.stderr.length > 0 ? `; stderr: ${local.stderr.trim()}` : ""})`,
	);
	assert(
		local.eventTypes.includes("agent_start"),
		`local-endpoint worker emitted "agent_start" (did not fail fast in getModel)`,
	);
	assert(
		local.eventTypes.includes("text_delta") || local.eventTypes.includes("agent_end"),
		`local-endpoint worker streamed at least one text_delta or agent_end (got ${JSON.stringify(local.eventTypes)})`,
	);
	const completionCall = stub.requests.find((r) => r.url.endsWith("/chat/completions"));
	assert(
		completionCall !== undefined,
		`local-endpoint worker hit stub /v1/chat/completions (got ${JSON.stringify(stub.requests.map((r) => r.url))})`,
	);
	assert(
		completionCall?.authorization === "Bearer stub-bearer",
		`local-endpoint worker forwarded endpointSpec.api_key as Bearer (got ${JSON.stringify(completionCall?.authorization ?? null)})`,
	);

	console.log(`diag:worker-entry: running in-process bootstrap regression ...`);
	const inProcessLocalEvents: AgentEventShape[] = [];
	const inProcessLocal = startWorkerRun(localSpec, (event) => {
		inProcessLocalEvents.push(event as AgentEventShape);
	});
	const inProcessLocalResult = await inProcessLocal.promise;
	assert(
		inProcessLocalResult.exitCode === 0,
		`in-process local bootstrap succeeds before reuse check (got ${inProcessLocalResult.exitCode})`,
	);
	const requestsBeforeReuse = stub.requests.length;
	const reusedEvents: AgentEventShape[] = [];
	const reused = startWorkerRun(
		{
			systemPrompt: localSpec.systemPrompt,
			task: localSpec.task,
			providerId: localSpec.providerId,
			modelId: localSpec.modelId,
		},
		(event) => {
			reusedEvents.push(event as AgentEventShape);
		},
	);
	const reusedResult = await reused.promise;
	assert(
		reusedResult.exitCode !== 0,
		`reused in-process local worker without endpointSpec fails (got exit=${reusedResult.exitCode})`,
	);
	assert(
		stub.requests.length === requestsBeforeReuse,
		`reused in-process local worker without endpointSpec does not reuse the previous stub endpoint (before=${requestsBeforeReuse} after=${stub.requests.length} types=${JSON.stringify(reusedEvents.map((event) => event.type))})`,
	);

	// Sanity: a WorkerSpec for a local engine WITHOUT the endpointSpec must still
	// fail fast, proving the bootstrap depends on the new fields rather than some
	// unrelated fallback path.
	const bareSpec: WorkerSpec = {
		systemPrompt: "you are a test agent",
		task: "reply pong",
		providerId: "openai-compat",
		modelId: "stub-model@missing",
	};
	console.log(`diag:worker-entry: spawning ${path.relative(projectRoot, workerJs)} (missing-endpoint case) ...`);
	const bare = await runWorker(bareSpec, {});
	assert(bare.exitCode !== 0, `missing-endpoint worker fails when endpointSpec absent (got exit=${bare.exitCode})`);
	assert(
		bare.stderr.includes("stopReason=error") || bare.stderr.includes("getModel failed"),
		`missing-endpoint worker logs a terminal model-resolution error (got ${JSON.stringify(bare.stderr.trim())})`,
	);

	if (failed > 0) {
		console.error(`\ndiag:worker-entry: ${failed} assertion(s) failed`);
		console.error(`success events (${success.events.length}): ${JSON.stringify(success.eventTypes)}`);
		console.error(`error events (${failure.events.length}): ${JSON.stringify(failure.eventTypes)}`);
		console.error(`local events (${local.events.length}): ${JSON.stringify(local.eventTypes)}`);
		console.error(`bare events (${bare.events.length}): ${JSON.stringify(bare.eventTypes)}`);
		if (success.stderr.length > 0) console.error(`success stderr:\n${success.stderr}`);
		if (failure.stderr.length > 0) console.error(`error stderr:\n${failure.stderr}`);
		if (local.stderr.length > 0) console.error(`local stderr:\n${local.stderr}`);
		if (bare.stderr.length > 0) console.error(`bare stderr:\n${bare.stderr}`);
		process.exit(1);
	}

	console.log(
		`\ndiag:worker-entry: ok (success=${success.events.length} events; error=${failure.events.length} events; local=${local.events.length} events; bare=${bare.events.length} events)`,
	);
} finally {
	await stub.close();
}

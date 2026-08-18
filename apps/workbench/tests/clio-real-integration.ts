/**
 * Explicit, no-network joint proof for the Workbench -> Clio ACP boundary.
 *
 * The non-standard filename intentionally keeps this expensive built-binary
 * fixture out of `deno task test`. Run it only through `deno task
 * test:clio-real` after the source and app peers agree that both sides are
 * ready for the shared seam.
 */
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createLocalClioLauncher,
	type EngineContext,
	EngineCoordinator,
	type EngineEvent,
	type EngineProject,
	type EngineSink,
} from "../engine.ts";

const CLI_OVERRIDE = "CLIO_WORKBENCH_CLI_ENTRY";
const DEFAULT_CLI_ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
const SCRATCH_PARENT = fileURLToPath(new URL("../.artifacts/clio-real/", import.meta.url));
const PERMISSION_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const TOOL_CALL_ID = "call-workbench-write-1";
const NOTE_CONTENT = "hello from the Workbench joint proof";
const PROVIDER_REPLY = "the bounded joint proof is complete";
const API_KEY_NAME = "CLIO_CODER_TEST_OPENAI_KEY";
const API_KEY_VALUE = "sk-workbench-local-fixture";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MatchingEvent<E, T extends EngineEvent["type"]> = E extends { type: infer K }
	? T extends K ? E & { type: T } : never
	: never;
type EventOf<T extends EngineEvent["type"]> = MatchingEvent<EngineEvent, T>;
type PermissionDecision = "allow_once" | "reject_once";

class RecordingSink implements EngineSink {
	readonly events: EngineEvent[] = [];
	readonly refreshes: string[] = [];

	emit(event: EngineEvent): void {
		this.events.push(event);
	}

	refreshProject(projectId: string): Promise<void> {
		this.refreshes.push(projectId);
		return Promise.resolve();
	}

	ofType<T extends EngineEvent["type"]>(type: T): EventOf<T>[] {
		return this.events.filter((event): event is EventOf<T> => event.type === type);
	}
}

interface ProviderFixture {
	readonly url: string;
	readonly requests: Record<string, unknown>[];
	close(): Promise<void>;
}

interface CasePaths {
	readonly root: string;
	readonly home: string;
	readonly project: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

function boundedPath(value: string, label: string): string {
	if (value.length === 0 || value.trim() !== value || value.includes("\0") || utf8Bytes(value) > 4 * 1024) {
		throw new Error(`${label} must be a non-blank bounded path.`);
	}
	return value;
}

function selectedCliEntry(): string {
	const candidate = boundedPath(Deno.env.get(CLI_OVERRIDE) ?? DEFAULT_CLI_ENTRY, CLI_OVERRIDE);
	if (!isAbsolute(candidate) || basename(candidate) !== "index.js") {
		throw new Error(`${CLI_OVERRIDE} must be an absolute path to a built index.js entrypoint.`);
	}
	return candidate;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
		await delay(10);
	}
}

async function waitForEvent<T extends EngineEvent["type"]>(
	sink: RecordingSink,
	type: T,
	predicate: (event: EventOf<T>) => boolean = () => true,
): Promise<EventOf<T>> {
	await waitFor(() => sink.ofType(type).some(predicate), `${type} event`);
	const event = sink.ofType(type).find(predicate);
	ok(event);
	return event;
}

function assertOwnedScratch(path: string): void {
	const local = relative(SCRATCH_PARENT, path);
	if (local.length === 0 || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
		throw new Error("Refusing to operate outside the Workbench-owned scratch parent.");
	}
}

async function makeCasePaths(decision: PermissionDecision): Promise<CasePaths> {
	await Deno.mkdir(SCRATCH_PARENT, { recursive: true });
	const root = await Deno.makeTempDir({ dir: SCRATCH_PARENT, prefix: `workbench-clio-${decision}-` });
	assertOwnedScratch(root);
	const home = join(root, "home");
	const project = join(root, "project");
	await Promise.all([Deno.mkdir(home, { recursive: true }), Deno.mkdir(project, { recursive: true })]);
	return {
		root: await Deno.realPath(root),
		home: await Deno.realPath(home),
		project: await Deno.realPath(project),
	};
}

function isolatedClioEnv(home: string): Readonly<Record<string, string>> {
	return {
		CLIO_CODER_HOME: home,
		CLIO_CODER_CONFIG_DIR: join(home, "config"),
		CLIO_CODER_DATA_DIR: join(home, "data"),
		CLIO_CODER_STATE_DIR: join(home, "state"),
		CLIO_CODER_CACHE_DIR: join(home, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		[API_KEY_NAME]: API_KEY_VALUE,
	};
}

function boundedDiagnostic(value: Uint8Array, ownedRoot: string): string {
	return decoder.decode(value.slice(0, 2 * 1024)).replaceAll(ownedRoot, "[scratch]").trim();
}

async function runOwnedCommand(
	executable: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>>,
	description: string,
): Promise<Deno.CommandOutput> {
	const child = new Deno.Command(executable, {
		args: [...args],
		cwd,
		env: { ...env },
		clearEnv: true,
		stdin: "null",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	try {
		return await withTimeout(child.output(), COMMAND_TIMEOUT_MS, description);
	} catch (error) {
		try {
			child.kill("SIGKILL");
		} catch {
			// It may have exited between the deadline and the kill attempt.
		}
		await child.status.catch(() => undefined);
		throw error;
	}
}

function replaceRequired(source: string, pattern: RegExp, replacement: string, label: string): string {
	if (!pattern.test(source)) throw new Error(`doctor settings did not contain the expected ${label} field.`);
	return source.replace(pattern, replacement);
}

async function seedSettings(
	paths: CasePaths,
	node: string,
	cliEntry: string,
	providerUrl: string,
	env: Readonly<Record<string, string>>,
): Promise<void> {
	const doctor = await runOwnedCommand(
		node,
		[cliEntry, "doctor", "--fix"],
		paths.root,
		env,
		"the isolated doctor bootstrap",
	);
	if (!doctor.success) {
		throw new Error(
			`doctor --fix failed with exit ${doctor.code}: ${boundedDiagnostic(doctor.stderr, paths.root)}`,
		);
	}

	const settingsPath = join(paths.home, "config", "settings.yaml");
	let settings = await Deno.readTextFile(settingsPath);
	settings = replaceRequired(
		settings,
		/^targets:.*$/m,
		[
			"targets:",
			"  - id: mock-chat",
			"    runtime: openai-compat",
			`    url: ${providerUrl}`,
			"    defaultModel: mock-model",
			"    auth:",
			`      apiKeyEnvVar: ${API_KEY_NAME}`,
			"    capabilities:",
			"      chat: true",
			"      tools: true",
			"      toolCallFormat: openai",
			"      vision: true",
			"      contextWindow: 32768",
			"      maxTokens: 4096",
			"    wireModels:",
			"      - mock-model",
		].join("\n"),
		"targets",
	);
	settings = replaceRequired(settings, /^ {2}target: null$/m, "  target: mock-chat", "orchestrator.target");
	settings = replaceRequired(settings, /^ {2}model: null$/m, "  model: mock-model", "orchestrator.model");
	settings = replaceRequired(settings, /^autonomy:.*$/m, "autonomy: suggest", "autonomy");
	await Deno.writeTextFile(settingsPath, settings);
}

function hasToolExchange(request: Record<string, unknown>): boolean {
	if (!Array.isArray(request.messages)) return false;
	return request.messages.some((message) => {
		if (!isRecord(message)) return false;
		return message.role === "tool" || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
	});
}

function sseBody(chunks: readonly Record<string, unknown>[]): string {
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function streamingResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

function startProviderFixture(): ProviderFixture {
	const requests: Record<string, unknown>[] = [];
	const abort = new AbortController();
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, signal: abort.signal, onListen() {} },
		async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/v1/models") {
				return jsonResponse({ object: "list", data: [{ id: "mock-model", object: "model" }] });
			}
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				return new Response("not found", { status: 404 });
			}

			let body: unknown;
			try {
				body = JSON.parse(await request.text());
			} catch {
				return jsonResponse({ error: { message: "invalid fixture request" } }, 400);
			}
			if (!isRecord(body)) return jsonResponse({ error: { message: "invalid fixture request" } }, 400);
			requests.push(body);
			if (body.stream === false) {
				return jsonResponse({
					id: "chatcmpl-workbench-probe",
					object: "chat.completion",
					model: body.model ?? "mock-model",
					choices: [{ index: 0, message: { role: "assistant", content: PROVIDER_REPLY }, finish_reason: "stop" }],
				});
			}

			if (!hasToolExchange(body)) {
				return streamingResponse(sseBody([
					{
						id: "chatcmpl-workbench-tool",
						object: "chat.completion.chunk",
						created: 1,
						model: "mock-model",
						choices: [{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [{
									index: 0,
									id: TOOL_CALL_ID,
									type: "function",
									function: {
										name: "write",
										arguments: JSON.stringify({ path: "note.txt", content: NOTE_CONTENT }),
									},
								}],
							},
						}],
					},
					{
						id: "chatcmpl-workbench-tool",
						object: "chat.completion.chunk",
						created: 1,
						model: "mock-model",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
					},
				]));
			}

			return streamingResponse(sseBody([
				{
					id: "chatcmpl-workbench-text",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { content: PROVIDER_REPLY } }],
				},
				{
					id: "chatcmpl-workbench-text",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
				},
			]));
		},
	);
	const address = server.addr;
	if (address.transport !== "tcp" || address.hostname !== "127.0.0.1") {
		abort.abort();
		throw new Error("The provider fixture did not bind to the loopback TCP boundary.");
	}
	let closed = false;
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		async close() {
			if (closed) return;
			closed = true;
			abort.abort();
			await withTimeout(server.finished, 5_000, "the loopback provider to stop");
		},
	};
}

function projectFor(decision: PermissionDecision, trustedRoot: string): EngineProject {
	return {
		projectId: `project-clio-${decision.replace("_", "-")}`,
		trustedRoot,
		displayName: `Clio ${decision} joint proof`,
	};
}

function isTurnEvent(event: EngineEvent): event is Exclude<EngineEvent, { type: "engine.state" }> {
	return "context" in event;
}

function assertContextBinding(sink: RecordingSink, context: EngineContext): void {
	equal(context.projectId.startsWith("project-clio-"), true);
	equal(context.engineKind, "clio-acp");
	match(context.generation, /^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	equal(context.sessionId, "session-clio-0001");
	equal(context.turnId, "turn-clio-0001");
	const turnEvents = sink.events.filter(isTurnEvent);
	ok(turnEvents.length > 0, "the real turn produced no projected events");
	for (const event of turnEvents) deepStrictEqual(event.context, context);
	for (const event of sink.ofType("engine.state")) equal(event.projectId, context.projectId);
}

function assertProviderExchange(fixture: ProviderFixture): void {
	const streamed = fixture.requests.filter((request) => request.stream !== false);
	ok(streamed.length >= 2, `expected a tool round trip, received ${streamed.length} streaming request(s)`);
	equal(hasToolExchange(streamed[0] ?? {}), false);
	ok(Array.isArray(streamed[0]?.tools), "the tool-free request did not advertise tools");
	ok(streamed.slice(1).some(hasToolExchange), "the provider never received tool history");
}

function assertProjectedBoundary(sink: RecordingSink, paths: CasePaths, cliEntry: string): void {
	const projected = JSON.stringify(sink.events);
	for (
		const forbidden of [
			paths.root,
			paths.home,
			paths.project,
			cliEntry,
			TOOL_CALL_ID,
			NOTE_CONTENT,
			API_KEY_VALUE,
			"rawInput",
			"rawOutput",
		]
	) {
		ok(!projected.includes(forbidden), `projected EngineEvents leaked forbidden native data: ${forbidden}`);
	}
	for (const event of sink.ofType("turn.tool")) deepStrictEqual(event.locations, [["note.txt"]]);
	for (const event of sink.ofType("turn.permission.requested")) deepStrictEqual(event.locations, [["note.txt"]]);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return false;
		throw error;
	}
}

async function cleanup(
	engine: EngineCoordinator | null,
	fixture: ProviderFixture | null,
	paths: CasePaths | null,
): Promise<void> {
	const failures: unknown[] = [];
	if (engine !== null) {
		try {
			await withTimeout(engine.close(), CLEANUP_TIMEOUT_MS, "the EngineCoordinator cleanup");
		} catch (error) {
			failures.push(error);
		}
	}
	if (fixture !== null) {
		try {
			await fixture.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (paths !== null) {
		try {
			assertOwnedScratch(paths.root);
			await withTimeout(Deno.remove(paths.root, { recursive: true }), 5_000, "the owned scratch cleanup");
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "The joint fixture did not clean up within its bounds.");
}

async function runJointCase(decision: PermissionDecision): Promise<void> {
	let paths: CasePaths | null = null;
	let fixture: ProviderFixture | null = null;
	let engine: EngineCoordinator | null = null;
	try {
		// The task grants executable-scoped authority to this literal command. Deno
		// resolves it through the parent's PATH before applying the child's cleared
		// environment; accepting an absolute override would silently exceed the
		// task's --allow-run contract.
		const node = "node";
		const cliEntry = selectedCliEntry();
		paths = await makeCasePaths(decision);
		fixture = startProviderFixture();
		const env = isolatedClioEnv(paths.home);
		deepStrictEqual(
			Object.keys(env).sort(),
			[
				API_KEY_NAME,
				"CLIO_CODER_CACHE_DIR",
				"CLIO_CODER_CONFIG_DIR",
				"CLIO_CODER_DATA_DIR",
				"CLIO_CODER_HOME",
				"CLIO_CODER_REQUIRE_HOME_PREFIX",
				"CLIO_CODER_STATE_DIR",
			].sort(),
		);
		await seedSettings(paths, node, cliEntry, fixture.url, env);

		const launcher = createLocalClioLauncher({
			executable: node,
			prefixArgs: [cliEntry, "--no-context-files", "--no-skills"],
			env,
			clearEnv: true,
			permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
			probeTimeoutMs: 10_000,
		});
		const launch = launcher.launch(paths.project);
		equal(launch.command, node);
		deepStrictEqual(launch.args, [
			cliEntry,
			"--no-context-files",
			"--no-skills",
			"acp",
			"--cwd",
			paths.project,
			"--permission-timeout",
			String(PERMISSION_TIMEOUT_MS),
		]);
		equal(launch.cwd, paths.project);
		equal(launch.clearEnv, true);
		deepStrictEqual(launch.env, env);

		engine = new EngineCoordinator({
			launcher,
			eventDelayMs: 0,
			acpTiming: {
				permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
				writeTimeoutMs: 3_000,
				cancelGraceMs: 5_000,
				closeTimeoutMs: 3_000,
				exitGraceMs: 2_000,
				termGraceMs: 500,
				killObservationMs: 3_000,
			},
		});
		const sink = new RecordingSink();
		const project = projectFor(decision, paths.project);
		engine.select(sink, project, "clio-acp");
		const readiness = await engine.probe(sink, project);
		equal(readiness.kind, "clio-acp");
		equal(readiness.phase, "ready");
		equal(readiness.facts.find((fact) => fact.key === "runtime")?.state, "ready");
		equal(readiness.facts.find((fact) => fact.key === "protocol")?.state, "ready");
		equal(readiness.facts.find((fact) => fact.key === "project")?.state, "ready");

		const context = await engine.start({
			owner: sink,
			project,
			prompt: "Use the available write tool to create note.txt, then summarize the result.",
		});
		equal(context.projectId, project.projectId);
		const permission = await waitForEvent(
			sink,
			"turn.permission.requested",
			(event) => event.context.turnId === context.turnId,
		);
		const toolStarted = sink.ofType("turn.tool").find((event) =>
			event.context.turnId === context.turnId && event.status === "in_progress"
		);
		ok(toolStarted, "the permission was not preceded by a projected tool start");
		equal(toolStarted.toolCallId, "tool-clio-1");
		equal(toolStarted.title, "Edit project content");
		equal(toolStarted.kind, "edit");
		deepStrictEqual(toolStarted.locations, [["note.txt"]]);
		match(permission.permissionId, /^permission-clio-[0-9a-f-]{36}$/i);
		equal(permission.toolCallId, toolStarted.toolCallId);
		equal(permission.title, toolStarted.title);
		equal(permission.kind, toolStarted.kind);
		deepStrictEqual(permission.locations, toolStarted.locations);
		ok(Date.parse(permission.expiresAt) > Date.now(), "the projected permission was already expired");

		await engine.resolvePermission({
			owner: sink,
			projectId: context.projectId,
			turnId: context.turnId,
			permissionId: permission.permissionId,
			decision,
		});
		const resolved = await waitForEvent(
			sink,
			"turn.permission.resolved",
			(event) => event.permissionId === permission.permissionId,
		);
		equal(resolved.decision, decision);
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "completed");
		equal(terminal.code, "clio-completed");
		equal(terminal.stopReason, "end_turn");
		deepStrictEqual(terminal.usage, { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
		equal(sink.ofType("turn.terminal").filter((event) => event.context.turnId === context.turnId).length, 1);
		await waitFor(() => sink.refreshes.includes(project.projectId), "the project-bound refresh");

		const toolTerminal = sink.ofType("turn.tool").find((event) =>
			event.toolCallId === toolStarted.toolCallId && (event.status === "completed" || event.status === "failed")
		);
		ok(toolTerminal, "the projected tool lifecycle never reached a terminal status");
		equal(toolTerminal.status, decision === "allow_once" ? "completed" : "failed");
		const startedIndex = sink.events.indexOf(toolStarted);
		const requestedIndex = sink.events.indexOf(permission);
		const resolvedIndex = sink.events.indexOf(resolved);
		const toolTerminalIndex = sink.events.indexOf(toolTerminal);
		const terminalIndex = sink.events.indexOf(terminal);
		ok(startedIndex < requestedIndex, "permission preceded the tool start");
		ok(requestedIndex < resolvedIndex, "permission resolution preceded its request");
		ok(resolvedIndex < toolTerminalIndex, "the tool settled before the operator decision was projected");
		ok(toolTerminalIndex < terminalIndex, "the turn terminated before the tool lifecycle settled");

		const notePath = join(paths.project, "note.txt");
		if (decision === "allow_once") equal(await Deno.readTextFile(notePath), NOTE_CONTENT);
		else equal(await pathExists(notePath), false, "the rejected write created note.txt");
		ok(sink.ofType("turn.text").map((event) => event.text).join("").includes(PROVIDER_REPLY));
		assertContextBinding(sink, context);
		assertProviderExchange(fixture);
		assertProjectedBoundary(sink, paths, cliEntry);
	} finally {
		await cleanup(engine, fixture, paths);
	}
}

for (const decision of ["allow_once", "reject_once"] as const) {
	Deno.test({
		name: `real Clio ACP ${decision} stays project-bound and fully mediated`,
		sanitizeOps: true,
		sanitizeResources: true,
		fn: () => runJointCase(decision),
	});
}

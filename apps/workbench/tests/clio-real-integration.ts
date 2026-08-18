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
	ClioProjectHost,
	createLocalClioLauncher,
	type HostEvent,
	type HostProject,
	type HostSink,
	type HostTurnContext,
} from "../clio-host.ts";

const CLI_OVERRIDE = "CLIO_WORKBENCH_CLI_ENTRY";
const DEFAULT_CLI_ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WIRE_PROXY = fileURLToPath(new URL("./acp-wire-proxy.mjs", import.meta.url));
const SCRATCH_PARENT = fileURLToPath(new URL("../.artifacts/clio-real/", import.meta.url));
const PERMISSION_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const TOOL_CALL_ID = "call-workbench-write-1";
const NOTE_CONTENT = "hello from the Workbench joint proof";
const PROVIDER_REPLY = "the bounded joint proof is complete";
const TEXT_REPLY_PREFIX = "loopback continuity reply";
const API_KEY_NAME = "CLIO_CODER_TEST_OPENAI_KEY";
const API_KEY_VALUE = "sk-workbench-local-fixture";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MatchingEvent<E, T extends HostEvent["type"]> = E extends { type: infer K } ? T extends K ? E & { type: T } : never
	: never;
type EventOf<T extends HostEvent["type"]> = MatchingEvent<HostEvent, T>;
type PermissionDecision = "allow_once" | "reject_once";
type ProviderMode = "permission" | "text" | "loop" | "max-tools";
/** Names the scratch directory of a case that is not a permission decision. */
type CaseName =
	| PermissionDecision
	| "configuration"
	| "continuity"
	| "replay-truncation"
	| "session-mutations"
	| "unanswered"
	| "permission-expired"
	| "loop-event"
	| "max-tools";

class RecordingSink implements HostSink {
	readonly events: HostEvent[] = [];
	readonly refreshes: string[] = [];

	emit(event: HostEvent): void {
		this.events.push(event);
	}

	refreshProject(projectId: string): Promise<void> {
		this.refreshes.push(projectId);
		return Promise.resolve();
	}

	ofType<T extends HostEvent["type"]>(type: T): EventOf<T>[] {
		return this.events.filter((event): event is EventOf<T> => event.type === type);
	}
}

interface ProviderFixture {
	readonly url: string;
	readonly requests: Record<string, unknown>[];
	readonly streamingRequestCount: number;
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

async function waitForEvent<T extends HostEvent["type"]>(
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

async function makeCasePaths(caseName: CaseName): Promise<CasePaths> {
	await Deno.mkdir(SCRATCH_PARENT, { recursive: true });
	const root = await Deno.makeTempDir({ dir: SCRATCH_PARENT, prefix: `workbench-clio-${caseName}-` });
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

function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Response {
	return streamingResponse(sseBody([
		{
			id: `chatcmpl-${id}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "mock-model",
			choices: [{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: [{
						index: 0,
						id,
						type: "function",
						function: { name, arguments: JSON.stringify(args) },
					}],
				},
			}],
		},
		{
			id: `chatcmpl-${id}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "mock-model",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
		},
	]));
}

function textResponse(text: string): Response {
	return streamingResponse(sseBody([
		{
			id: "chatcmpl-workbench-text",
			object: "chat.completion.chunk",
			created: 1,
			model: "mock-model",
			choices: [{ index: 0, delta: { content: text } }],
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
}

function startProviderFixture(mode: ProviderMode = "permission"): ProviderFixture {
	const requests: Record<string, unknown>[] = [];
	let streamingRequestCount = 0;
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
			streamingRequestCount += 1;
			if (mode === "text") return textResponse(`${TEXT_REPLY_PREFIX} ${streamingRequestCount}`);
			if (mode === "loop") {
				return streamingRequestCount <= 5
					? toolCallResponse(`call-loop-${streamingRequestCount}`, "read", { path: "seed.txt" })
					: textResponse("loopback synthesis reply");
			}
			if (mode === "max-tools") {
				const ordinal = String(streamingRequestCount).padStart(3, "0");
				return toolCallResponse(`call-max-${ordinal}`, "read", { path: `read-${ordinal}.txt` });
			}

			if (!hasToolExchange(body)) {
				return toolCallResponse(TOOL_CALL_ID, "write", { path: "note.txt", content: NOTE_CONTENT });
			}

			return textResponse(PROVIDER_REPLY);
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
		get streamingRequestCount() {
			return streamingRequestCount;
		},
		async close() {
			if (closed) return;
			closed = true;
			abort.abort();
			await withTimeout(server.finished, 5_000, "the loopback provider to stop");
		},
	};
}

function projectFor(caseName: CaseName, trustedRoot: string): HostProject {
	return {
		projectId: `project-clio-${caseName.replace("_", "-")}`,
		trustedRoot,
		displayName: `Clio ${caseName} joint proof`,
	};
}

function isTurnEvent(event: HostEvent): event is Extract<HostEvent, { context: HostTurnContext }> {
	return "context" in event;
}

function assertContextBinding(sink: RecordingSink, context: HostTurnContext): void {
	equal(context.projectId.startsWith("project-clio-"), true);
	match(context.generation, /^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	match(context.sessionId, /^session-[0-9a-f-]{36}$/i);
	equal(context.turnId, "turn-1");
	const turnEvents = sink.events.filter(isTurnEvent);
	ok(turnEvents.length > 0, "the real turn produced no projected events");
	for (const event of turnEvents) deepStrictEqual(event.context, context);
	for (const event of sink.ofType("clio.state")) equal(event.projectId, context.projectId);
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
		ok(!projected.includes(forbidden), `projected host events leaked forbidden native data: ${forbidden}`);
	}
	for (const event of sink.ofType("turn.tool")) {
		deepStrictEqual(event.payload.locations, [{ segments: ["note.txt"] }]);
	}
	for (const event of sink.ofType("turn.permission.requested")) {
		deepStrictEqual(event.payload.locations, [{ segments: ["note.txt"] }]);
	}
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

async function waitForFileText(path: string, expected: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const text = await Deno.readTextFile(path);
			if (text.includes(expected)) return text;
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} in the wire record.`);
		await delay(10);
	}
}

async function cleanup(
	host: ClioProjectHost | null,
	fixture: ProviderFixture | null,
	paths: CasePaths | null,
): Promise<void> {
	const failures: unknown[] = [];
	if (host !== null) {
		try {
			await withTimeout(host.close(), CLEANUP_TIMEOUT_MS, "the ClioProjectHost cleanup");
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

interface ExpandedHarnessOptions {
	readonly providerMode: ProviderMode;
	readonly childPermissionTimeoutMs?: number;
	readonly clientPermissionTimeoutMs?: number;
	readonly permissionEscalateMs?: number;
	readonly permissionBudgetMs?: number;
	readonly promptTimeoutMs?: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly recordWire?: boolean;
}

interface ExpandedHarness {
	readonly paths: CasePaths;
	readonly fixture: ProviderFixture;
	readonly host: ClioProjectHost;
	readonly sink: RecordingSink;
	readonly cliEntry: string;
	readonly wireLogPath: string | null;
	dispose(): Promise<void>;
}

async function startExpandedHarness(caseName: CaseName, options: ExpandedHarnessOptions): Promise<ExpandedHarness> {
	let paths: CasePaths | null = null;
	let fixture: ProviderFixture | null = null;
	let host: ClioProjectHost | null = null;
	try {
		const node = "node";
		const cliEntry = selectedCliEntry();
		paths = await makeCasePaths(caseName);
		fixture = startProviderFixture(options.providerMode);
		const env = { ...isolatedClioEnv(paths.home), ...options.env };
		await seedSettings(paths, node, cliEntry, fixture.url, env);
		const wireLogPath = options.recordWire === true ? join(paths.root, "host-to-child.jsonl") : null;
		const prefixArgs = wireLogPath === null
			? [cliEntry, "--no-context-files", "--no-skills"]
			: [WIRE_PROXY, wireLogPath, cliEntry, "--no-context-files", "--no-skills"];
		const childPermissionTimeoutMs = options.childPermissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
		const clientPermissionTimeoutMs = options.clientPermissionTimeoutMs ?? childPermissionTimeoutMs;
		const permissionBudgetMs = options.permissionBudgetMs ?? clientPermissionTimeoutMs;
		const permissionEscalateMs = options.permissionEscalateMs ?? Math.min(5_000, permissionBudgetMs);
		const launcher = createLocalClioLauncher({
			executable: node,
			prefixArgs,
			env,
			clearEnv: true,
			permissionTimeoutMs: childPermissionTimeoutMs,
		});
		const sink = new RecordingSink();
		host = new ClioProjectHost({
			launcher,
			project: projectFor(caseName, paths.project),
			sink,
			acpTiming: {
				permissionTimeoutMs: clientPermissionTimeoutMs,
				writeTimeoutMs: 3_000,
				cancelGraceMs: 5_000,
				closeTimeoutMs: 3_000,
				exitGraceMs: 2_000,
				termGraceMs: 500,
				killObservationMs: 3_000,
			},
			promptTimeoutMs: options.promptTimeoutMs ?? EVENT_TIMEOUT_MS,
			permissionEscalateMs,
			permissionBudgetMs,
		});
		await withTimeout(host.open(), COMMAND_TIMEOUT_MS, "the expanded real Clio process to initialize");
		await withTimeout(host.newSession(), COMMAND_TIMEOUT_MS, "the expanded real session to bind");
		return {
			paths,
			fixture,
			host,
			sink,
			cliEntry,
			wireLogPath,
			dispose: () => cleanup(host, fixture, paths),
		};
	} catch (error) {
		await cleanup(host, fixture, paths);
		throw error;
	}
}

async function runJointCase(decision: PermissionDecision): Promise<void> {
	let paths: CasePaths | null = null;
	let fixture: ProviderFixture | null = null;
	let host: ClioProjectHost | null = null;
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

		const sink = new RecordingSink();
		const project = projectFor(decision, paths.project);
		host = new ClioProjectHost({
			launcher,
			project,
			sink,
			acpTiming: {
				permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
				writeTimeoutMs: 3_000,
				cancelGraceMs: 5_000,
				closeTimeoutMs: 3_000,
				exitGraceMs: 2_000,
				termGraceMs: 500,
				killObservationMs: 3_000,
			},
			promptTimeoutMs: EVENT_TIMEOUT_MS,
			// The joint child runs with a 15 s permission ceiling, so escalation has
			// to fit inside it; production uses the 1 800 000 ms ceiling and 45 s.
			permissionEscalateMs: 5_000,
			permissionBudgetMs: PERMISSION_TIMEOUT_MS,
		});
		await withTimeout(host.open(), COMMAND_TIMEOUT_MS, "the real Clio process to initialize");
		equal(host.phase, "unbound");
		const agent = host.snapshot().agent;
		equal(agent?.name, "clio-coder");
		await withTimeout(host.newSession(), COMMAND_TIMEOUT_MS, "the real session to bind");
		equal(host.phase, "idle");

		const context = await host.startTurn(
			"Use the available write tool to create note.txt, then summarize the result.",
		);
		equal(context.projectId, project.projectId);
		const permission = await waitForEvent(
			sink,
			"turn.permission.requested",
			(event) => event.context.turnId === context.turnId,
		);
		const toolStarted = sink.ofType("turn.tool").find((event) =>
			event.context.turnId === context.turnId && event.payload.status === "in_progress"
		);
		ok(toolStarted, "the permission was not preceded by a projected tool start");
		match(toolStarted.payload.toolCallId, /^tool-turn-1-\d+$/u);
		equal(toolStarted.payload.kind, "edit");
		deepStrictEqual(toolStarted.payload.locations, [{ segments: ["note.txt"] }]);
		match(permission.payload.permissionId, /^permission-[0-9a-f-]{36}$/i);
		equal(permission.payload.toolCallId, toolStarted.payload.toolCallId);
		equal(permission.payload.kind, toolStarted.payload.kind);
		deepStrictEqual(permission.payload.locations, toolStarted.payload.locations);
		ok(Date.parse(permission.payload.requestedAt) <= Date.now());
		ok(Date.parse(permission.payload.escalateAt) < Date.parse(permission.payload.expiresAt));
		ok(Date.parse(permission.payload.expiresAt) > Date.now(), "the projected permission was already expired");

		await host.resolvePermission(context.turnId, permission.payload.permissionId, decision);
		const resolved = await waitForEvent(
			sink,
			"turn.permission.resolved",
			(event) => event.payload.permissionId === permission.payload.permissionId,
		);
		equal(resolved.payload.decision, decision === "allow_once" ? "allow-once" : "reject");
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "completed");
		equal(terminal.payload.code, "clio-completed");
		equal(terminal.payload.stopReason, "end_turn");
		deepStrictEqual(terminal.payload.usage, { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
		equal(sink.ofType("turn.terminal").filter((event) => event.context.turnId === context.turnId).length, 1);
		await waitFor(() => sink.refreshes.includes(project.projectId), "the project-bound refresh");

		const toolTerminal = sink.ofType("turn.tool").find((event) =>
			event.payload.toolCallId === toolStarted.payload.toolCallId &&
			(event.payload.status === "completed" || event.payload.status === "failed")
		);
		ok(toolTerminal, "the projected tool lifecycle never reached a terminal status");
		equal(toolTerminal.payload.status, decision === "allow_once" ? "completed" : "failed");
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
		ok(sink.ofType("turn.text").map((event) => event.payload.text).join("").includes(PROVIDER_REPLY));
		assertContextBinding(sink, context);
		assertProviderExchange(fixture);
		assertProjectedBoundary(sink, paths, cliEntry);
	} finally {
		await cleanup(host, fixture, paths);
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

/**
 * The configuration surface against the real server: the safe settings
 * projection, the target list, one real probe against the loopback stub, an
 * atomic patch, and a per-session autonomy override. No prompt runs, so no
 * model token is spent.
 */
async function runConfigurationCase(): Promise<void> {
	let paths: CasePaths | null = null;
	let fixture: ProviderFixture | null = null;
	let host: ClioProjectHost | null = null;
	try {
		const node = "node";
		const cliEntry = selectedCliEntry();
		paths = await makeCasePaths("configuration");
		fixture = startProviderFixture();
		const env = isolatedClioEnv(paths.home);
		await seedSettings(paths, node, cliEntry, fixture.url, env);

		const launcher = createLocalClioLauncher({
			executable: node,
			prefixArgs: [cliEntry, "--no-context-files", "--no-skills"],
			env,
			clearEnv: true,
			permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
		});
		const sink = new RecordingSink();
		host = new ClioProjectHost({
			launcher,
			project: projectFor("configuration", paths.project),
			sink,
			acpTiming: {
				permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
				writeTimeoutMs: 3_000,
				cancelGraceMs: 5_000,
				closeTimeoutMs: 3_000,
				exitGraceMs: 2_000,
				termGraceMs: 500,
				killObservationMs: 3_000,
			},
			promptTimeoutMs: EVENT_TIMEOUT_MS,
			permissionEscalateMs: 5_000,
			permissionBudgetMs: PERMISSION_TIMEOUT_MS,
		});
		await withTimeout(host.open(), COMMAND_TIMEOUT_MS, "the real Clio process to initialize");
		const capabilities = host.snapshot().capabilities;
		ok(capabilities, "the real server advertised no capability projection");
		equal(capabilities.settings, true, "the real server did not advertise clio-coder/settings");
		equal(capabilities.targets, true, "the real server did not advertise clio-coder/targets");
		equal(capabilities.autonomy, true, "the real server did not advertise clio-coder/session/autonomy");
		// M5: the host opts into the extension notification at initialize, so the
		// real server answers by advertising it. Without that opt-in the contract
		// says nothing is advertised and nothing is ever sent; the client-side test
		// "the extension event surface is advertised and delivered only after the
		// client opts in" proves the negative half against the fixture.
		equal(capabilities.loopBlocked, true, "the real server did not advertise clio-coder/events");
		await withTimeout(host.newSession(), COMMAND_TIMEOUT_MS, "the real session to bind");

		// Attribution, Defect 4: the session names what it was bound to.
		equal(host.snapshot().session?.target, "mock-chat");
		equal(host.snapshot().session?.model, "mock-model");
		equal(host.snapshot().session?.autonomy, "suggest");
		equal(host.snapshot().session?.autonomySource, "settings");

		await withTimeout(host.primeSettings(), COMMAND_TIMEOUT_MS, "the settings and target projections");
		const settings = host.settings;
		const targets = host.targets;
		ok(settings, "the real server returned no safe settings projection");
		ok(targets, "the real server returned no target list");
		deepStrictEqual(Object.keys(settings.settings).sort(), [
			"autonomy",
			"orchestrator.model",
			"orchestrator.target",
			"orchestrator.thinkingLevel",
		]);
		equal(settings.settings["orchestrator.target"], "mock-chat");
		equal(settings.settings["orchestrator.model"], "mock-model");
		equal(settings.settings.autonomy, "suggest");
		const projected = JSON.stringify({ settings, targets });
		ok(!projected.includes(API_KEY_VALUE), "a credential value reached the settings projection");
		ok(!projected.includes(API_KEY_NAME), "a credential variable name reached the settings projection");
		ok(!projected.includes(fixture.url), "a target URL reached the projection");
		const mock = targets.find((target) => target.id === "mock-chat");
		ok(mock, "the seeded target is absent from the projection");
		equal(mock.health, null, "a health verdict appeared before any probe ran");
		ok(mock.models.includes("mock-model"));

		await withTimeout(host.probeTarget("mock-chat"), COMMAND_TIMEOUT_MS, "the real target probe");
		const probed = sink.ofType("targets.probed").at(-1);
		ok(probed, "the probe emitted no result");
		equal(probed.targetId, "mock-chat");
		equal(typeof probed.health.healthy, "boolean");
		ok(Date.parse(probed.health.probedAt) <= Date.now());
		ok(
			probed.health.reason === null ||
				["not-configured", "unreachable", "unsupported", "probe-failed"].includes(probed.health.reason),
			`the probe reason ${String(probed.health.reason)} is outside the closed set`,
		);
		equal(probed.health.healthy, true, "the loopback stub serves /v1/models, so the probe must succeed");

		await withTimeout(
			host.patchSettings({ "orchestrator.thinkingLevel": "low" }),
			COMMAND_TIMEOUT_MS,
			"the safe settings patch",
		);
		equal(host.settings?.settings["orchestrator.thinkingLevel"], "low");
		await withTimeout(host.getSettings(), COMMAND_TIMEOUT_MS, "the settings re-read");
		equal(host.settings?.settings["orchestrator.thinkingLevel"], "low", "the patch did not survive a re-read");

		await withTimeout(host.setAutonomy("read-only"), COMMAND_TIMEOUT_MS, "the per-session autonomy override");
		equal(host.snapshot().session?.autonomy, "read-only");
		equal(host.snapshot().session?.autonomySource, "session");
		// A global autonomy patch must not silently rebind the open session.
		await withTimeout(host.patchSettings({ autonomy: "full-auto" }), COMMAND_TIMEOUT_MS, "the global autonomy patch");
		equal(host.settings?.settings.autonomy, "full-auto");
		equal(host.snapshot().session?.autonomy, "read-only");
		equal(host.snapshot().session?.autonomySource, "session");

		await withTimeout(host.listSessions(), COMMAND_TIMEOUT_MS, "the real session list");
		const listed = sink.ofType("session.list").at(-1);
		ok(listed, "the session list emitted nothing");
		const hosted = listed.sessions.find((session) => session.hosted);
		ok(hosted, "the hosted session is missing from the real session list");
		equal(hosted.state, "open");
		equal(hosted.target, "mock-chat");
		equal(hosted.model, "mock-model");
		ok(!JSON.stringify(listed).includes(paths.project), "a native path reached the session list projection");
	} finally {
		await cleanup(host, fixture, paths);
	}
}

Deno.test({
	name: "real Clio ACP settings, targets, probe, and autonomy stay bounded and credential-free",
	sanitizeOps: true,
	sanitizeResources: true,
	fn: runConfigurationCase,
});

Deno.test({
	name: "real child gate records the current executable dist build and repository HEAD",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const stat = await Deno.stat(DEFAULT_CLI_ENTRY);
		ok(stat.isFile, "dist/cli/index.js is not a regular file");
		ok(stat.mode !== null && (stat.mode & 0o111) !== 0, "dist/cli/index.js is not executable");
		const head = await new Deno.Command("git", {
			args: ["rev-parse", "HEAD"],
			cwd: REPOSITORY_ROOT,
			stdin: "null",
			stdout: "piped",
			stderr: "piped",
		}).output();
		const recordedHead = head.success ? decoder.decode(head.stdout).trim() : "unavailable";
		console.info(
			`real-child identity: dist/cli/index.js mtime=${
				stat.mtime?.toISOString() ?? "unavailable"
			}; git rev-parse HEAD=${recordedHead}`,
		);
	},
});

Deno.test({
	name: "real Clio ACP preserves three prompt continuity on one hosted session",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("continuity", { providerMode: "text" });
		try {
			const prompts = [
				"continuity marker alpha",
				"continuity marker beta",
				"continuity marker gamma",
			];
			const contexts: HostTurnContext[] = [];
			for (const prompt of prompts) {
				const context = await test.host.startTurn(prompt);
				contexts.push(context);
				const terminal = await waitForEvent(
					test.sink,
					"turn.terminal",
					(event) => event.context.turnId === context.turnId,
				);
				equal(terminal.payload.outcome, "completed");
				equal(terminal.payload.code, "clio-completed");
			}
			deepStrictEqual(contexts.map((context) => context.turnId), ["turn-1", "turn-2", "turn-3"]);
			ok(contexts.every((context) => context.sessionId === contexts[0]?.sessionId));
			ok(contexts.every((context) => context.generation === contexts[0]?.generation));
			equal(test.fixture.streamingRequestCount, 3);
			const streamed = test.fixture.requests.filter((request) => request.stream !== false);
			equal(streamed.length, 3);
			const thirdContext = JSON.stringify(streamed[2]?.messages);
			for (const prompt of prompts) ok(thirdContext.includes(prompt), `third provider request omitted ${prompt}`);
			ok(thirdContext.includes(`${TEXT_REPLY_PREFIX} 1`));
			ok(thirdContext.includes(`${TEXT_REPLY_PREFIX} 2`));
			ok(test.sink.ofType("turn.text").some((event) => event.payload.text.includes(`${TEXT_REPLY_PREFIX} 3`)));
			assertProjectedBoundary(test.sink, test.paths, test.cliEntry);
		} finally {
			await test.dispose();
		}
	},
});

Deno.test({
	name: "real Clio ACP close and load replays 64 of 65 turns and reports truncation",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("replay-truncation", {
			providerMode: "text",
			promptTimeoutMs: 120_000,
		});
		try {
			const publicSessionId = test.host.boundSessionPublicId;
			ok(publicSessionId);
			for (let turn = 1; turn <= 65; turn += 1) {
				const context = await test.host.startTurn(`replay prompt ${String(turn).padStart(2, "0")}`);
				const terminal = await waitForEvent(
					test.sink,
					"turn.terminal",
					(event) => event.context.turnId === context.turnId,
				);
				equal(terminal.payload.outcome, "completed");
			}
			equal(test.fixture.streamingRequestCount, 65);
			await withTimeout(test.host.closeSession(), CLEANUP_TIMEOUT_MS, "the real session close before replay");
			await withTimeout(test.host.listSessions(), COMMAND_TIMEOUT_MS, "the closed real session list");
			const closed = test.sink.ofType("session.list").at(-1)?.sessions.find((session) =>
				session.id === publicSessionId
			);
			ok(closed);
			equal(closed.state, "closed");
			test.sink.events.length = 0;
			await withTimeout(test.host.loadSession(publicSessionId), EVENT_TIMEOUT_MS, "the truncated real session replay");
			const bound = test.host.snapshot().session;
			equal(bound?.id, publicSessionId);
			equal(bound?.resumed, true);
			equal(bound?.replayedTurns, 64);
			equal(bound?.replayTruncated, true);
			const started = test.sink.ofType("turn.started");
			equal(started.length, 64);
			equal(started[0]?.payload.promptSummary, "replay prompt 02");
			equal(started.at(-1)?.payload.promptSummary, "replay prompt 65");
			ok(started.every((event) => event.payload.startedAt === null));
			ok(started.every((event) => event.payload.source === "replayed-from-clio"));
			equal(test.sink.ofType("turn.terminal").length, 0);
			equal(test.fixture.streamingRequestCount, 65, "session replay must not call the provider");
			assertProjectedBoundary(test.sink, test.paths, test.cliEntry);
		} finally {
			await test.dispose();
		}
	},
});

Deno.test({
	name: "real Clio ACP label and delete round trip through a closed session",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("session-mutations", { providerMode: "text" });
		try {
			const publicSessionId = test.host.boundSessionPublicId;
			ok(publicSessionId);
			await withTimeout(test.host.closeSession(), CLEANUP_TIMEOUT_MS, "the real session close before mutation");
			await withTimeout(test.host.listSessions(), COMMAND_TIMEOUT_MS, "the real session list before mutation");
			ok(test.sink.ofType("session.list").at(-1)?.sessions.some((session) => session.id === publicSessionId));
			await withTimeout(
				test.host.labelSession(publicSessionId, "Real child audit"),
				COMMAND_TIMEOUT_MS,
				"the real session label",
			);
			equal(
				test.sink.ofType("session.list").at(-1)?.sessions.find((session) => session.id === publicSessionId)?.label,
				"Real child audit",
			);
			await withTimeout(test.host.deleteSession(publicSessionId), COMMAND_TIMEOUT_MS, "the real session delete");
			ok(!test.sink.ofType("session.list").at(-1)?.sessions.some((session) => session.id === publicSessionId));
		} finally {
			await test.dispose();
		}
	},
});

Deno.test({
	name: "real Clio ACP unanswered approval cancels without sending reject once",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("unanswered", {
			providerMode: "permission",
			childPermissionTimeoutMs: 5_000,
			clientPermissionTimeoutMs: 5_000,
			permissionEscalateMs: 100,
			permissionBudgetMs: 300,
			recordWire: true,
		});
		try {
			const context = await test.host.startTurn("Create note.txt and wait for approval.");
			const permission = await waitForEvent(
				test.sink,
				"turn.permission.requested",
				(event) => event.context.turnId === context.turnId,
			);
			const terminal = await waitForEvent(
				test.sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			equal(terminal.payload.outcome, "canceled");
			equal(terminal.payload.code, "approval-unanswered");
			equal(terminal.payload.stopReason, "cancelled");
			const resolved = test.sink.ofType("turn.permission.resolved").find((event) =>
				event.payload.permissionId === permission.payload.permissionId
			);
			ok(resolved);
			equal(resolved.payload.decision, "unanswered");
			equal(test.fixture.streamingRequestCount, 1);
			equal(await pathExists(join(test.paths.project, "note.txt")), false);
			ok(test.wireLogPath);
			const wire = await waitForFileText(test.wireLogPath, '"outcome":"cancelled"');
			ok(!wire.includes("reject-once"));
			ok(!wire.includes("reject_once"));
			ok(!wire.includes('"optionId":"reject-once"'));
		} finally {
			await test.dispose();
		}
	},
});

Deno.test({
	name: "real Clio ACP server permission expiry reaches the dedicated host failure",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("permission-expired", {
			providerMode: "permission",
			childPermissionTimeoutMs: 250,
			clientPermissionTimeoutMs: 5_000,
			permissionEscalateMs: 1_000,
			permissionBudgetMs: 5_000,
		});
		try {
			const context = await test.host.startTurn("Create note.txt but let the child approval ceiling expire.");
			await waitForEvent(test.sink, "turn.permission.requested", (event) => event.context.turnId === context.turnId);
			const terminal = await waitForEvent(
				test.sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			equal(terminal.payload.outcome, "failed");
			equal(terminal.payload.code, "clio-permission-expired");
			equal(
				terminal.payload.summary,
				"An approval waited past Clio's own ceiling. Clio stopped the turn; nothing was denied.",
			);
			equal(test.fixture.streamingRequestCount, 1);
			equal(await pathExists(join(test.paths.project, "note.txt")), false);
		} finally {
			await test.dispose();
		}
	},
});

Deno.test({
	name: "real Clio ACP loopback repetition emits a safety loop blocked event",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("loop-event", { providerMode: "loop" });
		try {
			await Deno.writeTextFile(join(test.paths.project, "seed.txt"), "stable loop fixture content\n");
			const context = await test.host.startTurn("Read seed.txt repeatedly so the real loop guard can intervene.");
			const loop = await waitForEvent(test.sink, "turn.loop", (event) => event.context.turnId === context.turnId);
			equal(loop.payload.tool, "read");
			ok(loop.payload.repeatCount >= 3);
			ok(loop.payload.blocksThisTurn >= 1);
			ok(["block", "lockout", "stop"].includes(loop.payload.disposition));
			equal(loop.payload.interrupted, loop.payload.disposition === "stop");
			equal(loop.payload.source, "reported-by-clio");
			const terminal = await waitForEvent(
				test.sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			ok(["completed", "canceled", "failed"].includes(terminal.payload.outcome));
			ok(test.fixture.streamingRequestCount >= 3);
			equal(test.sink.ofType("turn.permission.requested").length, 0);
		} finally {
			await test.dispose();
		}
	},
});

Deno.test({
	name: "real Clio ACP suppresses the 129th tool start and reports max turn requests",
	sanitizeOps: true,
	sanitizeResources: true,
	async fn() {
		const test = await startExpandedHarness("max-tools", {
			providerMode: "max-tools",
			promptTimeoutMs: 180_000,
			env: { CLIO_CODER_TURN_TOOL_CALL_BUDGET: "1000" },
		});
		try {
			await Promise.all(
				Array.from({ length: 129 }, (_unused, index) => {
					const ordinal = String(index + 1).padStart(3, "0");
					return Deno.writeTextFile(
						join(test.paths.project, `read-${ordinal}.txt`),
						`${ordinal} ${"x".repeat(index + 1)}\n`,
					);
				}),
			);
			const context = await test.host.startTurn("Read every distinct fixture file the provider requests.");
			await waitFor(
				() => test.sink.ofType("turn.terminal").some((event) => event.context.turnId === context.turnId),
				"the real max turn requests terminal",
				180_000,
			);
			const terminal = test.sink.ofType("turn.terminal").find((event) => event.context.turnId === context.turnId);
			ok(terminal);
			equal(terminal.payload.outcome, "failed");
			equal(terminal.payload.code, "clio-max_turn_requests");
			equal(terminal.payload.stopReason, "max_turn_requests");
			const starts = test.sink.ofType("turn.tool").filter((event) => event.payload.status === "in_progress");
			equal(starts.length, 128);
			equal(new Set(starts.map((event) => event.payload.toolCallId)).size, 128);
			equal(test.fixture.streamingRequestCount, 129);
			ok(!starts.some((event) => event.payload.summary.includes("read-129.txt")));
		} finally {
			await test.dispose();
		}
	},
});

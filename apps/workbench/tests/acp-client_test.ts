import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACP_MAX_FRAME_BYTES,
	ACP_MAX_PENDING_REQUESTS,
	ACP_MAX_STDERR_TAIL_BYTES,
	ACP_REMOTE_ERROR_CODES,
	AcpClient,
	AcpClientError,
	type AcpClientTiming,
	type AcpExtensionEvent,
	type AcpFailure,
	type AcpLaunchSpec,
	AcpLineFramer,
	type AcpPermissionDecision,
	type AcpPermissionRequest,
	AcpProtocolError,
	AcpRemoteError,
	type AcpRetireResult,
	type AcpTerminationScope,
	AcpTimeoutError,
	localAcpLaunch,
	type ValidatedAcpUpdate,
	wslAcpLaunch,
} from "../acp-client.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixturePath = fileURLToPath(new URL("./acp-child-fixture.ts", import.meta.url));
const fixtureSessionId = "fixture-session-1";
const fixtureToolCallId = "fixture-tool-1";

const ordinaryTiming: AcpClientTiming = {
	permissionTimeoutMs: 2_000,
	writeTimeoutMs: 1_000,
	cancelGraceMs: 500,
	closeTimeoutMs: 500,
	exitGraceMs: 500,
	termGraceMs: 250,
	killObservationMs: 2_000,
};

interface RecordedUpdate {
	readonly generation: string;
	readonly update: ValidatedAcpUpdate;
}

interface RecordedPermission {
	readonly generation: string;
	readonly request: AcpPermissionRequest;
}

interface RecordedFailure {
	readonly generation: string;
	readonly failure: AcpFailure;
}

interface RecordedExtensionEvent {
	readonly generation: string;
	readonly event: AcpExtensionEvent;
}

interface FixtureHarness {
	readonly root: string;
	readonly client: AcpClient;
	readonly updates: RecordedUpdate[];
	readonly permissions: RecordedPermission[];
	readonly failures: RecordedFailure[];
	readonly extensionEvents: RecordedExtensionEvent[];
}

function fixtureLaunch(
	root: string,
	scenario: string,
	redact: readonly string[] = [],
	terminationScope: AcpTerminationScope = Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
): AcpLaunchSpec {
	return {
		command: Deno.execPath(),
		args: [
			"run",
			"--quiet",
			"--no-config",
			...(scenario === "leader-exits-descendant" ? ["--allow-run=/usr/bin/sleep"] : []),
			fixturePath,
			`--scenario=${scenario}`,
		],
		cwd: root,
		clearEnv: true,
		terminationScope,
		redact,
	};
}

async function withFixture(
	scenario: string,
	run: (harness: FixtureHarness) => Promise<void>,
	options: Readonly<{
		timing?: AcpClientTiming;
		redact?: readonly string[];
		terminationScope?: AcpTerminationScope;
		capturePermissions?: boolean;
	}> = {},
): Promise<void> {
	const root = await Deno.makeTempDir({ prefix: `workbench-acp-${scenario}-` });
	const updates: RecordedUpdate[] = [];
	const permissions: RecordedPermission[] = [];
	const failures: RecordedFailure[] = [];
	const extensionEvents: RecordedExtensionEvent[] = [];
	const client = AcpClient.spawn(
		fixtureLaunch(root, scenario, options.redact, options.terminationScope),
		{
			onUpdate: (generation, update) => updates.push({ generation, update }),
			...(options.capturePermissions === false ? {} : {
				onPermission: (generation: string, request: AcpPermissionRequest) => permissions.push({ generation, request }),
			}),
			onFailure: (generation, failure) => failures.push({ generation, failure }),
			onExtensionEvent: (generation: string, event: AcpExtensionEvent) => extensionEvents.push({ generation, event }),
		},
		options.timing ?? ordinaryTiming,
	);
	const harness = { root, client, updates, permissions, failures, extensionEvents };
	try {
		await run(harness);
	} finally {
		await client.retire({ sessionId: fixtureSessionId, supportsClose: false, cancelActive: true });
		await Deno.remove(root, { recursive: true });
	}
}

async function waitFor(
	predicate: () => boolean,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}.`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
}

async function allowFixturePermissions(
	harness: FixtureHarness,
	startIndex: number,
	count: number,
): Promise<void> {
	for (let offset = 0; offset < count; offset += 1) {
		const index = startIndex + offset;
		await waitFor(() => harness.permissions.length > index, `permission ${index + 1}`);
		const request = harness.permissions[index]?.request;
		ok(request);
		await request.resolve("allow_once");
	}
}

function assertClientError(error: unknown, constructor: typeof AcpClientError, code: string): boolean {
	ok(error instanceof constructor, `expected ${constructor.name}, received ${String(error)}`);
	equal(error.code, code);
	return true;
}

function text(value: Uint8Array): string {
	return decoder.decode(value);
}

function initialize(client: AcpClient, params: Record<string, unknown> = {}): Promise<unknown> {
	return client.request("initialize", {
		protocolVersion: 1,
		clientInfo: { name: "clio-workbench-tests", version: "0.0.0" },
		clientCapabilities: {},
		...params,
	}, 2_000);
}

function newSession(client: AcpClient, root: string, params: Record<string, unknown> = {}): Promise<unknown> {
	return client.request("session/new", { cwd: root, mcpServers: [], ...params }, 2_000);
}

function prompt(client: AcpClient, params: Record<string, unknown> = {}): Promise<unknown> {
	return client.request("session/prompt", {
		sessionId: fixtureSessionId,
		prompt: [{ type: "text", text: "Run the deterministic fixture turn." }],
		...params,
	}, 2_000);
}

async function initializeAndCreateSession(harness: FixtureHarness): Promise<void> {
	const initialized = await initialize(harness.client);
	deepStrictEqual(initialized, {
		protocolVersion: 1,
		agentInfo: {
			name: "clio-coder",
			title: "Clio Coder ACP fixture",
			version: "0.0.0",
		},
		agentCapabilities: {
			loadSession: false,
			promptCapabilities: { audio: false, embeddedContext: false, image: false },
			mcpCapabilities: { http: false, sse: false },
			_meta: {
				"clio-coder/session": { close: true },
				"clio-coder/events": {
					version: 1,
					notification: "clio-coder/event",
					kinds: ["safety.loopBlocked"],
					workspaceInstanceId: "fixture-workspace-1",
				},
				"clio-coder/tools": "mediated",
			},
		},
		authMethods: [],
	});
	deepStrictEqual(await newSession(harness.client, harness.root), {
		sessionId: fixtureSessionId,
		_meta: {
			"clio-coder/session": {
				sessionId: fixtureSessionId,
				target: "lmstudio",
				model: "qwen3.8-27b",
				autonomy: "auto-edit",
				createdAt: "2026-08-18T12:00:00.000Z",
				resumed: false,
			},
		},
	});
}

function assertSafeFailure(harness: FixtureHarness, expectedCode: AcpFailure["code"]): void {
	equal(harness.failures.length, 1);
	const observed = harness.failures[0];
	ok(observed);
	equal(observed.generation, harness.client.generation);
	equal(observed.failure.code, expectedCode);
	equal(
		observed.failure.message,
		expectedCode === "protocol-failure"
			? "The Clio ACP connection violated its bounded protocol."
			: "The owned Clio ACP process exited unexpectedly.",
	);
}

function assertCooperativeRetire(result: AcpRetireResult): void {
	equal(result.exited, true);
	equal(result.escalated, false);
	equal(result.promptSettledBeforeClose, true);
	equal(result.exitCode, 0);
	equal(result.signal, null);
}

function assertForcedProtocolRetire(result: AcpRetireResult): void {
	equal(result.exited, true);
	equal(result.escalated, false);
	equal(result.promptSettledBeforeClose, false);
	equal(result.exitCode, 0);
	equal(result.signal, null);
}

Deno.test("AcpLineFramer preserves partial, multiple, CRLF, blank, and split UTF-8 byte frames", () => {
	const partial = new AcpLineFramer(64);
	deepStrictEqual(partial.push(encoder.encode("hel")), []);
	deepStrictEqual(partial.push(encoder.encode("lo\n")), [encoder.encode("hello")]);
	partial.finish();

	const multiple = new AcpLineFramer(64);
	deepStrictEqual(
		multiple.push(encoder.encode("one\ntwo\r\n\n\r\n")),
		[encoder.encode("one"), encoder.encode("two\r"), encoder.encode(""), encoder.encode("\r")],
	);
	multiple.finish();

	const utf8 = encoder.encode("a🙂b\n");
	const splitUtf8 = new AcpLineFramer(64);
	deepStrictEqual(splitUtf8.push(utf8.subarray(0, 3)), []);
	const frames = splitUtf8.push(utf8.subarray(3));
	equal(frames.length, 1);
	equal(text(frames[0] as Uint8Array), "a🙂b");
	splitUtf8.finish();
});

Deno.test("AcpLineFramer accepts the exact byte bound and rejects complete or partial oversize frames", () => {
	const exact = new AcpLineFramer(4);
	deepStrictEqual(exact.push(encoder.encode("éé\n")), [encoder.encode("éé")]);
	exact.finish();

	throws(
		() => new AcpLineFramer(4).push(encoder.encode("ééa\n")),
		(error: unknown) => assertClientError(error, AcpProtocolError, "protocol-failure"),
	);
	throws(
		() => new AcpLineFramer(4).push(encoder.encode("12345")),
		(error: unknown) => assertClientError(error, AcpProtocolError, "protocol-failure"),
	);
	throws(
		() => new AcpLineFramer(0),
		(error: unknown) => assertClientError(error, AcpClientError, "invalid-frame-bound"),
	);
	throws(
		() => new AcpLineFramer(ACP_MAX_FRAME_BYTES + 1),
		(error: unknown) => assertClientError(error, AcpClientError, "invalid-frame-bound"),
	);
});

Deno.test("AcpLineFramer accepts blank EOF but rejects nonblank or invalid UTF-8 partial EOF", () => {
	const blank = new AcpLineFramer(8);
	deepStrictEqual(blank.push(encoder.encode(" \t\r")), []);
	blank.finish();

	const partial = new AcpLineFramer(8);
	partial.push(encoder.encode("partial"));
	throws(
		() => partial.finish(),
		(error: unknown) => assertClientError(error, AcpProtocolError, "protocol-failure"),
	);

	const invalidUtf8 = new AcpLineFramer(8);
	invalidUtf8.push(Uint8Array.of(0xf0, 0x9f));
	throws(
		() => invalidUtf8.finish(),
		(error: unknown) => assertClientError(error, AcpProtocolError, "protocol-failure"),
	);
});

Deno.test("the fixture bounds stdin at one MiB of UTF-8 and resumes after discarding the line", async () => {
	const child = new Deno.Command(Deno.execPath(), {
		args: ["run", "--quiet", "--no-config", fixturePath, "--scenario=happy"],
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	const outputPromise = child.output();
	const writer = child.stdin.getWriter();
	const oversizedUtf8 = "€".repeat(Math.floor((1024 * 1024) / 3) + 1);
	const initializeFrame = JSON.stringify({
		jsonrpc: "2.0",
		id: 7,
		method: "initialize",
		params: { protocolVersion: 1, clientInfo: { name: "byte-bound-test", version: "0.0.0" } },
	});
	await writer.write(encoder.encode(`${oversizedUtf8}\n${initializeFrame}\n`));
	await writer.close();
	const output = await outputPromise;
	equal(output.success, true);
	const frames = decoder.decode(output.stdout).trim().split("\n").map((line) =>
		JSON.parse(line) as Record<string, unknown>
	);
	const oversized = frames.find((frame) => frame.id === null);
	ok(oversized);
	equal((JSON.stringify(oversized).match(/input_line_too_large/gu) ?? []).length, 1);
	const initialized = frames.find((frame) => frame.id === 7);
	ok(initialized);
	ok(Object.hasOwn(initialized, "result"));
});

Deno.test("localAcpLaunch builds the frozen node CLI argv and validates every caller-controlled field", () => {
	const root = resolve(Deno.cwd(), "trusted project");
	const cliEntry = join(root, "dist", "cli", "index.js");
	const launch = localAcpLaunch("node", root, 47_111, [cliEntry]);
	deepStrictEqual(launch, {
		command: "node",
		args: [cliEntry, "acp", "--cwd", root, "--permission-timeout", "47111"],
		cwd: root,
		terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
		redact: [root, "node"],
	});

	const invalidCalls: Array<() => unknown> = [
		() => localAcpLaunch("../node", root, 1),
		() => localAcpLaunch("node shell", root, 1),
		() => localAcpLaunch("node", "relative/project", 1),
		() => localAcpLaunch("node", `${root}\0suffix`, 1),
		() => localAcpLaunch("node", root, 1, [""]),
		() => localAcpLaunch("node", root, 1, ["bad\0argument"]),
	];
	for (const invoke of invalidCalls) {
		throws(invoke, (error: unknown) => assertClientError(error, AcpClientError, "invalid-launch"));
	}
	// The permission ceiling is the ACP client's 1 800 000 ms bound, not the old 300 s one.
	for (const timeout of [0, 1_800_001]) {
		throws(
			() => localAcpLaunch("node", root, timeout),
			(error: unknown) => assertClientError(error, AcpClientError, "invalid-timeout"),
		);
	}
});

Deno.test("wslAcpLaunch is an argv-only typed seam and makes no descendant-ownership claim", () => {
	const launch = wslAcpLaunch("wsl.exe", "Ubuntu-24.04", "/opt/clio/bin/clio-coder", "/work/project", 9_001);
	deepStrictEqual(launch, {
		command: "wsl.exe",
		args: [
			"--distribution",
			"Ubuntu-24.04",
			"--exec",
			"/opt/clio/bin/clio-coder",
			"acp",
			"--cwd",
			"/work/project",
			"--permission-timeout",
			"9001",
		],
		terminationScope: "direct-child",
		redact: ["/work/project", "/opt/clio/bin/clio-coder"],
	});

	const invalidCalls: Array<() => unknown> = [
		() => wslAcpLaunch("wsl.exe", "Ubuntu 24.04", "/opt/clio", "/work/project", 1),
		() => wslAcpLaunch("wsl.exe", "Ubuntu;evil", "/opt/clio", "/work/project", 1),
		() => wslAcpLaunch("wsl.exe", "Ubuntu", "opt/clio", "/work/project", 1),
		() => wslAcpLaunch("wsl.exe", "Ubuntu", "/opt/clio", "work/project", 1),
		() => wslAcpLaunch("wsl.exe", "Ubuntu", "/opt/clio\0bad", "/work/project", 1),
	];
	for (const invoke of invalidCalls) {
		throws(invoke, (error: unknown) => assertClientError(error, AcpClientError, "invalid-launch"));
	}
	throws(
		() => wslAcpLaunch("wsl.exe", "Ubuntu", "/opt/clio", "/work/project", -1),
		(error: unknown) => assertClientError(error, AcpClientError, "invalid-timeout"),
	);
});

Deno.test("spawned fixture completes initialize, new, ordered prompt updates, usage, close, and EOF", async () => {
	await withFixture("happy", async (harness) => {
		await initializeAndCreateSession(harness);
		deepStrictEqual(await prompt(harness.client), {
			stopReason: "end_turn",
			_meta: {
				"clio-coder/usage": { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 },
			},
		});

		deepStrictEqual(harness.updates.map(({ update }) => update), [
			{
				type: "message",
				replay: null,
				sessionId: fixtureSessionId,
				text: "Fixture turn started. ",
			},
			{
				type: "thought",
				replay: null,
				sessionId: fixtureSessionId,
				text: "Inspecting deterministic input. ",
			},
			{
				type: "tool",
				replay: null,
				variant: "start",
				sessionId: fixtureSessionId,
				toolCallId: fixtureToolCallId,
				title: "Read fixture note",
				kind: "read",
				status: "in_progress",
				locations: [join(harness.root, "notes.txt")],
			},
			{
				type: "tool",
				replay: null,
				variant: "update",
				sessionId: fixtureSessionId,
				toolCallId: fixtureToolCallId,
				title: "Read fixture note",
				kind: "read",
				status: "completed",
				locations: [join(harness.root, "notes.txt")],
			},
			{
				type: "message",
				replay: null,
				sessionId: fixtureSessionId,
				text: "Fixture turn complete.",
			},
		]);
		ok(harness.updates.every(({ generation }) => generation === harness.client.generation));
		deepStrictEqual(harness.failures, []);
		assertCooperativeRetire(
			await harness.client.retire({
				sessionId: fixtureSessionId,
				supportsClose: true,
				cancelActive: false,
			}),
		);
	});
});

Deno.test("ordinary fixture session lists omit aggregate truncation metadata", async () => {
	await withFixture("conversation", async (harness) => {
		await initialize(harness.client);
		await newSession(harness.client, harness.root);
		const result = await harness.client.request("clio-coder/session/list", {}, 2_000);
		ok(typeof result === "object" && result !== null && !Array.isArray(result));
		equal(Object.hasOwn(result, "_meta"), false);
	});
});

for (const scenario of ["stdout-partial", "stdout-multiple", "stdout-crlf"] as const) {
	Deno.test(`spawned fixture accepts ${scenario} framing without changing update order`, async () => {
		await withFixture(scenario, async (harness) => {
			await initializeAndCreateSession(harness);
			const result = await prompt(harness.client);
			equal((result as { stopReason?: unknown }).stopReason, "end_turn");
			deepStrictEqual(
				harness.updates.map(({ update }) => update.type === "tool" ? `${update.type}:${update.status}` : update.type),
				["message", "thought", "tool:in_progress", "tool:completed", "message"],
			);
			deepStrictEqual(harness.failures, []);
		});
	});
}

Deno.test("a minimal tool update inherits the already validated start identity and locations", async () => {
	await withFixture("tool-update-minimal", async (harness) => {
		await initializeAndCreateSession(harness);
		equal((await prompt(harness.client) as { stopReason?: unknown }).stopReason, "end_turn");
		const terminal = harness.updates.find(
			({ update }) => update.type === "tool" && update.variant === "update" && update.status === "completed",
		)?.update;
		ok(terminal?.type === "tool");
		equal(terminal.title, "Read fixture note");
		equal(terminal.kind, "read");
		deepStrictEqual(terminal.locations, [join(harness.root, "notes.txt")]);
	});
});

Deno.test("an exact 16 KiB UTF-8 Clio delta remains within the wire bound", async () => {
	await withFixture("unicode-delta", async (harness) => {
		await initializeAndCreateSession(harness);
		equal((await prompt(harness.client) as { stopReason?: unknown }).stopReason, "end_turn");
		const message = harness.updates[0]?.update;
		ok(message?.type === "message");
		equal(new TextEncoder().encode(message.text).byteLength, 16 * 1024);
		equal(message.text.length, 8 * 1024, "emoji use a UTF-16 surrogate pair");
		equal(Array.from(message.text).length, 4 * 1024);
	});
});

Deno.test("a Clio text delta beyond 16 KiB UTF-8 bytes fails the connection closed", async () => {
	await withFixture("unicode-delta-oversize", async (harness) => {
		await initializeAndCreateSession(harness);
		await rejects(
			prompt(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
		);
		await waitFor(() => harness.failures.length === 1, "oversize text-delta failure callback");
		assertSafeFailure(harness, "protocol-failure");
	});
});

for (
	const [decision, terminalStatus, finalText, wireOutcome] of [
		[
			"allow_once",
			"completed",
			"Observed allow-once.",
			'"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}',
		],
		[
			"reject_once",
			"failed",
			"Observed rejection.",
			'"result":{"outcome":{"outcome":"selected","optionId":"reject-once"}}',
		],
	] as const satisfies readonly (readonly [AcpPermissionDecision, string, string, string])[]
) {
	Deno.test(`permission ${decision} is one-shot and drives one terminal tool update`, async () => {
		await withFixture("permission", async (harness) => {
			await initializeAndCreateSession(harness);
			const promptPromise = prompt(harness.client);
			await waitFor(() => harness.permissions.length === 1, `${decision} permission request`);
			const recorded = harness.permissions[0];
			ok(recorded);
			equal(recorded.generation, harness.client.generation);
			deepStrictEqual(
				{
					requestId: recorded.request.requestId,
					sessionId: recorded.request.sessionId,
					toolCallId: recorded.request.toolCallId,
					title: recorded.request.title,
					kind: recorded.request.kind,
					locations: recorded.request.locations,
				},
				{
					requestId: "fixture-permission-1",
					sessionId: fixtureSessionId,
					toolCallId: fixtureToolCallId,
					title: "Write fixture note",
					kind: "edit",
					locations: [join(harness.root, "notes.txt")],
				},
			);
			ok(recorded.request.expiresAt > Date.now());
			ok(recorded.request.expiresAt <= Date.now() + 2_000);
			await recorded.request.resolve(decision);
			await rejects(
				recorded.request.resolve(decision),
				(error: unknown) => assertClientError(error, AcpClientError, "permission-settled"),
			);
			equal((await promptPromise as { stopReason?: unknown }).stopReason, "end_turn");

			const tools = harness.updates.filter((item) => item.update.type === "tool");
			equal(tools.length, 2);
			equal(tools[0]?.update.type === "tool" ? tools[0].update.status : undefined, "in_progress");
			equal(tools[1]?.update.type === "tool" ? tools[1].update.status : undefined, terminalStatus);
			const finalUpdate = harness.updates.at(-1)?.update;
			equal(finalUpdate?.type, "message");
			equal(
				finalUpdate?.type === "message" ? finalUpdate.text : undefined,
				finalText,
			);
			await waitFor(
				() => harness.client.stderrTail().includes(wireOutcome),
				`${decision} wire outcome observation`,
			);
			match(harness.client.stderrTail(), /"id":"fixture-permission-1"/);
			match(harness.client.stderrTail(), /"matched":true/);
			deepStrictEqual(harness.failures, []);
		});
	});
}

for (
	const [decision, terminalStatus, wireOutcome] of [
		["allow_once", "completed", '"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}'],
		["reject_once", "failed", '"result":{"outcome":{"outcome":"selected","optionId":"reject-once"}}'],
	] as const satisfies readonly (readonly [AcpPermissionDecision, string, string])[]
) {
	Deno.test(`literal ${decision} optionId remains authoritative when ACP option kinds and names are swapped`, async () => {
		await withFixture("permission-swapped-kinds", async (harness) => {
			await initializeAndCreateSession(harness);
			const promptPromise = prompt(harness.client);
			await waitFor(() => harness.permissions.length === 1, `${decision} swapped-kind permission request`);
			const permission = harness.permissions[0]?.request;
			ok(permission);
			await permission.resolve(decision);
			equal((await promptPromise as { stopReason?: unknown }).stopReason, "end_turn");
			const terminalTool = harness.updates.findLast(
				({ update }) => update.type === "tool" && update.variant === "update",
			)?.update;
			ok(terminalTool?.type === "tool");
			equal(terminalTool.status, terminalStatus);
			await waitFor(
				() => harness.client.stderrTail().includes(wireOutcome),
				`${decision} literal optionId wire response`,
			);
			deepStrictEqual(harness.failures, []);
		});
	});
}

Deno.test("absence of a permission hook immediately rejects with the literal reject-once optionId", async () => {
	await withFixture("permission", async (harness) => {
		await initializeAndCreateSession(harness);
		equal((await prompt(harness.client) as { stopReason?: unknown }).stopReason, "end_turn");
		deepStrictEqual(harness.permissions, []);
		deepStrictEqual(
			harness.updates.filter(({ update }) => update.type === "tool").map(({ update }) =>
				update.type === "tool" ? update.status : undefined
			),
			["in_progress", "failed"],
		);
		await waitFor(
			() =>
				harness.client.stderrTail().includes(
					'"result":{"outcome":{"outcome":"selected","optionId":"reject-once"}}',
				),
			"immediate reject-once wire response",
		);
		deepStrictEqual(harness.failures, []);
	}, { capturePermissions: false });
});

Deno.test("a host permission hook remains the sole settlement owner after the advisory expiry time", async () => {
	await withFixture("permission", async (harness) => {
		await initializeAndCreateSession(harness);
		const promptPromise = prompt(harness.client);
		await waitFor(() => harness.permissions.length === 1, "host-owned permission request");
		const permission = harness.permissions[0]?.request;
		ok(permission);
		await waitFor(() => Date.now() > permission.expiresAt + 20, "advisory permission expiry to pass");
		deepStrictEqual(harness.failures, []);
		equal(
			harness.updates.filter(
				({ update }) => update.type === "tool" && update.variant === "update" && update.status === "failed",
			).length,
			0,
		);
		await permission.resolve("reject_once");
		equal((await promptPromise as { stopReason?: unknown }).stopReason, "end_turn");
	}, { timing: { ...ordinaryTiming, permissionTimeoutMs: 40 } });
});

for (
	const scenario of [
		"tool-update-unknown",
		"tool-status-regression",
		"tool-terminal-duplicate",
		"permission-unknown-tool",
		"permission-raw-mismatch",
		"permission-raw-utf8-oversize",
		"permission-raw-nonfinite-collision",
		"permission-extra-option",
		"permission-option-missing",
		"permission-option-duplicate",
		"permission-wrong-discriminator",
	] as const
) {
	Deno.test(`${scenario} violates the bound tool identity and fails the connection closed`, async () => {
		await withFixture(scenario, async (harness) => {
			await initializeAndCreateSession(harness);
			await rejects(
				prompt(harness.client),
				(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
			);
			await waitFor(() => harness.failures.length === 1, `${scenario} failure callback`);
			assertSafeFailure(harness, "protocol-failure");
			if (scenario.startsWith("permission")) {
				equal(harness.permissions.length, 0);
			}
		});
	});
}

Deno.test("responses arriving out of order settle the request carrying the matching numeric id", async () => {
	await withFixture("response-out-of-order", async (harness) => {
		const first = initialize(harness.client, { _fixture: { marker: "first" } });
		const second = initialize(harness.client, { _fixture: { marker: "second" } });
		const results = await Promise.all([first, second]);
		equal((results[0] as { protocolVersion?: unknown }).protocolVersion, 1);
		equal((results[1] as { protocolVersion?: unknown }).protocolVersion, 1);
		deepStrictEqual(harness.failures, []);
	});
});

Deno.test("the pending request cap rejects request seventeen without allocating or writing it", async () => {
	await withFixture("happy", async (harness) => {
		const pending = Array.from(
			{ length: ACP_MAX_PENDING_REQUESTS },
			(_, index) =>
				harness.client.request("initialize", {
					protocolVersion: 1,
					_fixture: { delayMs: 500, marker: index },
				}, 100).catch(() => undefined),
		);
		await rejects(
			harness.client.request("initialize", { protocolVersion: 1 }, 2_000),
			(error: unknown) => assertClientError(error, AcpClientError, "pending-limit"),
		);
		await harness.client.retire({ supportsClose: false, cancelActive: false });
		await Promise.allSettled(pending);
	}, { terminationScope: "direct-child" });
});

Deno.test("a timed-out request rejects locally and its late response fails the connection closed", async () => {
	await withFixture("happy", async (harness) => {
		await rejects(
			harness.client.request("initialize", {
				protocolVersion: 1,
				_fixture: { delayMs: 120 },
			}, 20),
			(error: unknown) => assertClientError(error, AcpTimeoutError, "request-timeout"),
		);
		await waitFor(() => harness.failures.length === 1, "late-response protocol failure");
		assertSafeFailure(harness, "protocol-failure");
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "client-closed"),
		);
	});
});

for (const scenario of ["response-unknown", "response-mixed"] as const) {
	Deno.test(`${scenario} response shape fails closed exactly once`, async () => {
		await withFixture(scenario, async (harness) => {
			await rejects(
				initialize(harness.client),
				(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
			);
			await waitFor(() => harness.failures.length === 1, `${scenario} failure callback`);
			assertSafeFailure(harness, "protocol-failure");
		});
	});
}

Deno.test("an unknown incoming notification fails closed once without sending a response", async () => {
	await withFixture("notification-unknown", async (harness) => {
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
		);
		await waitFor(() => harness.failures.length === 1, "unknown-notification failure callback");
		assertSafeFailure(harness, "protocol-failure");
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "client-closed"),
		);
		assertForcedProtocolRetire(await harness.client.retire({ supportsClose: false, cancelActive: false }));
		assertSafeFailure(harness, "protocol-failure");
		ok(!harness.client.stderrTail().includes("permission-response="));
	});
});

Deno.test("an unknown incoming request receives one fixed method-not-found error before fail-closed cleanup", async () => {
	await withFixture("request-unknown", async (harness) => {
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
		);
		await waitFor(() => harness.failures.length === 1, "unknown-request failure callback");
		assertSafeFailure(harness, "protocol-failure");
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "client-closed"),
		);
		assertForcedProtocolRetire(await harness.client.retire({ supportsClose: false, cancelActive: false }));
		assertSafeFailure(harness, "protocol-failure");

		const prefix = "fixture: permission-response=";
		const responses = harness.client.stderrTail().split("\n").filter((line) => line.startsWith(prefix));
		equal(responses.length, 1);
		deepStrictEqual(JSON.parse(responses[0]?.slice(prefix.length) ?? "null"), {
			id: "fixture-unknown-request-1",
			error: { code: -32601, message: "method not found" },
			matched: false,
		});
	});
});

Deno.test("a duplicate response resolves once and then fails the connection closed exactly once", async () => {
	await withFixture("response-duplicate", async (harness) => {
		equal((await initialize(harness.client) as { protocolVersion?: unknown }).protocolVersion, 1);
		await waitFor(() => harness.failures.length === 1, "duplicate-response failure callback");
		assertSafeFailure(harness, "protocol-failure");
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "client-closed"),
		);
	});
});

Deno.test("remote JSON-RPC errors expose only bounded Clio metadata and a generic local message", async () => {
	await withFixture("remote-error-protocol-version", async (harness) => {
		let observed: unknown;
		try {
			await initialize(harness.client);
		} catch (error) {
			observed = error;
		}
		ok(observed instanceof AcpRemoteError);
		equal(observed.code, "remote-error");
		equal(observed.rpcCode, -32_602);
		deepStrictEqual(observed.remote, {
			version: 1,
			code: "protocol_version_unsupported",
			supported: [1],
		});
		equal(observed.message, "The ACP peer rejected initialize (JSON-RPC -32602).");
		const serialized = JSON.stringify(observed);
		ok(!serialized.includes("fixture-secret"));
		ok(!serialized.includes("untrusted"));
		deepStrictEqual(harness.failures, []);
	});
});

Deno.test("the remote error metadata vocabulary is the frozen eighteen code set", () => {
	deepStrictEqual(ACP_REMOTE_ERROR_CODES, [
		"not_initialized",
		"already_initialized",
		"protocol_version_unsupported",
		"invalid_params",
		"session_cwd_mismatch",
		"session_limit",
		"session_unknown",
		"session_open",
		"prompt_active",
		"prompt_not_admitted",
		"permission_expired",
		"turn_failed",
		"parse_error",
		"invalid_request",
		"input_line_too_large",
		"invalid_request_id",
		"method_not_found",
		"internal_error",
	]);
});

Deno.test("remote-error-extra fails the connection as unknown remote metadata", async () => {
	await withFixture("remote-error-extra", async (harness) => {
		await rejects(
			initialize(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
		);
		await waitFor(() => harness.failures.length === 1, "one protocol failure");
		deepStrictEqual(harness.failures.map(({ failure }) => failure.code), ["protocol-failure"]);
		deepStrictEqual(harness.extensionEvents, []);
	});
});

Deno.test("stderr tail is byte-capped and redacts configured paths, API-key forms, and bearer credentials", async () => {
	const privatePath = "/fixture/private/project";
	await withFixture("stderr-noise", async (harness) => {
		await initialize(harness.client);
		const tail = harness.client.stderrTail();
		ok(encoder.encode(tail).byteLength <= ACP_MAX_STDERR_TAIL_BYTES);
		ok(encoder.encode(tail).byteLength > 15 * 1024, "fixture must exercise the byte cap, not a short stderr path");
		ok(!tail.includes(privatePath));
		ok(!tail.includes("fixture-secret-value"));
		match(tail, /Authorization: Bearer \[redacted\]/);
		match(tail, /fixture path=\[redacted\]/);
	}, { redact: [privatePath] });

	await withFixture("stderr-noise", async (harness) => {
		await initialize(harness.client);
		const tail = harness.client.stderrTail();
		ok(!tail.includes("fixture-secret-value"));
		match(tail, /Bearer \[redacted\]/);
	}, { redact: [] });
});

for (const scenario of ["stdout-malformed", "stdout-oversize", "stdout-partial-eof"] as const) {
	Deno.test(`${scenario} stdout fails as a bounded protocol error`, async () => {
		await withFixture(scenario, async (harness) => {
			await rejects(
				initialize(harness.client),
				(error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"),
			);
			await waitFor(() => harness.failures.length === 1, `${scenario} failure callback`);
			assertSafeFailure(harness, "protocol-failure");
		});
	});
}

Deno.test("an early child exit reports one safe failure and preserves its bounded diagnostic tail", async () => {
	await withFixture("exit-early", async (harness) => {
		await waitFor(() => harness.failures.length === 1, "early process exit");
		assertSafeFailure(harness, "process-exited");
		match(harness.client.stderrTail(), /fixture: intentional early exit/);
		const result = await harness.client.retire({ supportsClose: false, cancelActive: false });
		equal(result.exited, true);
		equal(result.escalated, false);
		equal(result.exitCode, 21);
		equal(result.signal, null);
	});
});

Deno.test("a child exit during prompt rejects the turn and reports exactly one safe failure", async () => {
	await withFixture("exit-during-turn", async (harness) => {
		await initializeAndCreateSession(harness);
		await rejects(
			prompt(harness.client),
			(error: unknown) => assertClientError(error, AcpClientError, "process-exited"),
		);
		await waitFor(() => harness.failures.length === 1, "during-turn process exit");
		assertSafeFailure(harness, "process-exited");
		deepStrictEqual(harness.updates.map(({ update }) => update.type), ["message"]);
		match(harness.client.stderrTail(), /fixture: intentional during-turn exit/);
		const result = await harness.client.retire({ supportsClose: false, cancelActive: false });
		equal(result.exited, true);
		equal(result.exitCode, 22);
	});
});

Deno.test("retirement accepts the parked-permission cancel sweep before prompt settlement and session close", async () => {
	await withFixture("permission", async (harness) => {
		await initializeAndCreateSession(harness);
		const promptPromise = prompt(harness.client);
		let failedToolsAtPromptSettlement = -1;
		const observedPrompt = promptPromise.then((result) => {
			failedToolsAtPromptSettlement = harness.updates.filter(
				({ update }) => update.type === "tool" && update.variant === "update" && update.status === "failed",
			).length;
			return result;
		});
		await waitFor(() => harness.permissions.length === 1, "parked permission before retirement");

		const result = await harness.client.retire({
			sessionId: fixtureSessionId,
			supportsClose: true,
			cancelActive: true,
		});
		deepStrictEqual(await observedPrompt, {
			stopReason: "cancelled",
			_meta: {
				"clio-coder/usage": { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 },
			},
		});
		equal(failedToolsAtPromptSettlement, 1);
		deepStrictEqual(
			harness.updates.filter(({ update }) => update.type === "tool").map(({ update }) =>
				update.type === "tool" ? update.status : undefined
			),
			["in_progress", "failed"],
		);
		assertCooperativeRetire(result);
		match(
			harness.client.stderrTail(),
			/permission-response=.*"result":\{"outcome":\{"outcome":"cancelled"\}\}.*"matched":true/u,
		);
		match(
			harness.client.stderrTail(),
			/eof-calls=request:initialize>request:session\/new>request:session\/prompt>notification:session\/cancel>request:session\/close/u,
		);
	});
});

Deno.test("retire cancels an active prompt, waits for settlement, closes, then reaches cooperative EOF", async () => {
	await withFixture("hang", async (harness) => {
		await initializeAndCreateSession(harness);
		const promptPromise = prompt(harness.client);
		await waitFor(
			() => harness.updates.some(({ update }) => update.type === "thought"),
			"parked prompt update",
		);
		const result = await harness.client.retire({
			sessionId: fixtureSessionId,
			supportsClose: true,
			cancelActive: true,
		});
		deepStrictEqual(await promptPromise, {
			stopReason: "cancelled",
			_meta: {
				"clio-coder/usage": { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 },
			},
		});
		assertCooperativeRetire(result);
		match(
			harness.client.stderrTail(),
			/fixture: eof-calls=request:initialize>request:session\/new>request:session\/prompt>notification:session\/cancel>request:session\/close/,
		);
	});
});

Deno.test("retirement keeps the exact prompt promise when cancellation settles during its write", async () => {
	const originalWrite = WritableStreamDefaultWriter.prototype.write;
	const releaseCancelWrite = Promise.withResolvers<void>();
	let cancelWriteHeld = false;
	WritableStreamDefaultWriter.prototype.write = function (chunk?: unknown): Promise<void> {
		const written = originalWrite.call(this, chunk);
		if (
			!cancelWriteHeld && chunk instanceof Uint8Array &&
			decoder.decode(chunk).includes('"method":"session/cancel"')
		) {
			cancelWriteHeld = true;
			return written.then(() => releaseCancelWrite.promise);
		}
		return written;
	};
	try {
		await withFixture("hang", async (harness) => {
			try {
				await initializeAndCreateSession(harness);
				const promptPromise = prompt(harness.client);
				await waitFor(
					() => harness.updates.some(({ update }) => update.type === "thought"),
					"parked prompt update",
				);

				const retirement = harness.client.retire({
					sessionId: fixtureSessionId,
					supportsClose: true,
					cancelActive: true,
				});
				await waitFor(() => cancelWriteHeld, "held session/cancel write");
				deepStrictEqual(await promptPromise, {
					stopReason: "cancelled",
					_meta: {
						"clio-coder/usage": { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 },
					},
				});
				releaseCancelWrite.resolve();
				assertCooperativeRetire(await retirement);
			} finally {
				releaseCancelWrite.resolve();
			}
		});
	} finally {
		WritableStreamDefaultWriter.prototype.write = originalWrite;
		releaseCancelWrite.resolve();
	}
});

Deno.test("retirement cancels a remotely active prompt after its local request timed out and skips close", async () => {
	await withFixture("hang", async (harness) => {
		await initializeAndCreateSession(harness);
		const timedOutPrompt = rejects(
			harness.client.request("session/prompt", {
				sessionId: fixtureSessionId,
				prompt: [{ type: "text", text: "Time out locally while the fixture remains parked." }],
			}, 250),
			(error: unknown) => assertClientError(error, AcpTimeoutError, "request-timeout"),
		);
		await waitFor(
			() => harness.updates.some(({ update }) => update.type === "thought"),
			"parked prompt before its local timeout",
		);
		await timedOutPrompt;

		const result = await harness.client.retire({
			sessionId: fixtureSessionId,
			supportsClose: true,
			cancelActive: true,
		});
		assertForcedProtocolRetire(result);
		match(
			harness.client.stderrTail(),
			/eof-calls=request:initialize>request:session\/new>request:session\/prompt>notification:session\/cancel/u,
		);
		ok(!harness.client.stderrTail().includes("request:session/close"));
	});
});

Deno.test("a permission first observed after retirement freezes is cancelled without reaching the host", async () => {
	await withFixture("permission", async (harness) => {
		await initializeAndCreateSession(harness);
		const promptPromise = prompt(harness.client, { _fixture: { delayMs: 50 } });
		const result = await harness.client.retire({
			sessionId: fixtureSessionId,
			supportsClose: false,
			cancelActive: false,
		});

		deepStrictEqual(harness.permissions, []);
		equal((await promptPromise as { stopReason?: unknown }).stopReason, "cancelled");
		equal(result.exited, true);
		equal(result.escalated, false);
		equal(result.promptSettledBeforeClose, false);
		match(
			harness.client.stderrTail(),
			/permission-response=.*"result":\{"outcome":\{"outcome":"cancelled"\}\}.*"matched":true/u,
		);
	});
});

Deno.test("retirement rejects an outstanding non-prompt request before returning", async () => {
	await withFixture("response-out-of-order", async (harness) => {
		const pending = initialize(harness.client);
		const rejected = rejects(
			pending,
			(error: unknown) => assertClientError(error, AcpClientError, "client-closed"),
		);
		const result = await harness.client.retire({ supportsClose: false, cancelActive: false });
		await rejected;
		equal(result.exited, true);
	});
});

Deno.test({
	name: "Linux retirement terminates an owned descendant after its process-group leader exits",
	ignore: Deno.build.os !== "linux",
	async fn() {
		await withFixture("leader-exits-descendant", async (harness) => {
			await initializeAndCreateSession(harness);
			const result = await harness.client.retire({ supportsClose: false, cancelActive: false });
			equal(result.scope, "posix-process-group");
			equal(result.exited, true);
			equal(result.escalated, true);
			const observed = /descendant-pid=(\d+)/.exec(harness.client.stderrTail());
			ok(observed?.[1]);
			const descendantProbe = await new Deno.Command("kill", {
				args: ["--signal", "0", observed[1]],
				stdin: "null",
				stdout: "null",
				stderr: "null",
			}).output();
			equal(descendantProbe.success, false);
		});
	},
});

Deno.test({
	name: "Linux direct-child retirement exercises TERM-to-KILL escalation",
	ignore: Deno.build.os !== "linux",
	async fn() {
		await withFixture("resist-term", async (harness) => {
			await initializeAndCreateSession(harness);
			const promptPromise = prompt(harness.client);
			await waitFor(
				() => harness.updates.some(({ update }) => update.type === "thought"),
				"direct-child TERM-resistant parked prompt",
			);
			const result = await harness.client.retire({
				sessionId: fixtureSessionId,
				supportsClose: true,
				cancelActive: true,
			});
			equal((await promptPromise as { stopReason?: unknown }).stopReason, "cancelled");
			equal(result.scope, "direct-child");
			equal(result.exited, true);
			equal(result.escalated, true);
			equal(result.signal, "SIGKILL");
		}, { terminationScope: "direct-child" });
	},
});

Deno.test({
	name: "Linux retirement escalates a TERM-resistant owned process group from TERM to KILL",
	ignore: Deno.build.os !== "linux",
	async fn() {
		await withFixture("resist-term", async (harness) => {
			await initializeAndCreateSession(harness);
			const promptPromise = prompt(harness.client);
			await waitFor(
				() => harness.updates.some(({ update }) => update.type === "thought"),
				"TERM-resistant parked prompt",
			);
			const result = await harness.client.retire({
				sessionId: fixtureSessionId,
				supportsClose: true,
				cancelActive: true,
			});
			equal((await promptPromise as { stopReason?: unknown }).stopReason, "cancelled");
			equal(result.scope, "posix-process-group");
			equal(result.exited, true);
			equal(result.escalated, true);
			equal(result.promptSettledBeforeClose, true);
			equal(result.exitCode, 128 + 9);
			equal(result.signal, "SIGKILL");
			match(harness.client.stderrTail(), /intentionally ignored SIGTERM/);
		});
	},
});

Deno.test("the extension event surface is advertised independently and delivered only after opt in", async () => {
	// Advertisement names server support. Client opt in controls emission.
	await withFixture("seventeen-bash", async (harness) => {
		const initialized = await initialize(harness.client);
		const meta = ((initialized as { agentCapabilities?: { _meta?: Record<string, unknown> } }).agentCapabilities ?? {})
			._meta ?? {};
		deepStrictEqual(meta["clio-coder/events"], {
			version: 1,
			notification: "clio-coder/event",
			kinds: ["safety.loopBlocked"],
			workspaceInstanceId: "fixture-workspace-1",
		});
		await newSession(harness.client, harness.root);

		const turn = prompt(harness.client, {});
		for (let call = 0; call < 5; call += 1) {
			await waitFor(() => harness.permissions.length === call + 1, `permission ${call + 1}`);
			const request = harness.permissions[call]?.request;
			ok(request);
			await request.resolve("allow_once");
		}
		deepStrictEqual(harness.extensionEvents, []);
		await harness.client.notify("session/cancel", { sessionId: fixtureSessionId }).catch(() => undefined);
		await turn.catch(() => undefined);
	});

	// With the opt-in the same run advertises the notification and reports the loop.
	await withFixture("seventeen-bash", async (harness) => {
		const initialized = await initialize(harness.client, {
			clientCapabilities: { _meta: { "clio-coder/events": { version: 1, kinds: ["safety.loopBlocked"] } } },
		});
		const meta = ((initialized as { agentCapabilities?: { _meta?: Record<string, unknown> } }).agentCapabilities ?? {})
			._meta ?? {};
		deepStrictEqual(meta["clio-coder/events"], {
			version: 1,
			notification: "clio-coder/event",
			kinds: ["safety.loopBlocked"],
			workspaceInstanceId: "fixture-workspace-1",
		});
		await newSession(harness.client, harness.root);

		const turn = prompt(harness.client, {});
		for (let call = 0; call < 4; call += 1) {
			await waitFor(() => harness.permissions.length === call + 1, `permission ${call + 1}`);
			const request = harness.permissions[call]?.request;
			ok(request);
			await request.resolve("allow_once");
		}
		await waitFor(() => harness.extensionEvents.length > 0, "a loop-blocked event");
		const first = harness.extensionEvents[0];
		ok(first);
		equal(first.event.kind, "safety.loopBlocked");
		equal(first.event.sequence, 1);
		equal(first.event.payload.tool, "bash");
		equal(first.event.payload.repeatCount, 3);
		equal(first.event.payload.shape, null);
		await harness.client.notify("session/cancel", { sessionId: fixtureSessionId }).catch(() => undefined);
		await turn.catch(() => undefined);
	});
});

for (
	const scenario of [
		"event-without-opt-in",
		"event-workspace-mismatch",
		"event-session-mismatch",
		"event-terminal-invalid",
		"event-tool-fields-invalid",
		"event-count-invalid",
		"event-interruption-invalid",
	] as const
) {
	Deno.test(`${scenario} fails the ACP connection before publication`, async () => {
		await withFixture(scenario, async (harness) => {
			const optIn = scenario === "event-without-opt-in" ? {} : {
				clientCapabilities: {
					_meta: { "clio-coder/events": { version: 1, kinds: ["safety.loopBlocked"] } },
				},
			};
			await initialize(harness.client, optIn);
			await newSession(harness.client, harness.root);
			const turn = prompt(harness.client);
			await allowFixturePermissions(harness, 0, 3);
			await rejects(turn, (error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"));
			await waitFor(() => harness.failures.length === 1, "one protocol failure");
			deepStrictEqual(harness.extensionEvents, []);
			equal(harness.failures[0]?.failure.code, "protocol-failure");
		});
	});
}

for (const scenario of ["event-sequence-repeat", "event-turn-changed"] as const) {
	Deno.test(`${scenario} fails after one valid event without publishing the second`, async () => {
		await withFixture(scenario, async (harness) => {
			await initialize(harness.client, {
				clientCapabilities: {
					_meta: { "clio-coder/events": { version: 1, kinds: ["safety.loopBlocked"] } },
				},
			});
			await newSession(harness.client, harness.root);
			const turn = prompt(harness.client);
			await allowFixturePermissions(harness, 0, 6);
			await rejects(turn, (error: unknown) => assertClientError(error, AcpClientError, "protocol-failure"));
			await waitFor(() => harness.failures.length === 1, "one protocol failure");
			equal(harness.extensionEvents.length, 1);
			equal(harness.extensionEvents[0]?.event.sequence, 1);
			equal(harness.failures[0]?.failure.code, "protocol-failure");
		});
	});
}

Deno.test("extension event sequence increases across prompts in one child process", async () => {
	await withFixture("seventeen-bash", async (harness) => {
		await initialize(harness.client, {
			clientCapabilities: {
				_meta: { "clio-coder/events": { version: 1, kinds: ["safety.loopBlocked"] } },
			},
		});
		await newSession(harness.client, harness.root);

		const first = prompt(harness.client);
		await allowFixturePermissions(harness, 0, 17);
		await first;
		const firstSequences = harness.extensionEvents.map(({ event }) => event.sequence);
		ok(firstSequences.length > 0);
		const firstMaximum = Math.max(...firstSequences);

		const second = prompt(harness.client);
		await allowFixturePermissions(harness, 17, 3);
		await waitFor(() => harness.extensionEvents.length > firstSequences.length, "the next prompt event");
		equal(harness.extensionEvents[firstSequences.length]?.event.sequence, firstMaximum + 1);
		await harness.client.notify("session/cancel", { sessionId: fixtureSessionId });
		await second;
	});
});

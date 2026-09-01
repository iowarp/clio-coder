/**
 * Process-boundary tests for `ClioProjectHost`.
 *
 * Every scenario runs against `acp-child-fixture.ts` over real stdio, so the
 * assertions cover framing, permission mediation, cancellation, redaction, and
 * child retirement on the code path the product uses. There is no fake engine
 * and no in-process shortcut.
 */

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpClientTiming, AcpLaunchSpec } from "../acp-client.ts";
import { applyTurnEvent, emptyTurnProjection, type TurnEventInput, type TurnProjection } from "../src/timeline.ts";
import {
	type ClioLauncher,
	ClioProjectHost,
	createLocalClioLauncher,
	HostError,
	type HostEvent,
	type HostProject,
	type HostSink,
	type HostTurnContext,
} from "../clio-host.ts";

const fixturePath = fileURLToPath(new URL("./acp-child-fixture.ts", import.meta.url));

/** Long enough that the ACP ceiling never decides a test; the host budget does. */
const fastTiming: AcpClientTiming = {
	permissionTimeoutMs: 60_000,
	writeTimeoutMs: 500,
	cancelGraceMs: 300,
	closeTimeoutMs: 300,
	exitGraceMs: 300,
	termGraceMs: 150,
	killObservationMs: 1_500,
};

type MatchingEvent<E, T extends HostEvent["type"]> = E extends { type: infer K } ? T extends K ? E & { type: T } : never
	: never;
type EventOf<T extends HostEvent["type"]> = MatchingEvent<HostEvent, T>;

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

class NeverRefreshingSink extends RecordingSink {
	override refreshProject(projectId: string): Promise<void> {
		this.refreshes.push(projectId);
		return new Promise(() => undefined);
	}
}

class RejectFirstTerminalSink extends RecordingSink {
	#rejected = false;

	override emit(event: HostEvent): void {
		if (event.type === "turn.terminal" && !this.#rejected) {
			this.#rejected = true;
			throw new Error("fixture terminal sink rejection");
		}
		super.emit(event);
	}
}

interface FixtureLauncherHarness {
	readonly launcher: ClioLauncher;
	readonly launchedRoots: string[];
}

function fixtureLaunch(
	root: string,
	scenario: string,
	callLogPath?: string,
	permissionLogPath?: string,
): AcpLaunchSpec {
	const writable = [callLogPath, permissionLogPath].filter((path): path is string => path !== undefined);
	return {
		command: Deno.execPath(),
		args: [
			"run",
			"--quiet",
			"--no-config",
			...(writable.length === 0 ? [] : [`--allow-write=${writable.join(",")}`]),
			...(scenario === "leader-exits-descendant" ? ["--allow-run=/usr/bin/sleep"] : []),
			fixturePath,
			`--scenario=${scenario}`,
			...(callLogPath === undefined ? [] : [`--call-log=${callLogPath}`]),
			...(permissionLogPath === undefined ? [] : [`--permission-log=${permissionLogPath}`]),
		],
		cwd: root,
		clearEnv: true,
		terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
		redact: [root],
	};
}

function fixtureLauncher(
	scenario: string,
	callLogPath?: string,
	permissionLogPath?: string,
): FixtureLauncherHarness {
	const launchedRoots: string[] = [];
	return {
		launchedRoots,
		launcher: {
			launch(trustedRoot) {
				launchedRoots.push(trustedRoot);
				return fixtureLaunch(trustedRoot, scenario, callLogPath, permissionLogPath);
			},
		},
	};
}

function project(projectId: string, trustedRoot: string): HostProject {
	return { projectId, trustedRoot, displayName: `Project ${projectId}` };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function holdFirstWriterFrame(fragment: string): Readonly<{
	held: () => boolean;
	release: () => void;
	restore: () => void;
}> {
	const originalWrite = WritableStreamDefaultWriter.prototype.write;
	const gate = Promise.withResolvers<void>();
	let held = false;
	WritableStreamDefaultWriter.prototype.write = function (chunk?: unknown): Promise<void> {
		const written = originalWrite.call(this, chunk);
		if (!held && chunk instanceof Uint8Array && new TextDecoder().decode(chunk).includes(fragment)) {
			held = true;
			return written.then(() => gate.promise);
		}
		return written;
	};
	return {
		held: () => held,
		release: () => gate.resolve(),
		restore: () => {
			WritableStreamDefaultWriter.prototype.write = originalWrite;
			gate.resolve();
		},
	};
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
		await delay(5);
	}
}

async function waitForEvent<T extends HostEvent["type"]>(
	sink: RecordingSink,
	type: T,
	predicate: (event: EventOf<T>) => boolean = () => true,
	timeoutMs = 5_000,
): Promise<EventOf<T>> {
	await waitFor(() => sink.ofType(type).some(predicate), `${type} event`, timeoutMs);
	const event = sink.ofType(type).find(predicate);
	ok(event);
	return event;
}

function assertHostError(code: HostError["code"]): (error: unknown) => boolean {
	return (error: unknown): boolean => {
		ok(error instanceof HostError, `expected HostError, received ${String(error)}`);
		equal(error.code, code);
		return true;
	};
}

interface Harness {
	readonly root: string;
	readonly sink: RecordingSink;
	readonly host: ClioProjectHost;
	readonly launchedRoots: string[];
	readonly callLogPath: string;
	readonly permissionLogPath: string;
	dispose(): Promise<void>;
}

interface HarnessOptions {
	readonly sink?: RecordingSink;
	readonly callLog?: boolean;
	readonly permissionLog?: boolean;
	readonly bind?: boolean;
	readonly promptTimeoutMs?: number;
	readonly permissionEscalateMs?: number;
	readonly permissionBudgetMs?: number;
	readonly acpTiming?: AcpClientTiming;
	readonly now?: () => number;
}

/** Opens a temp root, spawns the fixture child, and binds a session unless told otherwise. */
async function harness(scenario: string, options: HarnessOptions = {}): Promise<Harness> {
	const root = await Deno.makeTempDir({ prefix: `workbench-host-${scenario}-` });
	const callLogPath = join(root, "acp-calls.json");
	const permissionLogPath = join(root, "acp-permissions.json");
	const launcher = fixtureLauncher(
		scenario,
		options.callLog === true ? callLogPath : undefined,
		options.permissionLog === true ? permissionLogPath : undefined,
	);
	const sink = options.sink ?? new RecordingSink();
	const host = new ClioProjectHost({
		launcher: launcher.launcher,
		project: project(`project-${scenario}`, root),
		sink,
		acpTiming: options.acpTiming ?? fastTiming,
		...(options.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: options.promptTimeoutMs }),
		...(options.permissionEscalateMs === undefined ? {} : { permissionEscalateMs: options.permissionEscalateMs }),
		...(options.permissionBudgetMs === undefined ? {} : { permissionBudgetMs: options.permissionBudgetMs }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	const dispose = async (): Promise<void> => {
		await host.close().catch(() => undefined);
		await Deno.remove(root, { recursive: true }).catch(() => undefined);
	};
	if (options.bind !== false) {
		try {
			await host.open();
			await host.newSession();
		} catch (error) {
			await dispose();
			throw error;
		}
	}
	return { root, sink, host, launchedRoots: launcher.launchedRoots, callLogPath, permissionLogPath, dispose };
}

/** The fixture writes its call log as it exits, so tests wait for the file. */
async function waitForCallLog(callLogPath: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			JSON.parse(await Deno.readTextFile(callLogPath));
			return;
		} catch {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the fixture call log.");
			await delay(10);
		}
	}
}

async function callMethods(callLogPath: string): Promise<string[]> {
	const calls = JSON.parse(await Deno.readTextFile(callLogPath)) as Array<{ method?: unknown }>;
	return calls.map((call) => String(call.method));
}

/**
 * Folds the host's own event stream the way the runtime does and asserts, at
 * every published snapshot, that a pending approval and the `awaiting-approval`
 * phase are present together or absent together. That pairing is what lets the
 * renderer keep a strict consistency check.
 */
function assertPhaseMatchesPendingApproval(sink: RecordingSink): void {
	let projection: TurnProjection = emptyTurnProjection;
	let checked = 0;
	for (const event of sink.events) {
		if (event.type === "clio-coder.state") {
			const awaiting = event.snapshot.phase === "awaiting-approval";
			equal(
				projection.pendingPermission !== null,
				awaiting,
				`phase ${event.snapshot.phase} disagreed with the pending approval`,
			);
			checked += 1;
			continue;
		}
		if (!event.type.startsWith("turn.")) continue;
		const turnEvent = event as Extract<HostEvent, { context: HostTurnContext }>;
		projection = applyTurnEvent(
			projection,
			{ kind: turnEvent.type, turnId: turnEvent.context.turnId, payload: turnEvent.payload } as TurnEventInput,
			new Date().toISOString(),
		);
	}
	ok(checked > 0, "expected at least one published snapshot");
}

Deno.test("one prompt uses a single trusted-root lifecycle and exposes only safe surrogates", async () => {
	const test = await harness("happy");
	try {
		equal(test.host.phase, "idle");
		const context = await test.host.startTurn("Run the ACP fixture.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "completed");
		equal(terminal.payload.stopReason, "end_turn");
		deepStrictEqual(terminal.payload.usage, { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 });
		deepStrictEqual(test.launchedRoots, [test.root]);
		ok(test.sink.ofType("turn.text").length >= 1);
		ok(test.sink.ofType("turn.thought").length >= 1);
		deepStrictEqual(test.sink.ofType("turn.tool").map((event) => event.payload.status), ["in_progress", "completed"]);
		ok(
			test.sink.ofType("turn.tool").every((event) =>
				event.payload.locations.length === 1 && event.payload.locations[0]?.segments.length === 1 &&
				event.payload.locations[0]?.segments[0] === "notes.txt"
			),
		);
		await waitFor(() => test.sink.refreshes.includes(test.host.project.projectId), "project refresh");
		const projection = JSON.stringify(test.sink.events);
		for (const secret of [test.root, "fixture-session-1", "fixture-tool-1", "rawInput", "rawOutput"]) {
			ok(!projection.includes(secret), `renderer projection leaked ${secret}`);
		}
		match(context.sessionId, /^session-/u);
		equal(context.turnId, "turn-1");
	} finally {
		await test.dispose();
	}
});

Deno.test("one child serves many prompts and the turn counter keeps climbing", async () => {
	const test = await harness("happy");
	try {
		const generation = test.host.generation;
		const sessionId = test.host.boundSessionPublicId;
		const turnIds: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const context = await test.host.startTurn(`Prompt number ${index + 1}.`);
			turnIds.push(context.turnId);
			await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
			equal(context.sessionId, sessionId);
			equal(context.generation, generation);
		}
		deepStrictEqual(turnIds, ["turn-1", "turn-2", "turn-3"]);
		deepStrictEqual(test.launchedRoots, [test.root]);
		equal(test.host.phase, "idle");
	} finally {
		await test.dispose();
	}
});

Deno.test("a second prompt while one is running is refused without disturbing the active turn", async () => {
	const test = await harness("hang");
	try {
		const context = await test.host.startTurn("Park until canceled.");
		await waitForEvent(test.sink, "turn.thought", (event) => event.context.turnId === context.turnId);
		await rejects(test.host.startTurn("Compete for the active prompt."), assertHostError("conflict"));
		equal(test.host.activeTurnId, context.turnId);
		equal(test.sink.ofType("turn.started").length, 1);
		await test.host.cancelTurn(context.turnId);
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("outside-root locations are dropped as untrusted presentation without failing the turn", async () => {
	const test = await harness("outside-location");
	try {
		const context = await test.host.startTurn("Treat reported locations as presentation only.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "completed");
		deepStrictEqual(test.sink.ofType("turn.tool").map((event) => event.payload.locations), [[], []]);
		ok(!JSON.stringify(test.sink.events).includes("outside.txt"));
	} finally {
		await test.dispose();
	}
});

for (
	const [scenario, summary] of [
		["initialize-version-invalid", "Clio Coder returned an invalid ACP initialize result."],
		["initialize-capabilities-missing", "Clio Coder returned unsupported ACP capabilities."],
	] as const
) {
	Deno.test(`${scenario} fails the open before any session exists`, async () => {
		const test = await harness(scenario, { bind: false, callLog: true });
		try {
			await rejects(test.host.open(), assertHostError("not-ready"));
			equal(test.host.phase, "failed");
			equal(test.host.snapshot().lastFailure?.code, "acp-contract-failure");
			equal(test.host.snapshot().lastFailure?.summary, summary);
			await waitForCallLog(test.callLogPath);
			deepStrictEqual(await callMethods(test.callLogPath), ["initialize"]);
			equal(test.sink.ofType("turn.started").length, 0);
			equal(test.sink.ofType("turn.text").length, 0);
			ok(!JSON.stringify(test.sink.events).includes(test.root));
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("a Clio Coder that advertises session loading is accepted rather than refused", async () => {
	const test = await harness("initialize-capabilities-unsupported");
	try {
		equal(test.host.snapshot().capabilities?.load, true);
		equal(test.host.phase, "idle");
		equal(test.host.snapshot().lastFailure, null);
	} finally {
		await test.dispose();
	}
});

Deno.test("allowlisted protocol metadata reports only numeric versions", async () => {
	const test = await harness("remote-error-protocol-version", { bind: false });
	try {
		await rejects(test.host.open(), assertHostError("not-ready"));
		deepStrictEqual(test.host.snapshot().lastFailure, {
			code: "clio-coder-protocol-version-unsupported",
			summary: "Clio Coder does not support the ACP protocol version required by the GUI. Supported versions: 1.",
		});
		ok(!JSON.stringify(test.sink.events).includes("unsupported protocol version"));
	} finally {
		await test.dispose();
	}
});

Deno.test("unknown remote metadata fails the ACP connection without renderer exposure", async () => {
	const test = await harness("remote-error-extra", { bind: false });
	try {
		await rejects(test.host.open(), assertHostError("not-ready"));
		deepStrictEqual(test.host.snapshot().lastFailure, {
			code: "acp-protocol-failure",
			summary: "The Clio Coder ACP connection violated its bounded protocol.",
		});
		const projection = JSON.stringify(test.sink.events) + JSON.stringify(test.host.snapshot());
		for (
			const secret of [
				"fixture_rejected",
				'"test"',
				'"supported"',
				"fixture-secret-message",
				"fixture-secret-data",
				"fixture-secret-stack",
				"fixture-secret-extra",
				"/fixture/private/project",
				test.root,
			]
		) {
			ok(!projection.includes(secret), `safe error projection leaked ${secret}`);
		}
	} finally {
		await test.dispose();
	}
});

Deno.test("an allowlisted admission reason maps to fixed public code and prose", async () => {
	const test = await harness("remote-error-admission");
	try {
		const context = await test.host.startTurn("Exercise a mapped admission failure.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		deepStrictEqual(
			{
				outcome: terminal.payload.outcome,
				code: terminal.payload.code,
				summary: terminal.payload.summary,
				source: terminal.payload.source,
			},
			{
				outcome: "failed",
				code: "clio-coder-admission-model-not-configured",
				summary: "Clio Coder has no model configured for the orchestrator. Choose one in Settings.",
				source: "reported-by-clio",
			},
		);
		ok(!JSON.stringify(test.sink.events).includes("fixture admission prose must not survive projection"));
	} finally {
		await test.dispose();
	}
});

Deno.test("streamed text redacts a trusted root split across ACP chunks", async () => {
	const test = await harness("project-root-split");
	try {
		const context = await test.host.startTurn("Report the project note.");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(test.sink.ofType("turn.text").map((event) => event.payload.text).join(""), "Observed [project]/notes.txt");
		ok(!JSON.stringify(test.sink.events).includes(test.root));
	} finally {
		await test.dispose();
	}
});

Deno.test("a forged session update fails closed before renderer projection", async () => {
	const test = await harness("forged-session-update");
	try {
		await test.host.startTurn("Reject the forged session update.");
		const terminal = await waitForEvent(test.sink, "turn.terminal");
		equal(terminal.payload.outcome, "failed");
		equal(terminal.payload.code, "acp-protocol-failure");
		equal(test.sink.ofType("turn.text").length, 0);
		const projection = JSON.stringify(test.sink.events);
		ok(!projection.includes("raw-attacker-session-93841"));
		ok(!projection.includes("must-not-render"));
	} finally {
		await test.dispose();
	}
});

Deno.test("a cumulative update flood fails closed before the over-limit update projects", async () => {
	const test = await harness("update-flood");
	try {
		const context = await test.host.startTurn("Bound the update stream.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "failed");
		equal(terminal.payload.code, "workbench-update-budget-exceeded");
		equal(terminal.payload.source, "observed-by-workbench");
		const projection = JSON.stringify(test.sink.events);
		ok(!projection.includes("must-not-render-update-overflow"));
		ok(!projection.includes("acp-protocol-failure"));
	} finally {
		await test.dispose();
	}
});

Deno.test("a cumulative stream budget stops projection without mislabeling the peer protocol", async () => {
	const test = await harness("stream-budget");
	try {
		const context = await test.host.startTurn("Bound the text stream.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		deepStrictEqual(
			{ outcome: terminal.payload.outcome, code: terminal.payload.code, source: terminal.payload.source },
			{ outcome: "failed", code: "workbench-stream-budget-exceeded", source: "observed-by-workbench" },
		);
		const projection = JSON.stringify(test.sink.events);
		ok(!projection.includes("must-not-render-stream-budget-overflow"));
		ok(!projection.includes("acp-protocol-failure"));
	} finally {
		await test.dispose();
	}
});

for (
	const [scenario, expectedTextUpdates, expectedThoughtUpdates] of [
		["end-turn-no-updates", 0, 0],
		["end-turn-blank-message", 1, 0],
		["end-turn-thought-only", 0, 1],
	] as const
) {
	Deno.test(`${scenario} cannot satisfy an end_turn without substantive projected activity`, async () => {
		const test = await harness(scenario);
		try {
			const context = await test.host.startTurn("Reject a turn without a substantive projected answer.");
			const terminal = await waitForEvent(
				test.sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			deepStrictEqual(
				{ outcome: terminal.payload.outcome, code: terminal.payload.code, stopReason: terminal.payload.stopReason },
				{ outcome: "failed", code: "empty-turn", stopReason: "end_turn" },
			);
			equal(test.sink.ofType("turn.text").length, expectedTextUpdates);
			equal(test.sink.ofType("turn.thought").length, expectedThoughtUpdates);
			ok(test.sink.ofType("turn.text").every((event) => event.payload.text.trim().length === 0));
			equal(test.sink.ofType("turn.tool").length, 0);
			equal(test.sink.ofType("turn.terminal").length, 1);
		} finally {
			await test.dispose();
		}
	});
}

for (const decision of ["allow_once", "reject_once"] as const) {
	Deno.test(`permission ${decision} is one-shot and bound to turn and challenge`, async () => {
		const test = await harness("permission");
		try {
			const context = await test.host.startTurn("Exercise mediated permission.");
			const permission = await waitForEvent(test.sink, "turn.permission.requested");
			const requestIndex = test.sink.events.indexOf(permission);
			for (
				const invalid of [
					{ turnId: "turn-stale", permissionId: permission.payload.permissionId },
					{ turnId: context.turnId, permissionId: "permission-stale" },
				]
			) {
				await rejects(
					test.host.resolvePermission(invalid.turnId, invalid.permissionId, decision),
					assertHostError("not-found"),
				);
			}
			await test.host.resolvePermission(context.turnId, permission.payload.permissionId, decision);
			await rejects(
				test.host.resolvePermission(context.turnId, permission.payload.permissionId, decision),
				assertHostError("not-found"),
			);
			const terminal = await waitForEvent(
				test.sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			equal(terminal.payload.outcome, "completed");
			const resolved = test.sink.ofType("turn.permission.resolved");
			equal(resolved.length, 1);
			equal(resolved[0]?.payload.decision, decision === "allow_once" ? "allow-once" : "reject");
			// The phase leaves `awaiting-approval` in the same step that publishes the
			// resolution, so nothing between the request and the resolution reports
			// `running`, and the very next event does.
			const resolvedIndex = test.sink.events.indexOf(resolved[0] as HostEvent);
			equal(
				test.sink.events
					.slice(requestIndex + 1, resolvedIndex)
					.filter((event) => event.type === "clio-coder.state" && event.snapshot.phase === "running").length,
				0,
			);
			const next = test.sink.events[resolvedIndex + 1];
			equal(next?.type, "clio-coder.state");
			equal(next?.type === "clio-coder.state" ? next.snapshot.phase : null, "running");
			const projection = JSON.stringify(test.sink.events);
			ok(!projection.includes("fixture-permission-1"));
			ok(!projection.includes("fixture-tool-1"));
			ok(!projection.includes(test.root));
		} finally {
			await test.dispose();
		}
	});
}

for (const scenario of ["permission", "permission-chain"] as const) {
	Deno.test(`${scenario} never publishes a snapshot whose phase contradicts its pending approval`, async () => {
		const test = await harness(scenario);
		try {
			const context = await test.host.startTurn("Hold the approval invariant.");
			let permission = await waitForEvent(test.sink, "turn.permission.requested");
			await test.host.resolvePermission(context.turnId, permission.payload.permissionId, "allow_once");
			if (scenario === "permission-chain") {
				permission = await waitForEvent(
					test.sink,
					"turn.permission.requested",
					(event) => event.payload.permissionId !== permission.payload.permissionId,
				);
				await test.host.resolvePermission(context.turnId, permission.payload.permissionId, "reject_once");
			}
			await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
			assertPhaseMatchesPendingApproval(test.sink);
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("an expired approval never publishes a snapshot that contradicts its pending approval", async () => {
	const test = await harness("permission", { permissionEscalateMs: 40, permissionBudgetMs: 120 });
	try {
		const context = await test.host.startTurn("Let this approval expire.");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		assertPhaseMatchesPendingApproval(test.sink);
	} finally {
		await test.dispose();
	}
});

Deno.test("a permission capability from a retired generation cannot settle the next session", async () => {
	const test = await harness("permission");
	try {
		const first = await test.host.startTurn("Cancel the first permission run.");
		const firstPermission = await waitForEvent(
			test.sink,
			"turn.permission.requested",
			(event) => event.context.turnId === first.turnId,
		);
		await test.host.cancelTurn(first.turnId);
		const firstTerminal = await waitForEvent(
			test.sink,
			"turn.terminal",
			(event) => event.context.turnId === first.turnId,
		);
		equal(firstTerminal.payload.outcome, "canceled");

		// A new session retires the child, so the next run is a different generation.
		await test.host.newSession();
		const second = await test.host.startTurn("Keep the second permission active.");
		// Turn ids restart per session, so the second run is identified by its generation.
		const secondPermission = await waitForEvent(
			test.sink,
			"turn.permission.requested",
			(event) => event.context.generation === second.generation,
		);
		ok(first.generation !== second.generation);
		ok(firstPermission.payload.permissionId !== secondPermission.payload.permissionId);

		await rejects(
			test.host.resolvePermission(second.turnId, firstPermission.payload.permissionId, "allow_once"),
			assertHostError("not-found"),
		);
		equal(test.host.phase, "awaiting-approval");
		equal(
			test.sink.ofType("turn.permission.resolved").filter((event) => event.context.generation === second.generation)
				.length,
			0,
		);
		equal(
			test.sink.ofType("turn.terminal").filter((event) => event.context.generation === second.generation).length,
			0,
		);

		await test.host.resolvePermission(second.turnId, secondPermission.payload.permissionId, "reject_once");
		const secondTerminal = await waitForEvent(
			test.sink,
			"turn.terminal",
			(event) => event.context.generation === second.generation,
		);
		equal(secondTerminal.payload.outcome, "completed");
		deepStrictEqual(test.launchedRoots, [test.root, test.root]);
	} finally {
		await test.dispose();
	}
});

Deno.test("an unanswered approval stops the turn without ever telling Clio Coder no", async () => {
	const test = await harness("permission", {
		permissionEscalateMs: 40,
		permissionBudgetMs: 120,
		callLog: true,
	});
	try {
		const context = await test.host.startTurn("Let this approval go unanswered.");
		const permission = await waitForEvent(test.sink, "turn.permission.requested");
		const resolved = await waitForEvent(
			test.sink,
			"turn.permission.resolved",
			(event) => event.payload.permissionId === permission.payload.permissionId,
		);
		equal(resolved.payload.decision, "unanswered");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "canceled");
		equal(terminal.payload.code, "approval-unanswered");
		ok(terminal.payload.summary.includes("Clio Coder was not told no"));
		await rejects(
			test.host.resolvePermission(context.turnId, permission.payload.permissionId, "allow_once"),
			assertHostError("not-found"),
		);
		// The child stays alive: the operator's next prompt continues the session.
		equal(test.host.boundSessionPublicId, context.sessionId);
		deepStrictEqual(test.launchedRoots, [test.root]);
	} finally {
		await test.dispose();
	}
});

Deno.test("approval stamps use the host clock while honoring the ACP expiry ceiling", async () => {
	const frozen = 1_000_000;
	const test = await harness("permission", {
		now: () => frozen,
		permissionEscalateMs: 45_000,
		permissionBudgetMs: 300_000,
	});
	try {
		const context = await test.host.startTurn("Stamp this approval on the injected clock.");
		const permission = await waitForEvent(test.sink, "turn.permission.requested");
		const requestedAt = Date.parse(permission.payload.requestedAt);
		equal(requestedAt, frozen);
		equal(Date.parse(permission.payload.escalateAt) - requestedAt, 45_000);
		const expiryBudget = Date.parse(permission.payload.expiresAt) - requestedAt;
		ok(expiryBudget > 50_000 && expiryBudget <= 60_000, `expected ACP-bounded expiry, received ${expiryBudget} ms`);
		await test.host.cancelTurn(context.turnId);
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("cancellation settles a parked turn, refreshes once, and leaves the child bound", async () => {
	const test = await harness("hang");
	try {
		const context = await test.host.startTurn("Park until canceled.");
		await waitForEvent(test.sink, "turn.thought", (event) => event.context.turnId === context.turnId);
		await test.host.cancelTurn(context.turnId);
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "canceled");
		equal(terminal.payload.code, "operator-cancelled");
		equal(test.sink.ofType("turn.terminal").filter((event) => event.context.turnId === context.turnId).length, 1);
		await waitFor(() => test.sink.refreshes.includes(test.host.project.projectId), "refresh after cancellation");
	} finally {
		await test.dispose();
	}
});

Deno.test("cancel keeps the session update window open through the permission tool sweep", async () => {
	const test = await harness("permission", { callLog: true });
	try {
		const context = await test.host.startTurn("Cancel while the permission request is parked.");
		await waitForEvent(test.sink, "turn.permission.requested", (event) => event.context.turnId === context.turnId);
		await test.host.cancelTurn(context.turnId);
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "canceled");
		equal(test.sink.ofType("turn.tool").filter((event) => event.payload.status === "failed").length, 1);
		ok(!test.sink.ofType("turn.terminal").some((event) => event.payload.code === "acp-protocol-failure"));
		await test.host.close();
		await waitForCallLog(test.callLogPath);
		const methods = await callMethods(test.callLogPath);
		const promptIndex = methods.indexOf("session/prompt");
		const closeIndex = methods.indexOf("session/close");
		ok(promptIndex >= 0);
		ok(closeIndex > promptIndex, "session/close must be sent only after the prompt settlement window");
	} finally {
		await test.dispose();
	}
});

Deno.test("cancellation rejects a later valid permission without projecting a second capability", async () => {
	const test = await harness("permission-late-after-cancel");
	try {
		const context = await test.host.startTurn("Reject any later permission after cancellation begins.");
		await waitForEvent(test.sink, "turn.permission.requested", (event) => event.context.turnId === context.turnId);
		const heldWrite = holdFirstWriterFrame('"id":"fixture-permission-1","result"');
		try {
			const cancellation = test.host.cancelTurn(context.turnId);
			await waitFor(() => heldWrite.held(), "held first permission settlement write");
			await waitForEvent(
				test.sink,
				"turn.thought",
				(event) =>
					event.context.turnId === context.turnId && event.payload.text.includes("Late cancellation permission"),
			);
			equal(test.sink.ofType("turn.permission.requested").length, 1);
			heldWrite.release();
			await cancellation;
		} finally {
			heldWrite.restore();
		}
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.code, "operator-cancelled");
		equal(test.sink.ofType("turn.tool").filter((event) => event.payload.status === "failed").length, 1);
	} finally {
		await test.dispose();
	}
});

Deno.test("a chained permission remains awaiting approval after the preceding decision settles", async () => {
	const test = await harness("permission-chain");
	try {
		const context = await test.host.startTurn("Request two bounded decisions.");
		const first = await waitForEvent(test.sink, "turn.permission.requested");
		const heldWrite = holdFirstWriterFrame('"id":"fixture-permission-1","result"');
		let second: EventOf<"turn.permission.requested">;
		try {
			const settlement = test.host.resolvePermission(context.turnId, first.payload.permissionId, "allow_once");
			await waitFor(() => heldWrite.held(), "held chained permission settlement write");
			second = await waitForEvent(
				test.sink,
				"turn.permission.requested",
				(event) => event.payload.permissionId !== first.payload.permissionId,
			);
			const secondIndex = test.sink.events.indexOf(second);
			heldWrite.release();
			await settlement;
			equal(test.host.phase, "awaiting-approval");
			equal(
				test.sink.events.slice(secondIndex + 1).filter((event) =>
					event.type === "clio-coder.state" && event.snapshot.phase === "running"
				).length,
				0,
			);
		} finally {
			heldWrite.restore();
		}
		await test.host.resolvePermission(context.turnId, second.payload.permissionId, "reject_once");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
	} finally {
		await test.dispose();
	}
});

for (const operation of ["resolvePermission", "cancelTurn", "abandon"] as const) {
	Deno.test(`${operation} is serialized behind an earlier close`, async () => {
		const test = await harness("permission");
		try {
			const context = await test.host.startTurn("Keep this permission behind the host queue.");
			const permission = await waitForEvent(test.sink, "turn.permission.requested");
			const closing = test.host.close();
			const controlled = operation === "resolvePermission"
				? test.host.resolvePermission(context.turnId, permission.payload.permissionId, "allow_once")
				: operation === "cancelTurn"
				? test.host.cancelTurn(context.turnId)
				: test.host.abandon();
			await closing;
			if (operation === "abandon") await controlled;
			else await rejects(controlled, assertHostError("not-found"));
			const terminal = await waitForEvent(
				test.sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			equal(terminal.payload.outcome, "canceled");
			equal(terminal.payload.code, "host-shutdown");
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("abandon rejects a parked permission as a disconnect and invalidates its capability", async () => {
	const test = await harness("permission");
	try {
		const context = await test.host.startTurn("Disconnect at permission.");
		const permission = await waitForEvent(test.sink, "turn.permission.requested");
		const requestIndex = test.sink.events.indexOf(permission);
		await test.host.abandon();
		const resolved = await waitForEvent(
			test.sink,
			"turn.permission.resolved",
			(event) => event.payload.permissionId === permission.payload.permissionId,
		);
		equal(resolved.payload.decision, "disconnect");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "canceled");
		equal(terminal.payload.code, "client-disconnected");
		equal(
			test.sink.events.slice(requestIndex + 1).filter((event) =>
				event.type === "clio-coder.state" && event.snapshot.phase === "running"
			).length,
			0,
		);
		await rejects(
			test.host.resolvePermission(context.turnId, permission.payload.permissionId, "allow_once"),
			assertHostError("not-found"),
		);
	} finally {
		await test.dispose();
	}
});

for (const joiner of ["abandon", "close"] as const) {
	Deno.test(`${joiner} joins a retirement another caller already started`, async () => {
		const test = await harness("hang");
		try {
			const context = await test.host.startTurn("Join owned retirement.");
			await waitForEvent(test.sink, "turn.started", (event) => event.context.turnId === context.turnId);
			const cancellation = test.host.cancelTurn(context.turnId);
			if (joiner === "abandon") await test.host.abandon();
			else await test.host.close();
			ok(test.sink.ofType("turn.terminal").some((event) => event.context.turnId === context.turnId));
			await cancellation;
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("project refresh cannot hold cleanup completion open", async () => {
	const test = await harness("hang", { sink: new NeverRefreshingSink() });
	try {
		const context = await test.host.startTurn("Do not await presentation refresh.");
		await waitForEvent(test.sink, "turn.started", (event) => event.context.turnId === context.turnId);
		const completed = await Promise.race([
			test.host.cancelTurn(context.turnId).then(() => true),
			delay(4_000).then(() => false),
		]);
		equal(completed, true);
		ok(test.sink.refreshes.includes(test.host.project.projectId));
	} finally {
		await test.dispose();
	}
});

Deno.test("a throwing sink cannot wedge the turn or the child", async () => {
	const test = await harness("happy", { sink: new RejectFirstTerminalSink() });
	try {
		const context = await test.host.startTurn("Totalize terminal projection.");
		await waitFor(() => test.host.activeTurnId === null, "turn settlement after a sink rejection");
		equal(test.host.phase, "idle");
		const next = await test.host.startTurn("The host still accepts the next prompt.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === next.turnId);
		equal(terminal.payload.outcome, "completed");
		equal(next.turnId, "turn-2");
		ok(context.turnId !== next.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("a timed-out prompt requests cancel-first retirement and never reports idle", async () => {
	const test = await harness("permission", { promptTimeoutMs: 1_000, callLog: true });
	try {
		const context = await test.host.startTurn("Time out this prompt.");
		await waitForEvent(test.sink, "turn.permission.requested", (event) => event.context.turnId === context.turnId);
		const started = test.sink.events.length;
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "failed");
		equal(terminal.payload.code, "acp-request-timeout");
		// The turn is swept closed, so the unfinished tool card settles as canceled.
		equal(test.sink.ofType("turn.tool").filter((event) => event.payload.status === "canceled").length, 1);
		await waitFor(() => test.host.phase === "failed", "failed phase after a prompt timeout");
		equal(
			test.sink.events.slice(started).filter((event) =>
				event.type === "clio-coder.state" && event.snapshot.phase === "idle"
			)
				.length,
			0,
		);
		await waitForCallLog(test.callLogPath);
		const methods = await callMethods(test.callLogPath);
		const promptIndex = methods.indexOf("session/prompt");
		const cancelIndex = methods.indexOf("session/cancel");
		ok(promptIndex >= 0);
		ok(cancelIndex > promptIndex, "a prompt timeout must request cancellation before EOF retirement");
	} finally {
		await test.dispose();
	}
});

Deno.test("a child that exits mid-turn fails the turn and never reports idle first", async () => {
	const test = await harness("exit-during-turn");
	try {
		const context = await test.host.startTurn("Exit during this turn.");
		const started = test.sink.events.length;
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "failed");
		await waitFor(() => test.host.phase === "failed", "failed phase after a child exit");
		equal(
			test.sink.events.slice(started).filter((event) =>
				event.type === "clio-coder.state" && event.snapshot.phase === "idle"
			)
				.length,
			0,
		);
		ok(!JSON.stringify(test.sink.events).includes("intentional during-turn exit"));
	} finally {
		await test.dispose();
	}
});

Deno.test("a retired child is replaced on the next command rather than leaving the project stuck", async () => {
	const test = await harness("exit-during-turn");
	try {
		const context = await test.host.startTurn("Exit during this turn.");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		await waitFor(() => test.host.phase === "failed", "failed phase after a child exit");
		await test.host.newSession();
		equal(test.host.phase, "idle");
		equal(test.launchedRoots.length, 2);
	} finally {
		await test.dispose();
	}
});

Deno.test("a child that resists SIGTERM is still retired by close", async () => {
	const test = await harness("resist-term");
	try {
		const context = await test.host.startTurn("Park and resist termination.");
		await waitForEvent(test.sink, "turn.thought", (event) => event.context.turnId === context.turnId);
		const closed = await Promise.race([
			test.host.close().then(() => true),
			delay(10_000).then(() => false),
		]);
		equal(closed, true);
		equal(test.host.phase, "closed");
	} finally {
		await test.dispose();
	}
});

Deno.test({
	name: "closing retires descendants inside the owned process group",
	ignore: Deno.build.os !== "linux",
	async fn() {
		const test = await harness("leader-exits-descendant");
		try {
			await test.host.close();
			// The fixture reports its descendant pid on stderr, which stays host-side;
			// the observable here is that close resolves and the host is closed with no
			// child left holding the project root.
			equal(test.host.phase, "closed");
			equal(test.host.generation, null);
		} finally {
			await test.dispose();
		}
	},
});

Deno.test("invalid prompts and stale capabilities are rejected before any side effect", async () => {
	const test = await harness("happy");
	try {
		const before = test.sink.events.length;
		for (const prompt of ["", " ".repeat(20), "x".repeat(8 * 1024 + 1)]) {
			await rejects(test.host.startTurn(prompt), assertHostError("invalid"));
		}
		await rejects(test.host.cancelTurn("turn-stale"), assertHostError("not-found"));
		await rejects(
			test.host.resolvePermission("turn-stale", "permission-stale", "allow_once"),
			assertHostError("not-found"),
		);
		equal(test.sink.events.length, before);
		deepStrictEqual(test.launchedRoots, [test.root]);
	} finally {
		await test.dispose();
	}
});

Deno.test("host construction rejects unbounded permission budgets", () => {
	const launcher = fixtureLauncher("happy").launcher;
	const sink = new RecordingSink();
	for (
		const options of [
			{ permissionBudgetMs: 0 },
			{ permissionBudgetMs: 1_800_001 },
			{ permissionEscalateMs: 0 },
			{ permissionEscalateMs: 600_001 },
			{ promptTimeoutMs: 0 },
		]
	) {
		let thrown: unknown = null;
		try {
			new ClioProjectHost({ launcher, project: project("project-bounds", "/tmp"), sink, ...options });
		} catch (error) {
			thrown = error;
		}
		ok(thrown instanceof HostError, `expected HostError for ${JSON.stringify(options)}`);
		equal(thrown.code, "invalid");
	}
});

Deno.test("the local launcher passes the trusted root and the permission ceiling to the child", () => {
	const launcher = createLocalClioLauncher({
		executable: "/usr/bin/clio-coder",
		permissionTimeoutMs: 1_800_000,
	});
	const launch = launcher.launch("/tmp/workbench-launcher-root");
	deepStrictEqual(launch.args.slice(-5), [
		"acp",
		"--cwd",
		"/tmp/workbench-launcher-root",
		"--permission-timeout",
		"1800000",
	]);
	equal(launch.cwd, "/tmp/workbench-launcher-root");
	ok((launch.redact ?? []).includes("/tmp/workbench-launcher-root"));
});

// ---------------------------------------------------------------- M2: continuity

Deno.test("one session serves three prompts and each one sees the ones before it", async () => {
	const test = await harness("conversation");
	try {
		const sessionId = test.host.boundSessionPublicId;
		ok(sessionId);
		const answers: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const context = await test.host.startTurn(`Prompt number ${index + 1}.`);
			equal(context.sessionId, sessionId);
			await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
			answers.push(
				test.sink.ofType("turn.text").filter((event) => event.context.turnId === context.turnId).map((event) =>
					event.payload.text
				).join(""),
			);
		}
		deepStrictEqual(answers, [
			"This session has seen 1 prompts.",
			"This session has seen 2 prompts.",
			"This session has seen 3 prompts.",
		]);
		deepStrictEqual(test.launchedRoots, [test.root]);
		equal(test.host.generation, test.host.generation);
	} finally {
		await test.dispose();
	}
});

Deno.test("a bound session carries the target, model, and autonomy Clio Coder attributed", async () => {
	const test = await harness("conversation");
	try {
		const snapshot = test.host.snapshot();
		deepStrictEqual(
			{
				target: snapshot.session?.target,
				model: snapshot.session?.model,
				autonomy: snapshot.session?.autonomy,
				autonomySource: snapshot.session?.autonomySource,
				resumed: snapshot.session?.resumed,
				replayedTurns: snapshot.session?.replayedTurns,
				replayTruncated: snapshot.session?.replayTruncated,
			},
			{
				target: "lmstudio",
				model: "qwen3.8-27b",
				autonomy: "auto-edit",
				autonomySource: "settings",
				resumed: false,
				replayedTurns: 0,
				replayTruncated: false,
			},
		);
		deepStrictEqual(snapshot.capabilities, {
			load: true,
			list: true,
			label: true,
			delete: true,
			autonomy: true,
			settings: false,
			targets: false,
			loopBlocked: true,
			dispatchEvents: false,
			agentAttribution: false,
		});
	} finally {
		await test.dispose();
	}
});

for (
	const scenario of [
		"session-attribution-missing",
		"session-attribution-field-missing",
		"session-attribution-session-mismatch",
		"session-attribution-resumed-mismatch",
	] as const
) {
	Deno.test(`${scenario} retires the child instead of fabricating a session binding`, async () => {
		const test = await harness(scenario, { bind: false });
		try {
			await test.host.open();
			await rejects(test.host.newSession(), assertHostError("not-ready"));
			equal(test.host.phase, "failed");
			equal(test.host.generation, null);
			equal(test.host.snapshot().session, null);
			equal(test.host.snapshot().lastFailure?.code, "acp-contract-failure");
			match(test.host.snapshot().lastFailure?.summary ?? "", /session|attribut/i);
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("a load result with false resumed attribution retires the child visibly", async () => {
	const test = await harness("resume-attribution-mismatch");
	try {
		await test.host.listSessions();
		const earlier = test.sink.ofType("session.list").at(-1)?.sessions.find((session) => !session.hosted);
		ok(earlier);
		await test.host.closeSession();
		await rejects(test.host.loadSession(earlier.id), assertHostError("not-ready"));
		equal(test.host.phase, "failed");
		equal(test.host.generation, null);
		equal(test.host.snapshot().session, null);
		deepStrictEqual(test.host.snapshot().lastFailure, {
			code: "acp-contract-failure",
			summary: "Clio Coder returned inconsistent session resume attribution.",
		});
	} finally {
		await test.dispose();
	}
});

Deno.test("the session list is a bounded projection with public identifiers only", async () => {
	const test = await harness("conversation");
	try {
		await test.host.listSessions();
		const listed = test.sink.ofType("session.list").at(-1);
		ok(listed);
		equal(listed.truncated, false);
		const hosted = listed.sessions.find((session) => session.hosted);
		const earlier = listed.sessions.find((session) => !session.hosted);
		ok(hosted);
		ok(earlier);
		equal(hosted.id, test.host.boundSessionPublicId);
		equal(hosted.state, "open");
		equal(hosted.target, "lmstudio");
		equal(hosted.model, "qwen3.8-27b");
		deepStrictEqual(
			{ label: earlier.label, preview: earlier.preview, turns: earlier.turns, state: earlier.state },
			{ label: "Earlier audit", preview: "Audit the convergence study", turns: 2, state: "closed" },
		);
		match(earlier.id, /^session-[0-9a-f-]{36}$/iu);
		const projection = JSON.stringify(listed);
		ok(!projection.includes("fixture-session-1"));
		ok(!projection.includes("fixture-session-earlier"));
	} finally {
		await test.dispose();
	}
});

Deno.test("labelling and deleting a session round-trip through the list, and the open one is refused", async () => {
	const test = await harness("conversation");
	try {
		await test.host.listSessions();
		const before = test.sink.ofType("session.list").at(-1);
		ok(before);
		const hostedId = test.host.boundSessionPublicId;
		ok(hostedId);
		const earlier = before.sessions.find((session) => !session.hosted);
		ok(earlier);

		await test.host.labelSession(earlier.id, "Renamed by the operator");
		const labelled = test.sink.ofType("session.list").at(-1);
		equal(labelled?.sessions.find((session) => session.id === earlier.id)?.label, "Renamed by the operator");

		await test.host.labelSession(earlier.id, "");
		equal(test.sink.ofType("session.list").at(-1)?.sessions.find((s) => s.id === earlier.id)?.label, null);

		await rejects(test.host.deleteSession(hostedId), assertHostError("refused"));
		await rejects(test.host.deleteSession("session-not-in-this-project"), assertHostError("not-found"));

		await test.host.deleteSession(earlier.id);
		const after = test.sink.ofType("session.list").at(-1);
		ok(after);
		deepStrictEqual(after.sessions.map((session) => session.id), [hostedId]);
	} finally {
		await test.dispose();
	}
});

for (const scenario of ["resume", "resume-truncated"] as const) {
	Deno.test(`${scenario} replays the branch as earlier turns before the load resolves`, async () => {
		const test = await harness(scenario);
		try {
			await test.host.listSessions();
			const listed = test.sink.ofType("session.list").at(-1);
			const earlier = listed?.sessions.find((session) => !session.hosted);
			ok(earlier);
			// Closing the live session frees the process for a load.
			await test.host.closeSession();
			test.sink.events.length = 0;
			await test.host.loadSession(earlier.id);

			const bound = test.host.snapshot().session;
			equal(bound?.id, earlier.id);
			equal(bound?.resumed, true);
			equal(bound?.replayedTurns, 2);
			equal(bound?.replayTruncated, scenario === "resume-truncated");

			const started = test.sink.ofType("turn.started");
			deepStrictEqual(started.map((event) => event.payload.origin), ["replay", "replay"]);
			deepStrictEqual(started.map((event) => event.payload.promptSummary), ["Earlier prompt 1", "Earlier prompt 2"]);
			deepStrictEqual(started.map((event) => event.context.turnId), ["turn-1", "turn-2"]);
			deepStrictEqual(started.map((event) => event.payload.startedAt), [null, null]);
			deepStrictEqual(started.map((event) => event.payload.source), ["replayed-from-clio", "replayed-from-clio"]);
			deepStrictEqual(
				test.sink.ofType("turn.text").map((event) => event.payload.text),
				["Earlier answer 1", "Earlier answer 2"],
			);
			ok(test.sink.ofType("turn.text").every((event) => event.payload.source === "replayed-from-clio"));
			deepStrictEqual(
				test.sink.ofType("turn.tool").map((event) => event.payload.status),
				["in_progress", "completed", "in_progress"],
			);
			ok(test.sink.ofType("turn.tool").every((event) => event.payload.source === "replayed-from-clio"));
			equal(test.sink.ofType("turn.terminal").length, 0);

			let projection: TurnProjection = emptyTurnProjection;
			for (const event of test.sink.events) {
				if (!event.type.startsWith("turn.")) continue;
				const turnEvent = event as Extract<HostEvent, { context: HostTurnContext }>;
				projection = applyTurnEvent(
					projection,
					{ kind: turnEvent.type, turnId: turnEvent.context.turnId, payload: turnEvent.payload } as TurnEventInput,
					new Date().toISOString(),
				);
			}
			equal(projection.timeline.length, 6);
			ok(projection.timeline.every((item) => item.startedAt === null));
			ok(projection.timeline.every((item) => item.source === "replayed-from-clio"));
			ok(projection.timeline.every((item) => item.kind !== "outcome" && item.kind !== "failure"));
			deepStrictEqual(
				projection.timeline.map((item) => item.status),
				["replayed", "replayed", "complete", "replayed", "replayed", "replayed"],
			);

			// A live prompt continues the session's numbering rather than restarting it.
			const live = await test.host.startTurn("Continue from the replayed branch.");
			equal(live.turnId, "turn-3");
			const liveStarted = await waitForEvent(
				test.sink,
				"turn.started",
				(event) => event.context.turnId === "turn-3",
			);
			equal(liveStarted.payload.origin, "live");
			await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === "turn-3");
			ok(!JSON.stringify(test.sink.events).includes("fixture-session-earlier"));
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("session replay accepts exactly 64 turn groups", async () => {
	const test = await harness("resume-64-turns");
	try {
		await test.host.listSessions();
		const earlier = test.sink.ofType("session.list").at(-1)?.sessions.find((session) => !session.hosted);
		ok(earlier);
		await test.host.closeSession();
		test.sink.events.length = 0;
		await test.host.loadSession(earlier.id);
		equal(test.host.snapshot().session?.replayedTurns, 64);
		equal(test.sink.ofType("turn.started").length, 64);
		ok(test.sink.ofType("turn.started").every((event) => event.payload.startedAt === null));
		equal(test.sink.ofType("turn.terminal").length, 0);
	} finally {
		await test.dispose();
	}
});

Deno.test("session replay rejects the 65th turn group", async () => {
	const test = await harness("resume-65-turns");
	try {
		await test.host.listSessions();
		const earlier = test.sink.ofType("session.list").at(-1)?.sessions.find((session) => !session.hosted);
		ok(earlier);
		await test.host.closeSession();
		test.sink.events.length = 0;
		await rejects(test.host.loadSession(earlier.id), assertHostError("not-ready"));
		await waitFor(() => test.host.phase === "failed", "host to fail after replay group overflow");
		equal(test.host.snapshot().session, null);
		equal(test.host.snapshot().lastFailure?.code, "acp-protocol-failure");
		equal(test.sink.ofType("turn.started").length, 64);
		equal(test.sink.ofType("turn.terminal").length, 0);
	} finally {
		await test.dispose();
	}
});

for (const [scenario, accepted] of [["resume-8192-tools", true], ["resume-8193-tools", false]] as const) {
	Deno.test(`${scenario} exercises the replay tool-start ceiling`, async () => {
		const test = await harness(scenario);
		try {
			await test.host.listSessions();
			const earlier = test.sink.ofType("session.list").at(-1)?.sessions.find((session) => !session.hosted);
			ok(earlier);
			await test.host.closeSession();
			test.sink.events.length = 0;
			const loading = test.host.loadSession(earlier.id);
			if (accepted) await loading;
			else await rejects(loading, assertHostError("not-ready"));
			const starts = test.sink.ofType("turn.tool").filter((event) => event.payload.status === "in_progress");
			equal(starts.length, 8_192);
			equal(new Set(starts.map((event) => event.payload.toolCallId)).size, 8_192);
			ok(starts.every((event) => event.payload.source === "replayed-from-clio"));
			if (accepted) {
				equal(test.host.phase, "idle");
				equal(test.host.snapshot().session?.replayedTurns, 1);
				equal(test.host.snapshot().session?.replayTruncated, true);
				equal(
					test.sink.ofType("turn.started").at(0)?.payload.promptSummary,
					"Retained prompt after the dropped oldest group",
				);
			} else {
				await waitFor(() => test.host.phase === "failed", "host to fail after replay tool overflow");
				equal(test.host.snapshot().session, null);
				equal(test.host.snapshot().lastFailure?.code, "acp-protocol-failure");
			}
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("resuming an unknown session is refused and leaves the process usable", async () => {
	const test = await harness("conversation");
	try {
		await rejects(test.host.loadSession("session-never-listed"), assertHostError("not-found"));
		equal(test.host.phase, "idle");
		const context = await test.host.startTurn("The process still works.");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("max turn requests projects exactly 128 tool starts and suppresses the 129th", async () => {
	const test = await harness("max-turn-requests");
	try {
		const context = await test.host.startTurn("Exhaust the per-turn request budget.");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		const starts = test.sink.ofType("turn.tool").filter((event) =>
			event.context.turnId === context.turnId && event.payload.status === "in_progress"
		);
		const swept = test.sink.ofType("turn.tool").filter((event) =>
			event.context.turnId === context.turnId && event.payload.status === "failed"
		);
		equal(starts.length, 128);
		equal(new Set(starts.map((event) => event.payload.toolCallId)).size, 128);
		equal(swept.length, 128);
		deepStrictEqual(
			new Set(swept.map((event) => event.payload.toolCallId)),
			new Set(starts.map((event) => event.payload.toolCallId)),
		);
		equal(test.sink.ofType("turn.tool").filter((event) => event.payload.status === "completed").length, 0);
		equal(test.sink.ofType("turn.tool").filter((event) => event.payload.status === "canceled").length, 0);
		ok(!starts.some((event) => event.payload.summary.includes("129")));
		ok(test.sink.events.indexOf(swept.at(-1)!) < test.sink.events.indexOf(terminal));
		deepStrictEqual(
			{
				outcome: terminal.payload.outcome,
				code: terminal.payload.code,
				stopReason: terminal.payload.stopReason,
				source: terminal.payload.source,
			},
			{
				outcome: "failed",
				code: "clio-coder-max_turn_requests",
				stopReason: "max_turn_requests",
				source: "reported-by-clio",
			},
		);
		ok(terminal.payload.summary.includes("max turn requests"));
		// The session survives, so the operator can simply send the next prompt.
		equal(test.host.boundSessionPublicId, context.sessionId);
		equal(test.host.phase, "idle");
	} finally {
		await test.dispose();
	}
});

Deno.test("closing a session retires its child and leaves the project ready for a new one", async () => {
	const test = await harness("conversation");
	try {
		const first = test.host.boundSessionPublicId;
		await test.host.closeSession();
		equal(test.host.boundSessionPublicId, null);
		equal(test.host.phase, "unbound");
		await test.host.newSession();
		const second = test.host.boundSessionPublicId;
		ok(second);
		equal(second, first, "the fixture reuses one session id, so the public id must be stable");
		// Closing a session retires the child and spawns its replacement; binding a
		// new session on that fresh, unbound process does not spawn again.
		equal(test.launchedRoots.length, 2);
	} finally {
		await test.dispose();
	}
});

Deno.test("a session list shortened by the server's byte budget is reported as truncated", async () => {
	const test = await harness("resume-truncated");
	try {
		await test.host.listSessions();
		const listed = test.sink.ofType("session.list").at(-1);
		ok(listed);
		// The fixture reports the budget signal in `_meta`, not the count flag.
		equal(listed.truncated, true);
		ok(listed.sessions.length > 0);
	} finally {
		await test.dispose();
	}
});

Deno.test("a permission ceiling shorter than the escalation budget escalates immediately", async () => {
	const logs: string[] = [];
	const root = await Deno.makeTempDir({ prefix: "workbench-host-escalation-" });
	const sink = new RecordingSink();
	const host = new ClioProjectHost({
		launcher: fixtureLauncher("permission").launcher,
		project: project("project-escalation", root),
		sink,
		acpTiming: { ...fastTiming, permissionTimeoutMs: 2_000 },
		permissionEscalateMs: 45_000,
		permissionBudgetMs: 600_000,
		log: (message) => logs.push(message),
	});
	try {
		await host.open();
		await host.newSession();
		const context = await host.startTurn("Raise an approval under a short ceiling.");
		const permission = await waitForEvent(sink, "turn.permission.requested");
		equal(Date.parse(permission.payload.escalateAt), Date.parse(permission.payload.requestedAt));
		ok(Date.parse(permission.payload.escalateAt) < Date.parse(permission.payload.expiresAt));
		equal(logs.length, 1);
		ok(logs[0]?.includes("escalated this approval immediately"));
		ok(!logs[0]?.includes(root));
		await host.cancelTurn(context.turnId);
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
	} finally {
		await host.close().catch(() => undefined);
		await Deno.remove(root, { recursive: true }).catch(() => undefined);
	}
});

Deno.test("an already-past permission ceiling is cancelled without publishing an invalid card", async () => {
	const logs: string[] = [];
	const root = await Deno.makeTempDir({ prefix: "workbench-host-expired-permission-" });
	const sink = new RecordingSink();
	const frozen = 1_000_000;
	const host = new ClioProjectHost({
		launcher: fixtureLauncher("permission").launcher,
		project: project("project-expired-permission", root),
		sink,
		acpTiming: { ...fastTiming, permissionTimeoutMs: 5 },
		now: () => {
			const deadline = performance.now() + 50;
			while (performance.now() < deadline) {
				// Ensure the ACP wall-clock ceiling passes before the host projects it.
			}
			return frozen;
		},
		permissionEscalateMs: 45_000,
		permissionBudgetMs: 300_000,
		log: (message) => logs.push(message),
	});
	try {
		await host.open();
		await host.newSession();
		const context = await host.startTurn("Handle an approval whose client ceiling has passed.");
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "canceled");
		equal(terminal.payload.code, "approval-unanswered");
		equal(sink.ofType("turn.permission.requested").length, 0);
		equal(logs.length, 1);
		ok(logs[0]?.includes("permission ceiling had already passed"));
		ok(!logs[0]?.includes(root));
	} finally {
		await host.close().catch(() => undefined);
		await Deno.remove(root, { recursive: true }).catch(() => undefined);
	}
});

Deno.test("settings and targets prime into one bounded projection with truthful options", async () => {
	const test = await harness("settings");
	try {
		await test.host.primeSettings();
		const settings = test.sink.ofType("settings.state").at(-1);
		const targets = test.sink.ofType("targets.state").at(-1);
		ok(settings);
		ok(targets);
		deepStrictEqual(settings.settings.settings, {
			"orchestrator.target": "lmstudio",
			"orchestrator.model": "qwen3.8-27b",
			"orchestrator.thinkingLevel": "off",
			autonomy: "auto-edit",
		});
		deepStrictEqual([...settings.settings.editable].sort(), [
			"autonomy",
			"orchestrator.model",
			"orchestrator.target",
			"orchestrator.thinkingLevel",
		]);
		// The model options are the selected target's models, not every model Clio Coder knows.
		deepStrictEqual(settings.settings.options["orchestrator.target"], ["lmstudio", "offline-lab"]);
		deepStrictEqual(settings.settings.options["orchestrator.model"], ["qwen3.8-27b", "qwen3.8-4b"]);
		deepStrictEqual(settings.settings.options.autonomy, ["read-only", "suggest", "auto-edit", "full-auto"]);
		equal(targets.truncated, false);
		deepStrictEqual(targets.targets.map((target) => target.id), ["lmstudio", "offline-lab"]);
		// No health is claimed before a probe happens.
		deepStrictEqual(targets.targets.map((target) => target.health), [null, null]);
		equal(targets.targets[0]?.isOrchestrator, true);
		equal(targets.targets[1]?.isOrchestrator, false);
	} finally {
		await test.dispose();
	}
});

for (
	const scenario of ["settings-invalid-thinking", "settings-invalid-autonomy", "settings-invalid-editable"] as const
) {
	Deno.test(`${scenario} is rejected without a settings projection`, async () => {
		const test = await harness(scenario);
		try {
			await rejects(test.host.getSettings(), assertHostError("internal"));
			equal(test.host.settings, null);
			equal(test.sink.ofType("settings.state").length, 0);
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("an invalid settings patch result does not replace the last validated projection", async () => {
	const test = await harness("settings-invalid-patch-result");
	try {
		await test.host.getSettings();
		const before = test.host.settings;
		ok(before);
		await rejects(test.host.patchSettings({ "orchestrator.model": "qwen3.8-4b" }), assertHostError("internal"));
		deepStrictEqual(test.host.settings, before);
		equal(test.sink.ofType("settings.state").length, 1);
	} finally {
		await test.dispose();
	}
});

Deno.test("a target without a boolean orchestrator role is rejected whole", async () => {
	const test = await harness("targets-invalid-orchestrator");
	try {
		await rejects(test.host.listTargets(), assertHostError("internal"));
		equal(test.host.targets, null);
		equal(test.sink.ofType("targets.state").length, 0);
	} finally {
		await test.dispose();
	}
});

for (const scenario of ["probe-target-mismatch", "probe-latency-invalid"] as const) {
	Deno.test(`${scenario} is rejected without attaching health to the requested target`, async () => {
		const test = await harness(scenario);
		try {
			await test.host.primeSettings();
			await rejects(test.host.probeTarget("lmstudio"), assertHostError("internal"));
			equal(test.sink.ofType("targets.probed").length, 0);
			equal(test.host.targets?.find((target) => target.id === "lmstudio")?.health, null);
		} finally {
			await test.dispose();
		}
	});
}

for (const scenario of ["sessions-missing-preview", "sessions-invalid-hosted"] as const) {
	Deno.test(`${scenario} fails the initial session list instead of creating local facts`, async () => {
		const test = await harness(scenario, { bind: false });
		try {
			await rejects(test.host.open(), assertHostError("not-ready"));
			equal(test.host.phase, "failed");
			deepStrictEqual(test.host.snapshot().lastFailure, {
				code: "acp-contract-failure",
				summary: scenario === "sessions-missing-preview"
					? "Clio Coder omitted session field preview."
					: "Clio Coder returned invalid session presentation fields.",
			});
		} finally {
			await test.dispose();
		}
	});
}

Deno.test("the session list preserves the server hosted boolean without inference", async () => {
	const test = await harness("sessions-hosted-false");
	try {
		await test.host.listSessions();
		const listed = test.sink.ofType("session.list").at(-1);
		ok(listed);
		ok(listed.sessions.length > 0);
		equal(listed.sessions.some((session) => session.hosted), false);
	} finally {
		await test.dispose();
	}
});

Deno.test("an unknown autonomy source is rejected without changing the bound session", async () => {
	const test = await harness("autonomy-source-invalid");
	try {
		const before = test.host.snapshot().session;
		ok(before);
		await rejects(test.host.setAutonomy("read-only"), assertHostError("internal"));
		deepStrictEqual(test.host.snapshot().session, before);
	} finally {
		await test.dispose();
	}
});

Deno.test("a shortened target list is reported rather than presented as complete", async () => {
	const test = await harness("settings-truncated");
	try {
		await test.host.listTargets();
		const targets = test.sink.ofType("targets.state").at(-1);
		ok(targets);
		equal(targets.truncated, true);
		equal(test.host.targetsTruncated, true);
	} finally {
		await test.dispose();
	}
});

Deno.test("a safe settings patch round-trips and an unknown target is refused whole", async () => {
	const test = await harness("settings");
	try {
		await test.host.primeSettings();
		await test.host.patchSettings({ "orchestrator.model": "qwen3.8-4b", "orchestrator.thinkingLevel": "medium" });
		const patched = test.sink.ofType("settings.state").at(-1);
		ok(patched);
		equal(patched.settings.settings["orchestrator.model"], "qwen3.8-4b");
		equal(patched.settings.settings["orchestrator.thinkingLevel"], "medium");

		// An unknown target must not leave a half-written projection behind.
		await rejects(test.host.patchSettings({ "orchestrator.target": "not-a-target" }));
		await test.host.getSettings();
		const afterFailure = test.sink.ofType("settings.state").at(-1);
		ok(afterFailure);
		equal(afterFailure.settings.settings["orchestrator.target"], "lmstudio");
		equal(afterFailure.settings.settings["orchestrator.model"], "qwen3.8-4b");

		// Workbench refuses a key outside the closed set before it reaches Clio Coder.
		await rejects(
			test.host.patchSettings({ "provider.apiKey": "secret" }),
			assertHostError("invalid"),
		);
	} finally {
		await test.dispose();
	}
});

Deno.test("a target's health is reported only for the target that was probed", async () => {
	const test = await harness("settings");
	try {
		await test.host.primeSettings();
		await test.host.probeTarget("lmstudio");
		const healthy = test.sink.ofType("targets.probed").at(-1);
		ok(healthy);
		equal(healthy.targetId, "lmstudio");
		equal(healthy.health.healthy, true);
		equal(healthy.health.latencyMs, 12);
		equal(healthy.health.reason, null);
		ok(healthy.health.probedAt.endsWith("Z"));
		const afterFirst = test.sink.ofType("targets.state").at(-1);
		ok(afterFirst);
		equal(afterFirst.targets.find((target) => target.id === "offline-lab")?.health, null);

		await test.host.probeTarget("offline-lab");
		const unhealthy = test.sink.ofType("targets.probed").at(-1);
		ok(unhealthy);
		equal(unhealthy.targetId, "offline-lab");
		equal(unhealthy.health.healthy, false);
		equal(unhealthy.health.latencyMs, null);
		equal(unhealthy.health.reason, "not-configured");

		await rejects(test.host.probeTarget("absent"), assertHostError("not-found"));
	} finally {
		await test.dispose();
	}
});

Deno.test("autonomy set over ACP is what the next prompt runs under", async () => {
	const test = await harness("settings");
	try {
		await test.host.primeSettings();
		equal(test.host.snapshot().session?.autonomy, "auto-edit");
		equal(test.host.snapshot().session?.autonomySource, "settings");

		await test.host.setAutonomy("read-only");
		const snapshot = test.host.snapshot();
		equal(snapshot.session?.autonomy, "read-only");
		equal(snapshot.session?.autonomySource, "session");

		const context = await test.host.startTurn("What autonomy is in force?");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		const answer = test.sink.ofType("turn.text").filter((event) => event.context.turnId === context.turnId)
			.map((event) => event.payload.text).join("");
		equal(answer, "This session has seen 1 prompts at autonomy read-only.");

		// A global settings patch must not silently rebind the session's autonomy.
		await test.host.patchSettings({ autonomy: "full-auto" });
		equal(test.host.snapshot().session?.autonomy, "read-only");
		equal(test.host.snapshot().session?.autonomySource, "session");
	} finally {
		await test.dispose();
	}
});

Deno.test("a Clio Coder without the settings and targets capabilities refuses rather than pretends", async () => {
	const test = await harness("conversation");
	try {
		const capabilities = test.host.snapshot().capabilities;
		ok(capabilities);
		deepStrictEqual(
			{ settings: capabilities.settings, targets: capabilities.targets },
			{ settings: false, targets: false },
		);
		await rejects(test.host.getSettings(), assertHostError("unsupported"));
		await rejects(test.host.listTargets(), assertHostError("unsupported"));
		await rejects(test.host.patchSettings({ autonomy: "suggest" }), assertHostError("unsupported"));
		await rejects(test.host.probeTarget("lmstudio"), assertHostError("unsupported"));
		// Priming is best effort and must leave both projections absent, not empty.
		await test.host.primeSettings();
		equal(test.host.settings, null);
		equal(test.host.targets, null);
	} finally {
		await test.dispose();
	}
});

/**
 * Answers approvals one at a time in arrival order. `waitForEvent` returns the
 * first matching event, so the predicate has to name the card that has not been
 * answered yet rather than count the answers so far.
 */
async function answerApprovals(
	test: Harness,
	turnId: string,
	count: number,
	decide: (index: number) => "allow_once" | "reject_once",
): Promise<string[]> {
	const answered = new Set<string>();
	const titles: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const permission = await waitForEvent(
			test.sink,
			"turn.permission.requested",
			(event) => !answered.has(event.payload.permissionId),
		);
		answered.add(permission.payload.permissionId);
		titles.push(permission.payload.title);
		await test.host.resolvePermission(turnId, permission.payload.permissionId, decide(index));
	}
	return titles;
}

Deno.test("seventeen mediated bash calls project as seventeen tool cards with no narration", async () => {
	const test = await harness("seventeen-bash", { permissionEscalateMs: 30_000, permissionBudgetMs: 60_000 });
	try {
		const capabilities = test.host.snapshot().capabilities;
		ok(capabilities);
		equal(capabilities.loopBlocked, true, "the fixture must advertise the event the host opted into");

		const context = await test.host.startTurn("Audit the convergence study.");
		const titles = await answerApprovals(test, context.turnId, 17, () => "allow_once");
		equal(titles.length, 17);
		ok(titles.every((title) => title.startsWith("bash: ")));

		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "completed");

		const starts = test.sink.ofType("turn.tool").filter((event) => event.payload.status === "in_progress");
		equal(starts.length, 17);
		// The defect being reproduced is silence: the model said nothing at all.
		equal(test.sink.ofType("turn.text").length, 0);
		equal(test.sink.ofType("turn.thought").length, 0);
	} finally {
		await test.dispose();
	}
});

Deno.test("a repeated command shape is reported by Clio Coder rather than detected in the client", async () => {
	const test = await harness("seventeen-bash", { permissionEscalateMs: 30_000, permissionBudgetMs: 60_000 });
	try {
		const context = await test.host.startTurn("Audit the convergence study.");
		// The third git log candidate is blocked before it becomes a tool call.
		await answerApprovals(test, context.turnId, 4, () => "allow_once");
		const loop = await waitForEvent(test.sink, "turn.loop");
		equal(loop.payload.tool, "bash");
		equal(loop.payload.repeatCount, 3);
		equal(loop.payload.budget, 8);
		equal(loop.payload.disposition, "block");
		equal(loop.payload.interrupted, false);
		// The envelope carries no shape string, so the GUI can never render one.
		equal(loop.payload.shape, null);
		equal(loop.payload.toolCallId, null);
		equal(loop.payload.source, "reported-by-clio");
		const starts = test.sink.ofType("turn.tool").filter((event) => event.payload.status === "in_progress");
		equal(starts.some((event) => event.payload.summary === "bash: git log --all --stat"), false);
		const fourthStart = starts[3];
		ok(fourthStart);
		ok(test.sink.events.indexOf(loop) < test.sink.events.indexOf(fourthStart));
		await test.host.cancelTurn(context.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("an advertised event surface that stays quiet produces no loop cards", async () => {
	const test = await harness("seventeen-bash-quiet", { permissionEscalateMs: 30_000, permissionBudgetMs: 60_000 });
	try {
		const capabilities = test.host.snapshot().capabilities;
		ok(capabilities);
		equal(capabilities.loopBlocked, true);

		const context = await test.host.startTurn("Audit the convergence study.");
		await answerApprovals(test, context.turnId, 5, () => "allow_once");
		// The same command shapes repeated, and without the opt-in nothing is claimed.
		equal(test.sink.ofType("turn.loop").length, 0);
		const starts = test.sink.ofType("turn.tool").filter((event) => event.payload.status === "in_progress");
		ok(starts.length >= 5);
		await test.host.cancelTurn(context.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("a rejected bash call is retried under a rephrased title rather than abandoned", async () => {
	const test = await harness("seventeen-bash", { permissionEscalateMs: 30_000, permissionBudgetMs: 60_000 });
	try {
		const context = await test.host.startTurn("Audit the convergence study.");
		const titles = await answerApprovals(
			test,
			context.turnId,
			2,
			(index) => index === 0 ? "reject_once" : "allow_once",
		);
		const [first, second] = titles;
		ok(first);
		ok(second);
		// Rephrased, not repeated verbatim, and not moved on to a different command.
		ok(second !== first, "a denied call must come back reworded");
		equal(second.split(" ").slice(1, 3).join(" "), first.split(" ").slice(1, 3).join(" "));
		await test.host.cancelTurn(context.turnId);
	} finally {
		await test.dispose();
	}
});

Deno.test("an approval that expires mid-run never reaches Clio Coder as a rejection", async () => {
	const test = await harness("seventeen-bash", {
		permissionEscalateMs: 40,
		permissionBudgetMs: 160,
		permissionLog: true,
	});
	try {
		const context = await test.host.startTurn("Audit the convergence study.");
		const permission = await waitForEvent(test.sink, "turn.permission.requested");
		const resolved = await waitForEvent(
			test.sink,
			"turn.permission.resolved",
			(event) => event.payload.permissionId === permission.payload.permissionId,
		);
		equal(resolved.payload.decision, "unanswered");
		const terminal = await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.payload.outcome, "canceled");
		equal(terminal.payload.code, "approval-unanswered");
		match(terminal.payload.summary, /Clio Coder was not told no/u);

		// The whole point of parking rather than denying: the child never saw a no,
		// so it has no denial to reformulate around.
		await test.host.close();
		await waitForCallLog(test.permissionLogPath);
		const answers = JSON.parse(await Deno.readTextFile(test.permissionLogPath)) as Array<{ result?: unknown }>;
		const selected = answers.filter((answer) => {
			const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
			return outcome?.outcome === "selected";
		});
		deepStrictEqual(selected, [], "an expiry must never send an option id of any kind");
		ok(
			answers.every((answer) => JSON.stringify(answer).includes("reject-once") === false),
			"the fixture must never have recorded a rejection",
		);
	} finally {
		await test.dispose();
	}
});

Deno.test("dispatch lifecycle facts become fleet rows and survive the turn that started them", async () => {
	const test = await harness("dispatch-fleet");
	try {
		const capabilities = test.host.snapshot().capabilities;
		ok(capabilities);
		equal(capabilities.dispatchEvents, true);
		equal(capabilities.agentAttribution, true);

		const context = await test.host.startTurn("Audit the convergence study.");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		// The detached run settles after the prompt returned, so the row for it
		// arrives on the session rather than on the turn.
		const failed = await waitForEvent(test.sink, "fleet.activity", (event) => event.payload.run.runId === "run-2");
		equal(failed.payload.run.state, "failed");
		equal(failed.payload.run.outcome, "timed_out");
		equal(failed.payload.run.agentId, "reviewer");
		equal(failed.payload.source, "reported-by-clio");

		const first = test.sink.ofType("fleet.activity").filter((event) => event.payload.run.runId === "run-1");
		deepStrictEqual(first.map((event) => event.payload.run.state), ["queued", "running", "progress", "done"]);
		const settledRun = first.at(-1)?.payload.run;
		ok(settledRun);
		equal(settledRun.agentId, "explorer");
		equal(settledRun.node, "blade");
		equal(settledRun.attempt, 0);
		equal(settledRun.progressCount, 4);
		equal(settledRun.progressTruncated, false);
		equal(settledRun.outcome, "succeeded");
		equal(settledRun.durationMs, 1_200);
		equal(settledRun.tokenCount, 640);
		equal(settledRun.taskPreview, "Audit the convergence study");

		// The host keeps the runs, so a browser that reloads mid-flight is handed
		// the same rows rather than an empty strip.
		deepStrictEqual(test.host.fleet.map((run) => [run.runId, run.state]), [["run-1", "done"], ["run-2", "failed"]]);
	} finally {
		await test.dispose();
	}
});

Deno.test("a tool call that spawned a worker is attributed to it, and the rest to the orchestrator", async () => {
	const test = await harness("dispatch-fleet");
	try {
		const context = await test.host.startTurn("Audit the convergence study.");
		await waitForEvent(test.sink, "turn.terminal", (event) => event.context.turnId === context.turnId);

		const tools = test.sink.ofType("turn.tool");
		deepStrictEqual(tools.map((event) => event.payload.status), ["in_progress", "in_progress", "completed"]);
		deepStrictEqual(tools[0]?.payload.agents, [{
			role: "orchestrator",
			agentId: "orchestrator",
			runId: null,
			node: null,
		}]);
		const worker = { role: "worker", agentId: "explorer", runId: "run-1", node: "blade" };
		for (const event of tools.slice(1)) {
			deepStrictEqual(event.payload.agents, [
				{ role: "orchestrator", agentId: "orchestrator", runId: null, node: null },
				worker,
			]);
		}
		const narrative = test.sink.ofType("turn.text");
		ok(narrative.length > 0);
		for (const event of narrative) {
			deepStrictEqual(event.payload.agents, [{
				role: "orchestrator",
				agentId: "orchestrator",
				runId: null,
				node: null,
			}], "the main narrative is the orchestrator's, and the GUI is told so rather than assuming it");
		}
	} finally {
		await test.dispose();
	}
});

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpClientTiming, AcpLaunchSpec } from "../acp-client.ts";
import {
	type ClioLauncher,
	createLocalClioLauncher,
	EngineCoordinator,
	EngineError,
	type EngineEvent,
	type EngineProject,
	type EngineSink,
} from "../engine.ts";

const fixturePath = fileURLToPath(new URL("./acp-child-fixture.ts", import.meta.url));

const fastTiming: AcpClientTiming = {
	permissionTimeoutMs: 1_000,
	writeTimeoutMs: 500,
	cancelGraceMs: 300,
	closeTimeoutMs: 300,
	exitGraceMs: 300,
	termGraceMs: 150,
	killObservationMs: 1_500,
};

type MatchingEvent<E, T extends EngineEvent["type"]> = E extends { type: infer K }
	? T extends K ? E & { type: T } : never
	: never;
type EventOf<T extends EngineEvent["type"]> = MatchingEvent<EngineEvent, T>;

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

class NeverRefreshingSink extends RecordingSink {
	override refreshProject(projectId: string): Promise<void> {
		this.refreshes.push(projectId);
		return new Promise(() => undefined);
	}
}

class RejectFirstTerminalSink extends RecordingSink {
	#rejected = false;

	override emit(event: EngineEvent): void {
		if (event.type === "turn.terminal" && !this.#rejected) {
			this.#rejected = true;
			throw new Error("fixture terminal sink rejection");
		}
		super.emit(event);
	}
}

interface FixtureLauncherHarness {
	readonly launcher: ClioLauncher;
	readonly probedRoots: string[];
	readonly launchedRoots: string[];
}

function fixtureLaunch(root: string, scenario: string, callLogPath?: string): AcpLaunchSpec {
	return {
		command: Deno.execPath(),
		args: [
			"run",
			"--quiet",
			"--no-config",
			...(callLogPath === undefined ? [] : [`--allow-write=${callLogPath}`]),
			fixturePath,
			`--scenario=${scenario}`,
			...(callLogPath === undefined ? [] : [`--call-log=${callLogPath}`]),
		],
		cwd: root,
		clearEnv: true,
		terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
		redact: [root],
	};
}

function fixtureLauncher(scenario: string, callLogPath?: string): FixtureLauncherHarness {
	const probedRoots: string[] = [];
	const launchedRoots: string[] = [];
	return {
		probedRoots,
		launchedRoots,
		launcher: {
			probe(trustedRoot) {
				probedRoots.push(trustedRoot);
				return Promise.resolve({ version: "clio-coder fixture-0.0.0" });
			},
			launch(trustedRoot) {
				launchedRoots.push(trustedRoot);
				return fixtureLaunch(trustedRoot, scenario, callLogPath);
			},
		},
	};
}

function project(projectId: string, trustedRoot: string): EngineProject {
	return { projectId, trustedRoot, displayName: `Project ${projectId}` };
}

function coordinator(launcher: ClioLauncher): EngineCoordinator {
	return new EngineCoordinator({ launcher, eventDelayMs: 2, acpTiming: fastTiming });
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

async function waitFor(
	predicate: () => boolean,
	description: string,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
		await delay(5);
	}
}

async function waitForEvent<T extends EngineEvent["type"]>(
	sink: RecordingSink,
	type: T,
	predicate: (event: EventOf<T>) => boolean = () => true,
	timeoutMs = 3_000,
): Promise<EventOf<T>> {
	await waitFor(() => sink.ofType(type).some(predicate), `${type} event`, timeoutMs);
	const event = sink.ofType(type).find(predicate);
	ok(event);
	return event;
}

function assertEngineError(code: EngineError["code"]): (error: unknown) => boolean {
	return (error: unknown): boolean => {
		ok(error instanceof EngineError, `expected EngineError, received ${String(error)}`);
		equal(error.code, code);
		return true;
	};
}

async function prepareReal(
	engine: EngineCoordinator,
	sink: RecordingSink,
	selectedProject: EngineProject,
): Promise<void> {
	engine.select(sink, selectedProject, "clio-acp");
	await engine.probe(sink, selectedProject);
	equal(engine.snapshot(selectedProject.projectId).phase, "ready");
}

Deno.test("projects default independently to the ready deterministic engine", async () => {
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	try {
		const first = engine.snapshot("project-a");
		const second = engine.snapshot("project-b");
		equal(first.kind, "fake");
		equal(first.phase, "ready");
		equal(second.kind, "fake");
		equal(second.phase, "ready");
		equal(first.facts.find((fact) => fact.key === "provider")?.state, "unavailable");
		equal(first.facts.find((fact) => fact.key === "provider")?.source, "simulated-by-workbench");
		equal(harness.probedRoots.length, 0);
		equal(harness.launchedRoots.length, 0);
	} finally {
		await engine.close();
	}
});

Deno.test("Clio selection is unprobed until an explicit project-bound readiness check succeeds", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-probe-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-probe", root);
	try {
		engine.select(sink, selectedProject, "clio-acp");
		equal(engine.snapshot(selectedProject.projectId).phase, "unprobed");
		await engine.probe(sink, selectedProject);
		const ready = engine.snapshot(selectedProject.projectId);
		equal(ready.kind, "clio-acp");
		equal(ready.phase, "ready");
		deepStrictEqual(harness.probedRoots, [root]);
		equal(harness.launchedRoots.length, 0);
		equal(ready.facts.find((fact) => fact.key === "runtime")?.detail, "clio-coder fixture-0.0.0");
		for (const key of ["target", "authentication", "provider", "context"] as const) {
			equal(ready.facts.find((fact) => fact.key === key)?.state, "unavailable");
		}
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a failed readiness probe publishes only unavailable facts and never launches ACP", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-probe-failure-" });
	let launchCalls = 0;
	const launcher: ClioLauncher = {
		probe: () => Promise.reject(new Error("probe secret /private/clio/settings.json")),
		launch: () => {
			launchCalls += 1;
			throw new Error("ACP launch must remain unreachable after failed readiness");
		},
	};
	const engine = coordinator(launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-probe-failure", root);
	try {
		engine.select(sink, selectedProject, "clio-acp");
		await rejects(engine.probe(sink, selectedProject), assertEngineError("not-ready"));
		equal(engine.snapshot(selectedProject.projectId).phase, "unavailable");
		await rejects(
			engine.start({ owner: sink, project: selectedProject, prompt: "Do not launch after failed readiness." }),
			assertEngineError("not-ready"),
		);
		equal(launchCalls, 0);
		equal(sink.ofType("turn.started").length, 0);
		equal(sink.ofType("turn.terminal").length, 0);
		ok(!JSON.stringify(sink.events).includes("/private/clio/settings.json"));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("the local readiness launcher invokes only --version and acp --help", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-local-probe-" });
	const scriptPath = join(root, "probe-fixture.ts");
	const logPath = join(root, "probe-calls.ndjson");
	await Deno.writeTextFile(
		scriptPath,
		`const log = Deno.env.get("WORKBENCH_PROBE_LOG");
if (log === undefined) Deno.exit(91);
await Deno.writeTextFile(log, JSON.stringify(Deno.args) + "\\n", { append: true });
if (Deno.args.length === 1 && Deno.args[0] === "--version") console.log("clio-coder 0.3.2");
else if (Deno.args.length === 2 && Deno.args[0] === "acp" && Deno.args[1] === "--help") {
  console.log("clio-coder acp [--cwd PATH] [--permission-timeout MS]\\n\\nServe Clio Coder as an Agent Client Protocol v1 agent over stdio.");
} else Deno.exit(92);
`,
	);
	const launcher = createLocalClioLauncher({
		executable: Deno.execPath(),
		prefixArgs: [
			"run",
			"--quiet",
			"--no-config",
			`--allow-env=WORKBENCH_PROBE_LOG`,
			`--allow-write=${logPath}`,
			scriptPath,
		],
		env: { WORKBENCH_PROBE_LOG: logPath },
		clearEnv: true,
		permissionTimeoutMs: 1_234,
		probeTimeoutMs: 2_000,
	});
	try {
		deepStrictEqual(await launcher.probe(root), { version: "clio-coder 0.3.2" });
		const calls = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
		deepStrictEqual(calls, [["--version"], ["acp", "--help"]]);
		const launch = launcher.launch(root);
		deepStrictEqual(launch.args.slice(-5), ["acp", "--cwd", root, "--permission-timeout", "1234"]);
		equal(launch.cwd, root);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("the local readiness launcher rejects help that does not name the ACP subcommand", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-local-probe-no-acp-" });
	const scriptPath = join(root, "probe-no-acp-fixture.ts");
	await Deno.writeTextFile(
		scriptPath,
		`if (Deno.args.length === 1 && Deno.args[0] === "--version") console.log("clio-coder 0.3.2");
else if (Deno.args.length === 2 && Deno.args[0] === "acp" && Deno.args[1] === "--help") {
  console.log("clio-coder [command] [options]");
} else Deno.exit(92);
`,
	);
	const launcher = createLocalClioLauncher({
		executable: Deno.execPath(),
		prefixArgs: ["run", "--quiet", "--no-config", scriptPath],
		clearEnv: true,
		probeTimeoutMs: 2_000,
	});
	try {
		await rejects(launcher.probe(root), assertEngineError("not-ready"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test({
	name: "Linux readiness probes retire descendants in their owned process group after a successful probe",
	ignore: Deno.build.os !== "linux",
	async fn() {
		const root = await Deno.makeTempDir({ prefix: "workbench-engine-probe-descendant-" });
		const scriptPath = join(root, "probe-descendant-fixture.ts");
		const pidPath = join(root, "probe-descendant.pid");
		let descendantPid: number | null = null;
		await Deno.writeTextFile(
			scriptPath,
			`const pidPath = Deno.env.get("WORKBENCH_PROBE_DESCENDANT_PID");
if (pidPath === undefined) Deno.exit(91);
if (Deno.args.length === 1 && Deno.args[0] === "--version") {
  const descendant = new Deno.Command("/usr/bin/sleep", {
    args: ["30"], stdin: "null", stdout: "null", stderr: "null"
  }).spawn();
  await Deno.writeTextFile(pidPath, String(descendant.pid));
  await Deno.stdout.write(new TextEncoder().encode("clio-coder 0.3.2\\n"));
  Deno.exit(0);
} else if (Deno.args.length === 2 && Deno.args[0] === "acp" && Deno.args[1] === "--help") {
  console.log("clio-coder acp [--cwd PATH] [--permission-timeout MS]\\n\\nServe Clio Coder as an Agent Client Protocol v1 agent over stdio.");
} else Deno.exit(92);
`,
		);
		const launcher = createLocalClioLauncher({
			executable: Deno.execPath(),
			prefixArgs: [
				"run",
				"--quiet",
				"--no-config",
				"--allow-run=/usr/bin/sleep",
				"--allow-env=WORKBENCH_PROBE_DESCENDANT_PID",
				`--allow-write=${pidPath}`,
				scriptPath,
			],
			env: { WORKBENCH_PROBE_DESCENDANT_PID: pidPath },
			clearEnv: true,
			probeTimeoutMs: 2_000,
		});
		try {
			deepStrictEqual(await launcher.probe(root), { version: "clio-coder 0.3.2" });
			descendantPid = Number(await Deno.readTextFile(pidPath));
			ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
			const descendantProbe = await new Deno.Command("kill", {
				args: ["-s", "0", String(descendantPid)],
				stdin: "null",
				stdout: "null",
				stderr: "null",
			}).output();
			equal(descendantProbe.success, false);
		} finally {
			if (descendantPid !== null) {
				try {
					Deno.kill(descendantPid, "SIGKILL");
				} catch {
					// The owned probe cleanup should already have retired it.
				}
			}
			await Deno.remove(root, { recursive: true });
		}
	},
});

for (const scenario of ["complete", "failure"] as const) {
	Deno.test(`fake ${scenario} remains mediated and reaches one deterministic terminal event`, async () => {
		const root = await Deno.makeTempDir({ prefix: `workbench-engine-fake-${scenario}-` });
		const harness = fixtureLauncher("happy");
		const engine = coordinator(harness.launcher);
		const sink = new RecordingSink();
		const selectedProject = project(`project-fake-${scenario}`, root);
		try {
			const context = await engine.start({
				owner: sink,
				project: selectedProject,
				prompt: "Inspect the bounded deterministic evidence.",
				fakeScenario: scenario,
			});
			const permission = await waitForEvent(sink, "turn.permission.requested");
			equal(permission.context.turnId, context.turnId);
			await engine.resolvePermission({
				owner: sink,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
				permissionId: permission.permissionId,
				decision: "allow_once",
			});
			const terminal = await waitForEvent(sink, "turn.terminal");
			equal(terminal.context.turnId, context.turnId);
			equal(terminal.outcome, scenario === "complete" ? "completed" : "failed");
			equal(sink.ofType("turn.terminal").length, 1);
			ok(sink.ofType("turn.agent").some((event) => event.status === "complete" || event.status === "failed"));
			equal(harness.launchedRoots.length, 0);
			await waitFor(() => sink.refreshes.includes(selectedProject.projectId), "fake project refresh");
		} finally {
			await engine.close();
			await Deno.remove(root, { recursive: true });
		}
	});
}

Deno.test("fake rejection and direct cancellation both fail closed and release the global slot", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-fake-stop-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-fake-stop", root);
	try {
		const rejected = await engine.start({ owner: sink, project: selectedProject, prompt: "Reject this fake turn." });
		const permission = await waitForEvent(sink, "turn.permission.requested");
		await engine.resolvePermission({
			owner: sink,
			projectId: selectedProject.projectId,
			turnId: rejected.turnId,
			permissionId: permission.permissionId,
			decision: "reject_once",
		});
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === rejected.turnId);

		const canceled = await engine.start({ owner: sink, project: selectedProject, prompt: "Cancel this fake turn." });
		await engine.cancel({ owner: sink, projectId: selectedProject.projectId, turnId: canceled.turnId });
		const terminal = await waitForEvent(
			sink,
			"turn.terminal",
			(event) => event.context.turnId === canceled.turnId,
		);
		equal(terminal.outcome, "canceled");
		equal(sink.ofType("turn.terminal").filter((event) => event.context.turnId === canceled.turnId).length, 1);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("fake permission expiry resolves as timeout, invalidates the challenge, and releases the global slot", async () => {
	const firstRoot = await Deno.makeTempDir({ prefix: "workbench-engine-fake-timeout-a-" });
	const secondRoot = await Deno.makeTempDir({ prefix: "workbench-engine-fake-timeout-b-" });
	const harness = fixtureLauncher("happy");
	const engine = new EngineCoordinator({
		launcher: harness.launcher,
		eventDelayMs: 1,
		acpTiming: { ...fastTiming, permissionTimeoutMs: 25 },
	});
	const sink = new RecordingSink();
	const firstProject = project("project-fake-timeout-a", firstRoot);
	const secondProject = project("project-fake-timeout-b", secondRoot);
	try {
		const context = await engine.start({ owner: sink, project: firstProject, prompt: "Let this permission expire." });
		const permission = await waitForEvent(sink, "turn.permission.requested");
		const resolved = await waitForEvent(
			sink,
			"turn.permission.resolved",
			(event) => event.permissionId === permission.permissionId,
		);
		equal(resolved.decision, "timeout");
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "canceled");
		equal(terminal.code, "permission-timeout");
		await rejects(
			engine.resolvePermission({
				owner: sink,
				projectId: firstProject.projectId,
				turnId: context.turnId,
				permissionId: permission.permissionId,
				decision: "allow_once",
			}),
			assertEngineError("not-found"),
		);

		const next = await engine.start({ owner: sink, project: secondProject, prompt: "Use the released slot." });
		await engine.cancel({ owner: sink, projectId: secondProject.projectId, turnId: next.turnId });
	} finally {
		await engine.close();
		await Deno.remove(firstRoot, { recursive: true });
		await Deno.remove(secondRoot, { recursive: true });
	}
});

Deno.test("a fake decision delivered at its deadline expires synchronously before it can be granted", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-fake-late-decision-" });
	const harness = fixtureLauncher("happy");
	let now = Date.now();
	const engine = new EngineCoordinator({
		launcher: harness.launcher,
		eventDelayMs: 1,
		acpTiming: fastTiming,
		now: () => now,
	});
	const sink = new RecordingSink();
	const selectedProject = project("project-fake-late-decision", root);
	try {
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Reject stale authority." });
		const permission = await waitForEvent(sink, "turn.permission.requested");
		now = Date.parse(permission.expiresAt);
		await rejects(
			engine.resolvePermission({
				owner: sink,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
				permissionId: permission.permissionId,
				decision: "allow_once",
			}),
			assertEngineError("not-found"),
		);
		const resolved = await waitForEvent(sink, "turn.permission.resolved");
		equal(resolved.decision, "timeout");
		const terminal = await waitForEvent(sink, "turn.terminal");
		equal(terminal.code, "permission-timeout");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("one global engine slot blocks cross-project starts and engine switching", async () => {
	const firstRoot = await Deno.makeTempDir({ prefix: "workbench-engine-slot-a-" });
	const secondRoot = await Deno.makeTempDir({ prefix: "workbench-engine-slot-b-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const firstProject = project("project-slot-a", firstRoot);
	const secondProject = project("project-slot-b", secondRoot);
	try {
		const active = await engine.start({ owner: sink, project: firstProject, prompt: "Hold the global slot." });
		await rejects(
			engine.start({ owner: sink, project: secondProject, prompt: "Compete for the global slot." }),
			assertEngineError("conflict"),
		);
		await rejects(
			Promise.resolve().then(() => engine.select(sink, firstProject, "clio-acp")),
			assertEngineError("conflict"),
		);
		await engine.cancel({ owner: sink, projectId: firstProject.projectId, turnId: active.turnId });
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === active.turnId);
		const next = await engine.start({ owner: sink, project: secondProject, prompt: "Use the released slot." });
		await engine.cancel({ owner: sink, projectId: secondProject.projectId, turnId: next.turnId });
	} finally {
		await engine.close();
		await Deno.remove(firstRoot, { recursive: true });
		await Deno.remove(secondRoot, { recursive: true });
	}
});

Deno.test("a real turn uses one trusted-root ACP lifecycle and exposes only safe surrogates", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-happy-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-real-happy", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Run the real ACP fixture." });
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "completed");
		equal(terminal.stopReason, "end_turn");
		deepStrictEqual(terminal.usage, { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 });
		deepStrictEqual(harness.probedRoots, [root]);
		deepStrictEqual(harness.launchedRoots, [root]);
		ok(sink.ofType("turn.text").length >= 1);
		ok(sink.ofType("turn.thought").length >= 1);
		deepStrictEqual(sink.ofType("turn.tool").map((event) => event.status), ["in_progress", "completed"]);
		ok(
			sink.ofType("turn.tool").every((event) =>
				event.locations.length === 1 && event.locations[0]?.length === 1 && event.locations[0][0] === "notes.txt"
			),
		);
		await waitFor(() => sink.refreshes.includes(selectedProject.projectId), "real project refresh");

		const rendererProjection = JSON.stringify(sink.events);
		for (
			const secret of [root, "fixture-session-1", "fixture-tool-1", "fixture-permission-1", "rawInput", "rawOutput"]
		) {
			ok(!rendererProjection.includes(secret), `renderer projection leaked ${secret}`);
		}
		match(context.sessionId, /^session-clio-/);
		match(context.turnId, /^turn-clio-/);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("outside-root ACP locations are dropped as untrusted presentation without failing the turn", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-outside-location-" });
	const harness = fixtureLauncher("outside-location");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-outside-location", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Treat reported locations as presentation only.",
		});
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "completed");
		const tools = sink.ofType("turn.tool").filter((event) => event.context.turnId === context.turnId);
		deepStrictEqual(tools.map((event) => event.locations), [[], []]);
		ok(!JSON.stringify(sink.events).includes("outside.txt"));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

for (
	const scenario of [
		"initialize-version-invalid",
		"initialize-capabilities-missing",
		"initialize-capabilities-unsupported",
	] as const
) {
	Deno.test(`${scenario} fails before session creation with one safe public terminal`, async () => {
		const root = await Deno.makeTempDir({ prefix: `workbench-engine-${scenario}-` });
		const callLogPath = join(root, "acp-calls.json");
		const harness = fixtureLauncher(scenario, callLogPath);
		const engine = coordinator(harness.launcher);
		const sink = new RecordingSink();
		const selectedProject = project(`project-${scenario}`, root);
		try {
			await prepareReal(engine, sink, selectedProject);
			const context = await engine.start({
				owner: sink,
				project: selectedProject,
				prompt: "Reject an incompatible ACP initialize contract.",
			});
			const terminal = await waitForEvent(
				sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			deepStrictEqual(
				{ outcome: terminal.outcome, code: terminal.code, summary: terminal.summary, source: terminal.source },
				{
					outcome: "failed",
					code: "acp-contract-failure",
					summary: "Clio did not satisfy the bounded Workbench integration contract.",
					source: "observed-by-workbench",
				},
			);
			const calls = JSON.parse(await Deno.readTextFile(callLogPath)) as Array<{ method?: unknown }>;
			deepStrictEqual(calls.map((call) => call.method), ["initialize"]);
			equal(sink.ofType("turn.started").length, 0);
			equal(sink.ofType("turn.text").length, 0);
			equal(sink.ofType("turn.tool").length, 0);
			ok(!JSON.stringify(sink.events).includes(root));
		} finally {
			await engine.close();
			await Deno.remove(root, { recursive: true });
		}
	});
}

Deno.test("allowlisted protocol metadata maps across the JSON-RPC layer and reports only numeric versions", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-remote-protocol-version-" });
	const harness = fixtureLauncher("remote-error-protocol-version");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-remote-protocol-version", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Project only allowlisted protocol metadata.",
		});
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		deepStrictEqual(
			{ outcome: terminal.outcome, code: terminal.code, summary: terminal.summary, source: terminal.source },
			{
				outcome: "failed",
				code: "clio-protocol-version-unsupported",
				summary: "Clio does not support the ACP protocol version required by Workbench. Supported versions: 1.",
				source: "reported-by-clio",
			},
		);
		ok(!JSON.stringify(sink.events).includes("unsupported protocol version"));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("real streamed text redacts a trusted root split across ACP chunks", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-root-redaction-" });
	const harness = fixtureLauncher("project-root-split");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-root-redaction", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Report the project note." });
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		const text = sink.ofType("turn.text").map((event) => event.text).join("");
		equal(text, "Observed [project]/notes.txt");
		ok(!JSON.stringify(sink.events).includes(root));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("real readiness is bound to the exact trusted root that was probed", async () => {
	const firstRoot = await Deno.makeTempDir({ prefix: "workbench-engine-bound-a-" });
	const secondRoot = await Deno.makeTempDir({ prefix: "workbench-engine-bound-b-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const original = project("project-root-bound", firstRoot);
	try {
		await prepareReal(engine, sink, original);
		await rejects(
			engine.start({
				owner: sink,
				project: { ...original, trustedRoot: secondRoot },
				prompt: "This root was never probed.",
			}),
			assertEngineError("not-ready"),
		);
		deepStrictEqual(harness.launchedRoots, []);
	} finally {
		await engine.close();
		await Deno.remove(firstRoot, { recursive: true });
		await Deno.remove(secondRoot, { recursive: true });
	}
});

Deno.test("a forged ACP session update fails closed before renderer projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-forged-session-" });
	const harness = fixtureLauncher("forged-session-update");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-session-boundary", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		await engine.start({ owner: sink, project: selectedProject, prompt: "Reject the forged session update." });
		const terminal = await waitForEvent(sink, "turn.terminal");
		equal(terminal.outcome, "failed");
		equal(terminal.code, "acp-protocol-failure");
		equal(sink.ofType("turn.text").length, 0);
		const projection = JSON.stringify(sink.events);
		ok(!projection.includes("raw-attacker-session-93841"));
		ok(!projection.includes("owned-session"));
		ok(!projection.includes("must-not-render"));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a cumulative ACP update flood fails closed before the over-limit update reaches projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-update-flood-" });
	const harness = fixtureLauncher("update-flood");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-update-flood", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Bound the update stream." });
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "failed");
		equal(terminal.code, "workbench-update-budget-exceeded");
		equal(terminal.source, "observed-by-workbench");
		const projection = JSON.stringify(sink.events);
		ok(!projection.includes("must-not-render-update-overflow"));
		ok(!projection.includes("acp-protocol-failure"));
		equal(sink.ofType("turn.text").length, 0);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a cumulative ACP stream budget stops renderer projection without mislabeling the peer protocol", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-stream-budget-" });
	const harness = fixtureLauncher("stream-budget");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-stream-budget", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Bound the text stream." });
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		deepStrictEqual(
			{ outcome: terminal.outcome, code: terminal.code, source: terminal.source },
			{
				outcome: "failed",
				code: "workbench-stream-budget-exceeded",
				source: "observed-by-workbench",
			},
		);
		const projection = JSON.stringify(sink.events);
		ok(!projection.includes("must-not-render-stream-budget-overflow"));
		ok(!projection.includes("acp-protocol-failure"));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
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
		const root = await Deno.makeTempDir({ prefix: `workbench-engine-${scenario}-` });
		const harness = fixtureLauncher(scenario);
		const engine = coordinator(harness.launcher);
		const sink = new RecordingSink();
		const selectedProject = project(`project-${scenario}`, root);
		try {
			await prepareReal(engine, sink, selectedProject);
			const context = await engine.start({
				owner: sink,
				project: selectedProject,
				prompt: "Reject a turn without a substantive projected answer.",
			});
			const terminal = await waitForEvent(
				sink,
				"turn.terminal",
				(event) => event.context.turnId === context.turnId,
			);
			deepStrictEqual(
				{ outcome: terminal.outcome, code: terminal.code, stopReason: terminal.stopReason },
				{ outcome: "failed", code: "empty-turn", stopReason: "end_turn" },
			);
			const textUpdates = sink.ofType("turn.text").filter((event) => event.context.turnId === context.turnId);
			const thoughtUpdates = sink.ofType("turn.thought").filter((event) => event.context.turnId === context.turnId);
			equal(textUpdates.length, expectedTextUpdates);
			equal(thoughtUpdates.length, expectedThoughtUpdates);
			ok(textUpdates.every((event) => event.text.trim().length === 0));
			equal(sink.ofType("turn.tool").filter((event) => event.context.turnId === context.turnId).length, 0);
			equal(sink.ofType("turn.terminal").filter((event) => event.context.turnId === context.turnId).length, 1);
		} finally {
			await engine.close();
			await Deno.remove(root, { recursive: true });
		}
	});
}

for (const decision of ["allow_once", "reject_once"] as const) {
	Deno.test(`real permission ${decision} is one-shot and bound to owner, project, turn, and challenge`, async () => {
		const root = await Deno.makeTempDir({ prefix: `workbench-engine-real-${decision}-` });
		const harness = fixtureLauncher("permission");
		const engine = coordinator(harness.launcher);
		const owner = new RecordingSink();
		const stranger = new RecordingSink();
		const selectedProject = project(`project-real-${decision}`, root);
		try {
			await prepareReal(engine, owner, selectedProject);
			const context = await engine.start({ owner, project: selectedProject, prompt: "Exercise mediated permission." });
			const permission = await waitForEvent(owner, "turn.permission.requested");
			const permissionEventIndex = owner.events.indexOf(permission);
			for (
				const invalid of [
					{
						owner: stranger,
						projectId: selectedProject.projectId,
						turnId: context.turnId,
						permissionId: permission.permissionId,
					},
					{ owner, projectId: "project-other", turnId: context.turnId, permissionId: permission.permissionId },
					{ owner, projectId: selectedProject.projectId, turnId: "turn-stale", permissionId: permission.permissionId },
					{ owner, projectId: selectedProject.projectId, turnId: context.turnId, permissionId: "permission-stale" },
				]
			) {
				await rejects(
					engine.resolvePermission({ ...invalid, decision }),
					assertEngineError("not-found"),
				);
			}
			await engine.resolvePermission({
				owner,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
				permissionId: permission.permissionId,
				decision,
			});
			await rejects(
				engine.resolvePermission({
					owner,
					projectId: selectedProject.projectId,
					turnId: context.turnId,
					permissionId: permission.permissionId,
					decision,
				}),
				assertEngineError("not-found"),
			);
			const terminal = await waitForEvent(owner, "turn.terminal", (event) => event.context.turnId === context.turnId);
			equal(terminal.outcome, "completed");
			const resolved = owner.ofType("turn.permission.resolved");
			equal(resolved.length, 1);
			equal(resolved[0]?.decision, decision);
			equal(
				owner.events.slice(permissionEventIndex + 1).filter((event) =>
					event.type === "engine.state" && event.snapshot.phase === "running"
				).length,
				1,
			);
			const projection = JSON.stringify(owner.events);
			ok(!projection.includes("fixture-permission-1"));
			ok(!projection.includes("fixture-tool-1"));
			ok(!projection.includes(root));
		} finally {
			await engine.close();
			await Deno.remove(root, { recursive: true });
		}
	});
}

Deno.test("a permission capability from a retired ACP generation cannot settle the next run", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-stale-permission-generation-" });
	const harness = fixtureLauncher("permission");
	const engine = coordinator(harness.launcher);
	const owner = new RecordingSink();
	const selectedProject = project("project-real-stale-permission-generation", root);
	try {
		await prepareReal(engine, owner, selectedProject);
		const first = await engine.start({ owner, project: selectedProject, prompt: "Cancel the first permission run." });
		const firstPermission = await waitForEvent(
			owner,
			"turn.permission.requested",
			(event) => event.context.turnId === first.turnId,
		);
		await engine.cancel({ owner, projectId: selectedProject.projectId, turnId: first.turnId });
		const firstTerminal = await waitForEvent(
			owner,
			"turn.terminal",
			(event) => event.context.turnId === first.turnId,
		);
		equal(firstTerminal.outcome, "canceled");

		const second = await engine.start({
			owner,
			project: selectedProject,
			prompt: "Keep the second permission active.",
		});
		const secondPermission = await waitForEvent(
			owner,
			"turn.permission.requested",
			(event) => event.context.turnId === second.turnId,
		);
		ok(first.generation !== second.generation);
		ok(firstPermission.permissionId !== secondPermission.permissionId);

		await rejects(
			engine.resolvePermission({
				owner,
				projectId: selectedProject.projectId,
				turnId: second.turnId,
				permissionId: firstPermission.permissionId,
				decision: "allow_once",
			}),
			assertEngineError("not-found"),
		);
		equal(engine.snapshot(selectedProject.projectId).phase, "awaiting-approval");
		equal(
			owner.ofType("turn.permission.resolved").filter((event) => event.context.turnId === second.turnId).length,
			0,
		);
		equal(owner.ofType("turn.terminal").filter((event) => event.context.turnId === second.turnId).length, 0);

		await engine.resolvePermission({
			owner,
			projectId: selectedProject.projectId,
			turnId: second.turnId,
			permissionId: secondPermission.permissionId,
			decision: "reject_once",
		});
		const secondTerminal = await waitForEvent(
			owner,
			"turn.terminal",
			(event) => event.context.turnId === second.turnId,
		);
		equal(secondTerminal.outcome, "completed");
		deepStrictEqual(
			owner.ofType("turn.permission.resolved")
				.filter((event) => event.context.turnId === second.turnId)
				.map((event) => ({ permissionId: event.permissionId, decision: event.decision })),
			[{ permissionId: secondPermission.permissionId, decision: "reject_once" }],
		);
		deepStrictEqual(harness.launchedRoots, [root, root]);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a real permission decision delivered at its deadline is rejected on the wire as a timeout", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-late-decision-" });
	const harness = fixtureLauncher("permission");
	let now = Date.now();
	const engine = new EngineCoordinator({
		launcher: harness.launcher,
		eventDelayMs: 2,
		acpTiming: fastTiming,
		now: () => now,
	});
	const sink = new RecordingSink();
	const selectedProject = project("project-real-late-decision", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Reject stale authority." });
		const permission = await waitForEvent(sink, "turn.permission.requested");
		now = Date.parse(permission.expiresAt);
		await rejects(
			engine.resolvePermission({
				owner: sink,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
				permissionId: permission.permissionId,
				decision: "allow_once",
			}),
			assertEngineError("not-found"),
		);
		const resolved = await waitForEvent(
			sink,
			"turn.permission.resolved",
			(event) => event.permissionId === permission.permissionId,
		);
		equal(resolved.decision, "timeout");
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "completed");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("real cancellation settles a parked turn, refreshes once, and releases the slot", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-cancel-" });
	const harness = fixtureLauncher("hang");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-real-cancel", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Park until canceled." });
		await waitForEvent(sink, "turn.thought", (event) => event.context.turnId === context.turnId);
		await engine.cancel({ owner: sink, projectId: selectedProject.projectId, turnId: context.turnId });
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "canceled");
		equal(sink.ofType("turn.terminal").filter((event) => event.context.turnId === context.turnId).length, 1);
		await waitFor(() => sink.refreshes.includes(selectedProject.projectId), "refresh after cancellation");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("cancel keeps the owned session update window open through the permission tool sweep", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-permission-cancel-sweep-" });
	const callLogPath = join(root, "acp-calls.json");
	const harness = fixtureLauncher("permission", callLogPath);
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-permission-cancel-sweep", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Cancel while the exact permission request is parked.",
		});
		await waitForEvent(
			sink,
			"turn.permission.requested",
			(event) => event.context.turnId === context.turnId,
		);
		await engine.cancel({ owner: sink, projectId: selectedProject.projectId, turnId: context.turnId });
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "canceled");
		const tools = sink.ofType("turn.tool").filter((event) => event.context.turnId === context.turnId);
		equal(tools.filter((event) => event.status === "failed").length, 1);
		ok(!sink.ofType("turn.terminal").some((event) => event.code === "acp-protocol-failure"));

		const calls = JSON.parse(await Deno.readTextFile(callLogPath)) as Array<{ method?: unknown }>;
		const methods = calls.map((call) => call.method);
		const promptIndex = methods.indexOf("session/prompt");
		const closeIndex = methods.indexOf("session/close");
		ok(promptIndex >= 0);
		ok(closeIndex > promptIndex, "session/close must be sent only after the prompt settlement window");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("cancellation rejects a later valid permission without projecting a second capability", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-permission-late-cancel-" });
	const harness = fixtureLauncher("permission-late-after-cancel");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-permission-late-cancel", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Reject any later permission after cancellation begins.",
		});
		await waitForEvent(sink, "turn.permission.requested", (event) => event.context.turnId === context.turnId);
		const heldWrite = holdFirstWriterFrame('"id":"fixture-permission-1","result"');
		try {
			const cancellation = engine.cancel({
				owner: sink,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
			});
			await waitFor(() => heldWrite.held(), "held first permission settlement write");
			await waitForEvent(
				sink,
				"turn.thought",
				(event) => event.context.turnId === context.turnId && event.text.includes("Late cancellation permission"),
			);
			const permissions = sink.ofType("turn.permission.requested").filter((event) =>
				event.context.turnId === context.turnId
			);
			equal(permissions.length, 1);
			heldWrite.release();
			await cancellation;
		} finally {
			heldWrite.restore();
		}
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.code, "operator-cancelled");
		equal(
			sink.ofType("turn.tool").filter((event) => event.context.turnId === context.turnId && event.status === "failed")
				.length,
			1,
		);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a chained permission remains awaiting approval after the preceding decision settles", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-permission-chain-" });
	const harness = fixtureLauncher("permission-chain");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-permission-chain", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Request two bounded decisions.",
		});
		const first = await waitForEvent(
			sink,
			"turn.permission.requested",
			(event) => event.context.turnId === context.turnId,
		);
		const heldWrite = holdFirstWriterFrame('"id":"fixture-permission-1","result"');
		let second: EventOf<"turn.permission.requested">;
		try {
			const firstSettlement = engine.resolvePermission({
				owner: sink,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
				permissionId: first.permissionId,
				decision: "allow_once",
			});
			await waitFor(() => heldWrite.held(), "held chained permission settlement write");
			second = await waitForEvent(
				sink,
				"turn.permission.requested",
				(event) => event.context.turnId === context.turnId && event.permissionId !== first.permissionId,
			);
			const secondIndex = sink.events.indexOf(second);
			heldWrite.release();
			await firstSettlement;
			equal(engine.snapshot(selectedProject.projectId).phase, "awaiting-approval");
			equal(
				sink.events.slice(secondIndex + 1).filter((event) =>
					event.type === "engine.state" && event.snapshot.phase === "running"
				).length,
				0,
			);
		} finally {
			heldWrite.restore();
		}
		await engine.resolvePermission({
			owner: sink,
			projectId: selectedProject.projectId,
			turnId: context.turnId,
			permissionId: second.permissionId,
			decision: "reject_once",
		});
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("disconnect rejects a parked permission and invalidates its public capability", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-disconnect-" });
	const harness = fixtureLauncher("permission");
	const engine = coordinator(harness.launcher);
	const owner = new RecordingSink();
	const selectedProject = project("project-real-disconnect", root);
	try {
		await prepareReal(engine, owner, selectedProject);
		const context = await engine.start({ owner, project: selectedProject, prompt: "Disconnect at permission." });
		const permission = await waitForEvent(owner, "turn.permission.requested");
		const permissionEventIndex = owner.events.indexOf(permission);
		await engine.disconnect(owner);
		const resolved = await waitForEvent(
			owner,
			"turn.permission.resolved",
			(event) => event.permissionId === permission.permissionId,
		);
		equal(resolved.decision, "disconnect");
		const terminal = await waitForEvent(owner, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "canceled");
		equal(
			owner.events.slice(permissionEventIndex + 1).filter((event) =>
				event.type === "engine.state" && event.snapshot.phase === "running"
			).length,
			0,
		);
		await rejects(
			engine.resolvePermission({
				owner,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
				permissionId: permission.permissionId,
				decision: "allow_once",
			}),
			assertEngineError("not-found"),
		);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("disconnect and close join a real retirement that another caller already started", async () => {
	for (const joiner of ["disconnect", "close"] as const) {
		const root = await Deno.makeTempDir({ prefix: `workbench-engine-${joiner}-join-` });
		const harness = fixtureLauncher("hang");
		const engine = coordinator(harness.launcher);
		const sink = new RecordingSink();
		const selectedProject = project(`project-${joiner}-join`, root);
		try {
			await prepareReal(engine, sink, selectedProject);
			const context = await engine.start({ owner: sink, project: selectedProject, prompt: "Join owned retirement." });
			await waitForEvent(sink, "turn.started", (event) => event.context.turnId === context.turnId);
			const cancellation = engine.cancel({
				owner: sink,
				projectId: selectedProject.projectId,
				turnId: context.turnId,
			});
			if (joiner === "disconnect") await engine.disconnect(sink);
			else await engine.close();
			ok(sink.ofType("turn.terminal").some((event) => event.context.turnId === context.turnId));
			await cancellation;
		} finally {
			await engine.close();
			await Deno.remove(root, { recursive: true });
		}
	}
});

Deno.test("project refresh cannot hold real cleanup completion or the global slot open", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-refresh-detached-" });
	const harness = fixtureLauncher("hang");
	const engine = coordinator(harness.launcher);
	const sink = new NeverRefreshingSink();
	const selectedProject = project("project-refresh-detached", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Do not await presentation refresh.",
		});
		await waitForEvent(sink, "turn.started", (event) => event.context.turnId === context.turnId);
		const completed = await Promise.race([
			engine.cancel({ owner: sink, projectId: selectedProject.projectId, turnId: context.turnId }).then(() => true),
			delay(3_000).then(() => false),
		]);
		equal(completed, true);
		ok(sink.refreshes.includes(selectedProject.projectId));
		engine.select(sink, selectedProject, "fake");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a terminal sink rejection retries one safe failure and always releases ownership", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-terminal-totalized-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RejectFirstTerminalSink();
	const selectedProject = project("project-terminal-totalized", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Totalize terminal projection.",
		});
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "failed");
		equal(terminal.code, "workbench-finalization-failure");
		equal(terminal.summary, "Workbench could not finalize the bounded turn projection safely.");
		equal(sink.ofType("turn.terminal").filter((event) => event.context.turnId === context.turnId).length, 1);
		equal(engine.snapshot(selectedProject.projectId).phase, "failed");
		engine.select(sink, selectedProject, "fake");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a timed-out remote prompt requests cancel-first retirement", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-prompt-timeout-" });
	const callLogPath = join(root, "acp-calls.json");
	const harness = fixtureLauncher("permission", callLogPath);
	const engine = new EngineCoordinator({
		launcher: harness.launcher,
		eventDelayMs: 2,
		acpTiming: fastTiming,
		promptTimeoutMs: 250,
	});
	const sink = new RecordingSink();
	const selectedProject = project("project-prompt-timeout", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Time out this remote prompt.",
		});
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		equal(terminal.outcome, "failed");
		equal(terminal.code, "acp-client-failure");
		equal(
			sink.ofType("turn.tool").filter((event) => event.context.turnId === context.turnId && event.status === "failed")
				.length,
			1,
		);

		const calls = JSON.parse(await Deno.readTextFile(callLogPath)) as Array<{ method?: unknown }>;
		const methods = calls.map((call) => call.method);
		const promptIndex = methods.indexOf("session/prompt");
		const cancelIndex = methods.indexOf("session/cancel");
		ok(promptIndex >= 0);
		ok(cancelIndex > promptIndex, "prompt timeout must request cancellation before EOF retirement");
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("unknown ACP remote metadata collapses to one host-authored terminal projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-error-" });
	const harness = fixtureLauncher("remote-error-extra");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-real-error", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		await engine.start({ owner: sink, project: selectedProject, prompt: "Trigger a safe admission error." });
		const terminal = await waitForEvent(sink, "turn.terminal");
		deepStrictEqual(
			{
				outcome: terminal.outcome,
				code: terminal.code,
				summary: terminal.summary,
				source: terminal.source,
			},
			{
				outcome: "failed",
				code: "clio-operation-rejected",
				summary: "Clio rejected the bounded ACP operation.",
				source: "reported-by-clio",
			},
		);
		const projection = JSON.stringify(sink.events);
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
				root,
			]
		) {
			ok(!projection.includes(secret), `safe error projection leaked ${secret}`);
		}
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("an allowlisted Clio admission reason maps to fixed public code and prose", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-real-admission-error-" });
	const harness = fixtureLauncher("remote-error-admission");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-real-admission-error", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const context = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Exercise a mapped admission failure.",
		});
		const terminal = await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === context.turnId);
		deepStrictEqual(
			{ outcome: terminal.outcome, code: terminal.code, summary: terminal.summary, source: terminal.source },
			{
				outcome: "failed",
				code: "clio-admission-model-not-configured",
				summary: "Clio requires a configured model before it can start this turn.",
				source: "reported-by-clio",
			},
		);
		ok(!JSON.stringify(sink.events).includes("fixture admission prose must not survive projection"));
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a failed backend cannot cross the host start boundary until readiness is explicitly re-established", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-failed-restart-boundary-" });
	const harness = fixtureLauncher("remote-error-admission");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-failed-restart-boundary", root);
	try {
		await prepareReal(engine, sink, selectedProject);
		const first = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Enter the failed backend phase.",
		});
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === first.turnId);
		equal(engine.snapshot(selectedProject.projectId).phase, "failed");
		await rejects(
			engine.start({ owner: sink, project: selectedProject, prompt: "Do not implicitly restart the backend." }),
			assertEngineError("not-ready"),
		);
		deepStrictEqual(harness.launchedRoots, [root]);

		await engine.probe(sink, selectedProject);
		const second = await engine.start({
			owner: sink,
			project: selectedProject,
			prompt: "Start only after an explicit readiness transition.",
		});
		await waitForEvent(sink, "turn.terminal", (event) => event.context.turnId === second.turnId);
		deepStrictEqual(harness.launchedRoots, [root, root]);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("invalid prompts and stale cancellation capabilities are rejected before side effects", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-engine-invalid-" });
	const harness = fixtureLauncher("happy");
	const engine = coordinator(harness.launcher);
	const sink = new RecordingSink();
	const selectedProject = project("project-invalid", root);
	try {
		for (const prompt of ["", " ".repeat(20), "x".repeat(4 * 1024 + 1)]) {
			await rejects(
				engine.start({ owner: sink, project: selectedProject, prompt }),
				assertEngineError("invalid"),
			);
		}
		await rejects(
			engine.cancel({ owner: sink, projectId: selectedProject.projectId, turnId: "turn-stale" }),
			assertEngineError("not-found"),
		);
		equal(sink.events.length, 0);
		equal(harness.launchedRoots.length, 0);
	} finally {
		await engine.close();
		await Deno.remove(root, { recursive: true });
	}
});

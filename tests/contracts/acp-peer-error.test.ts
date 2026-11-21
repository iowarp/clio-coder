import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resolveAcpContinuation } from "../../src/domains/dispatch/acp-continuation.js";
import { classifyFailure } from "../../src/domains/dispatch/failure-classification.js";
import { workerFailureHeadline } from "../../src/domains/dispatch/failure-headline.js";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import { startAcpDelegationRun } from "../../src/engine/acp/adapter.js";
import { prepareAntigravityLaunch } from "../../src/engine/acp/antigravity-launch.js";
import { AcpEventMapper } from "../../src/engine/acp/event-mapper.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { makeScratchHome } from "../harness/scratch-env.js";

for (const timing of ["before-start", "during-connect"] as const) {
	test(`ACP cancellation ${timing} never submits the first prompt`, async () => {
		const home = makeScratchHome("acp-cancel-connect-");
		const log = join(home.dir, "requests.jsonl");
		const gate = join(home.dir, "connected");
		const controller = new AbortController();
		if (timing === "before-start") controller.abort();
		const run = startAcpDelegationRun({
			agent: {
				id: "cancel-fixture",
				command: process.execPath,
				args: [
					fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)),
					"cancel-connect",
					log,
					...(timing === "during-connect" ? [gate] : []),
				],
				connectTimeoutMs: 5_000,
			},
			environment: Object.fromEntries(
				Object.entries({ ...process.env, ...home.env }).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			task: "must not run",
			cwd: home.dir,
			safety: createWorkerSafety({ cwd: home.dir }),
			signal: controller.signal,
		});
		try {
			if (timing === "during-connect") {
				let observed = false;
				for (let attempt = 0; attempt < 200; attempt++) {
					observed = (await readFile(log, "utf8").catch(() => "")).includes("initialize");
					if (observed) break;
					await setTimeout(10);
				}
				ok(observed, "the peer reached its gated handshake");
				controller.abort();
				await writeFile(gate, "");
			}
			const result = await run.promise;
			const methods = (await readFile(log, "utf8").catch(() => "")).trim().split("\n");
			ok(!methods.includes("session/prompt"), methods.join(", "));
			strictEqual(result.stopReason, "cancelled");
		} finally {
			controller.abort();
			await writeFile(gate, "");
			await run.promise;
			home.cleanup();
		}
	});
}

test("ACP provider error streamed as text is marked as a failed turn", () => {
	const mapper = new AcpEventMapper();
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Warning: model metadata missing.\n" },
		},
	});
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text:
					'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}',
			},
		},
	});
	const failure = mapper.reportedFailure();
	strictEqual(failure, "ACP peer reported HTTP 400: The model is not supported.");
	const events = mapper.finalEvents({ stopReason: "end_turn" }, failure);
	const terminal = events[0] as { message: { stopReason: string; errorMessage: string } };
	strictEqual(terminal.message.stopReason, "error");
	strictEqual(terminal.message.errorMessage, failure);
});

test("ACP Anthropic error envelope without HTTP status is still a failure", () => {
	const mapper = new AcpEventMapper();
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: '{"type":"error","error":{"type":"invalid_request_error","message":"Unknown model"}}',
			},
		},
	});
	strictEqual(mapper.reportedFailure(), "ACP peer reported error: Unknown model");
});

test("ACP ordinary text and quoted error examples do not become failures", () => {
	for (const text of [
		"The package version is 0.5.5.",
		'An example error is {"type":"error","status":400,"error":{"message":"example"}}',
		'{"type":"error","status":200,"error":{"message":"example"}}',
	]) {
		const mapper = new AcpEventMapper();
		mapper.mapUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
		strictEqual(mapper.reportedFailure(), null);
	}
});

test("ACP adapter fails a peer turn that returns an error envelope with end_turn", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "error-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url))],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage, "ACP peer reported HTTP 400: The model is not supported.");
});

test("ACP adapter launches agy with an allowlisted env and an owned, marked TMPDIR removed after exit", {
	skip: process.platform === "win32",
}, async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-agy-launch-"));
	const root = join(tmpdir(), process.getuid ? `clio-coder-agy-${process.getuid()}` : "clio-coder-agy");
	const namespace = existsSync("/proc/self/ns/pid")
		? (/\[(\d+)\]/u.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? null)
		: null;
	// Only a marked run-* dir from this host and pid namespace whose recorded agy child and Clio owner are both gone is
	// swept. A marker without a child pid (crash between spawn and recordChild) is kept: agy may still be running.
	const seed = async (name: string, marker: Record<string, unknown> | null): Promise<string> => {
		const dir = join(root, name);
		await mkdir(join(dir, "tmp"), { recursive: true });
		if (marker !== null)
			await writeFile(
				join(dir, "owner.json"),
				JSON.stringify({ version: 1, host: hostname(), namespace, pid: 2147483646, birthToken: "gone", ...marker }),
			);
		return dir;
	};
	const orphan = await seed("run-test-orphan", { childPid: 2147483645 });
	const unmarked = await seed("run-test-unmarked", null);
	const liveChild = await seed("run-test-live-child", { childPid: process.pid });
	const foreign = await seed("run-test-foreign", { namespace: `${namespace}1`, childPid: 2147483645 });
	const noChild = await seed("run-test-no-child", {});
	const notRun = await seed("test-not-run", { childPid: 2147483645 });
	const seededDirs = [orphan, unmarked, liveChild, foreign, noChild, notRun];
	const seen = join(scratch, "seen");
	const agy = join(scratch, "agy");
	const fixture = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	await writeFile(
		agy,
		`#!/bin/sh\n{ echo "$TMPDIR"; [ -d "$TMPDIR" ] && echo dir; echo "$@"; echo "\${GEMINI_API_KEY-}|\${CLIO_TEST_TOKEN-}|\${BROWSER-}|$AGY_CLI_DISABLE_AUTO_UPDATE$AGY_ACP_FORCE_FILE_STORAGE$PYTHONUNBUFFERED|\${CLIO_CODER_AUTONOMY_CEILING-}|\${CLIO_CODER_YOLO_CONFINEMENT-}"; } > "${seen}"\nexec "${process.execPath}" "${fixture}"\n`,
		{ mode: 0o755 },
	);
	const cwd = process.cwd();
	const agent = {
		id: "antigravity",
		command: agy,
		args: ["acp", "--gemini-dir", "~/.gemini", "--app-data-dir", "antigravity-cli"],
		// The entry's env is the whole overlay; the forced keys win over it.
		env: { HOME: scratch, BROWSER: "none", AGY_CLI_DISABLE_AUTO_UPDATE: "0" },
		connectTimeoutMs: 5_000,
	};
	// The tool-env controls' ceiling and pin are the session's own, not this test's environment.
	const inherited = { ceiling: process.env.CLIO_CODER_AUTONOMY_CEILING, pin: process.env.CLIO_CODER_YOLO_CONFINEMENT };
	try {
		const seeded = new Set(seededDirs.map((dir) => basename(dir)));
		Reflect.deleteProperty(process.env, "CLIO_CODER_AUTONOMY_CEILING");
		Reflect.deleteProperty(process.env, "CLIO_CODER_YOLO_CONFINEMENT");
		const run = startAcpDelegationRun({
			agent,
			// A tightening ceiling and pin reach agy unnamed by the entry, like every other tool child; credentials do not.
			environment: {
				GEMINI_API_KEY: "leak",
				CLIO_TEST_TOKEN: "leak",
				CLIO_CODER_AUTONOMY_CEILING: "default",
				CLIO_CODER_YOLO_CONFINEMENT: "contained",
			},
			task: "report package version",
			cwd,
			safety: createWorkerSafety({ cwd }),
		});
		if (inherited.ceiling !== undefined) process.env.CLIO_CODER_AUTONOMY_CEILING = inherited.ceiling;
		if (inherited.pin !== undefined) process.env.CLIO_CODER_YOLO_CONFINEMENT = inherited.pin;
		// The marker names the spawned child by the time start returns (the child itself may read it earlier).
		const launched = readdirSync(root).filter((name) => !seeded.has(name));
		strictEqual(launched.length, 1);
		const owner = JSON.parse(readFileSync(join(root, launched[0] ?? "", "owner.json"), "utf8")) as {
			pid: number;
			childPid: number;
		};
		strictEqual(owner.pid, process.pid);
		strictEqual(owner.childPid, run.pid);
		strictEqual((await run.promise).stopReason, "error");
		const [tempDir = "", isDir, args, env] = (await readFile(seen, "utf8")).trim().split("\n");
		strictEqual(tempDir, join(root, launched[0] ?? "", "tmp"));
		strictEqual(isDir, "dir");
		strictEqual(args, `acp --gemini-dir ${join(scratch, ".gemini")} --app-data-dir antigravity-cli`);
		strictEqual(env, "||none|111|default|contained");
		strictEqual(existsSync(join(tempDir, "..")), false);
		strictEqual(existsSync(orphan), namespace === null);
		for (const kept of [unmarked, liveChild, foreign, noChild, notRun]) strictEqual(existsSync(kept), true, kept);
		// The profile is <gemini-dir>/<app-data-dir>: a consumed value is never read as a flag, and an empty or missing
		// value leaves agy's default.
		const profileOf = (args: string[]): string => {
			const prepared = prepareAntigravityLaunch({ ...agent, args }, { HOME: scratch }, scratch);
			prepared.discard();
			return prepared.profileDir;
		};
		const fallback = join(scratch, ".gemini", "antigravity-cli");
		strictEqual(profileOf(agent.args), fallback);
		strictEqual(profileOf(["acp", "--gemini-dir=", "--app-data-dir="]), fallback);
		strictEqual(profileOf(["acp", "--app-data-dir", "x", "--app-data-dir"]), join(scratch, ".gemini", "x"));
		strictEqual(profileOf(["acp", "--gemini-dir", "/g", "--app_data_dir", "--gemini-dir"]), "/g/--gemini-dir");
		strictEqual(profileOf(["acp", "--gemini_dir=rel", "--app-data-dir", "/abs"]), "/abs");
		strictEqual(profileOf(["acp", "--gemini-dir", "rel"]), join(scratch, "rel", "antigravity-cli"));
		// spawn rejects a NUL byte synchronously; the launch dir made before it must not survive the throw.
		const before = (await readdir(root)).sort();
		throws(
			() =>
				startAcpDelegationRun({
					agent: { ...agent, args: ["acp", "bad\0arg"] },
					task: "never runs",
					cwd,
					safety: createWorkerSafety({ cwd }),
				}),
			/null bytes/u,
		);
		deepStrictEqual((await readdir(root)).sort(), before);
	} finally {
		if (inherited.ceiling !== undefined) process.env.CLIO_CODER_AUTONOMY_CEILING = inherited.ceiling;
		if (inherited.pin !== undefined) process.env.CLIO_CODER_YOLO_CONFINEMENT = inherited.pin;
		await rm(scratch, { recursive: true, force: true });
		for (const dir of seededDirs) await rm(dir, { recursive: true, force: true });
	}
});

interface AgyFrame {
	method?: string;
	id?: unknown;
	params?: {
		clientCapabilities?: unknown;
		clientInfo?: { name?: string };
		_meta?: unknown;
		prompt?: Array<{ text?: string }>;
		configId?: string;
		value?: string;
	};
	result?: unknown;
}

test("ACP adapter applies the agy shims: version floor, explicit capabilities, prompt append, default mode, questions, tool shapes, steering, sign-in, store sideband", {
	skip: process.platform === "win32",
}, async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-agy-shims-"));
	const fixture = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	const cwd = process.cwd();
	const launch = async (
		name: string,
		version: string,
		session: "ok" | "auth" | "abort" | "null" | "sideband" | "sideband-max" | "sideband-clean",
	) => {
		const dir = join(scratch, name);
		await mkdir(dir);
		const log = join(dir, "frames.jsonl");
		const agy = join(dir, "agy");
		await writeFile(agy, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" agy "${log}" ${version} ${session}\n`, {
			mode: 0o755,
		});
		const run = startAcpDelegationRun({
			agent: {
				id: "antigravity",
				command: agy,
				args: ["acp", "--gemini-dir", "~/.gemini", "--app-data-dir", "antigravity-cli"],
				env: { HOME: scratch },
				connectTimeoutMs: 5_000,
			},
			// A pending steer must not hold an aborted run open until this grace forces termination.
			cancelGraceMs: 600_000,
			task: "pick a branch",
			systemPrompt: "SYSTEM RULES",
			cwd,
			safety: createWorkerSafety({ cwd }),
		});
		const frames = async () =>
			(await readFile(log, "utf8").catch(() => ""))
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as AgyFrame);
		return { run, frames, agy };
	};
	try {
		const old = await launch("old", "1.5.0", "ok");
		const refused = await old.run.promise;
		strictEqual(refused.stopReason, "error");
		ok(/CLI 1\.5\.0 is not supported.*agy 1\.5\.1 or later/u.test(refused.failureMessage ?? ""), refused.failureMessage);
		deepStrictEqual(
			(await old.frames()).map((frame) => frame.method),
			["initialize"],
		);

		const signedOut = await launch("auth", "1.5.13", "auth");
		const auth = await signedOut.run.promise;
		const login = `${signedOut.agy} acp --gemini-dir ${join(scratch, ".gemini")} --app-data-dir antigravity-cli --login`;
		deepStrictEqual(auth.authRequired, { loginCommand: login });
		ok(auth.failureMessage?.includes(`Authentication required`), auth.failureMessage);
		ok(auth.failureMessage?.endsWith(login), auth.failureMessage);

		const live = await launch("live", "1.5.13", "ok");
		const questions: unknown[] = [];
		const steered: boolean[] = [];
		const steerFailures: unknown[] = [];
		let lateSteer: boolean | undefined;
		for await (const event of live.run.events) {
			const typed = event as { type: string; payload?: unknown; text?: string };
			if (typed.type === "clio_coder_peer_steer_failed") steerFailures.push(typed.payload);
			// The turn's own prompt has answered by now; a steer here would open a new turn, so it is refused.
			if (typed.type === "text_delta" && typed.text === "initial-done") lateSteer = live.run.steer?.("too late");
			if (typed.type !== "clio_coder_peer_question") continue;
			questions.push(typed.payload);
			if ((typed.payload as { questionId?: string }).questionId !== "interaction_1") continue;
			steered.push(live.run.steer?.("use the topic branch") === true, live.run.steer?.("second steer") === true);
		}
		const result = await live.run.promise;
		// The first steer settled first at max_tokens; the turn's later end_turn does not hide it, and the second
		// steer's failure after the turn answered is recorded, not the run's failure.
		strictEqual(result.stopReason, "max_tokens", result.failureMessage);
		strictEqual(result.failureMessage, "ACP stopReason=max_tokens");
		deepStrictEqual(steerFailures, [{ reason: "ACP session/prompt failed: steer lost" }]);
		strictEqual(lateSteer, false);
		strictEqual(live.run.steer?.("after the run"), false);
		// interaction_2..4 carry an execute command, or a path or URL under kind other or none: tool calls for the
		// mediator. interaction_5 and _6 have null or empty locations and no tool input: questions.
		strictEqual(result.delegation.toolCallsRequested, 6);
		// agy's own shapes are judged as what they run: run_command's command line, run_workflow's script as inline
		// Python; a tool the shims cannot map is denied by name, never as an empty bash command.
		deepStrictEqual(
			live.run
				.toolCallLog()
				.filter((entry) => entry.callId.startsWith("call_"))
				.map(({ callId, tool, arguments: args, decision, reason }) => ({ callId, tool, args, decision, reason })),
			[
				{
					callId: "call_1",
					tool: "bash",
					args: { command: "ls", cwd },
					decision: "approved",
					reason: "bash-recognized-chain",
				},
				{
					callId: "call_2",
					tool: "bash",
					args: { command: `python3 -c 'print('\\''hi'\\'')'`, cwd },
					decision: "denied",
					reason: "permission_required: denied by non-stall policy (no interactive operator in delegation context)",
				},
				{
					callId: "call_3",
					tool: "agy:browser_click",
					args: { toolName: "agy:browser_click" },
					decision: "denied",
					reason: "unknown ACP tool: agy:browser_click",
				},
			],
		);
		deepStrictEqual(steered, [true, true]);
		const question = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
			questionId: id,
			question: text,
			choices: ["Allow", "Reject"],
			...extra,
			answer: "cancelled",
		});
		deepStrictEqual(questions, [
			question("interaction_5", "Null locations?"),
			question("interaction_6", "No locations?"),
			{
				questionId: "interaction_1",
				question: "Which branch?",
				choices: ["main", "topic"],
				securityWarning: "pushes to main",
				answer: "cancelled",
			},
		]);
		const frames = await live.frames();
		const init = frames.find((frame) => frame.method === "initialize");
		deepStrictEqual(init?.params?.clientCapabilities, {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		});
		strictEqual(init?.params?.clientInfo?.name, "clio-coder");
		const sessionNew = frames.find((frame) => frame.method === "session/new");
		deepStrictEqual(sessionNew?.params?._meta, { antigravity: { systemPrompt: { append: "SYSTEM RULES" } } });
		deepStrictEqual(frames.find((frame) => frame.method === "session/set_mode")?.params, {
			sessionId: "agy-session",
			modeId: "default",
		});
		const prompts = frames
			.filter((frame) => frame.method === "session/prompt")
			.map((frame) => frame.params?.prompt?.[0]?.text ?? "");
		const [first = "", ...steers] = prompts;
		ok(!first.includes("SYSTEM RULES") && first.includes("pick a branch"), first);
		deepStrictEqual(steers, ["use the topic branch", "second steer"]);
		ok(!frames.some((frame) => frame.method === "session/cancel"));
		deepStrictEqual(frames.find((frame) => frame.id === "question-1" && frame.method === undefined)?.result, {
			outcome: { outcome: "cancelled" },
		});

		// Abort while a steer is pending after the turn's own prompt answered end_turn: the run settles cancelled
		// (agent_end included) without waiting on the steer. This session reports its mode only as a config option,
		// which is reset to default the same way.
		const aborting = await launch("abort", "1.5.13", "abort");
		const ends: unknown[] = [];
		for await (const event of aborting.run.events) {
			const typed = event as { type: string; text?: string; messages?: Array<{ stopReason?: string }> };
			if (typed.type === "agent_end") ends.push(typed.messages?.[0]?.stopReason);
			if (typed.type === "clio_coder_peer_question") strictEqual(aborting.run.steer?.("never answered"), true);
			if (typed.type === "text_delta" && typed.text === "turn-answered") aborting.run.abort();
		}
		const cancelled = await aborting.run.promise;
		strictEqual(cancelled.stopReason, "cancelled");
		strictEqual(cancelled.exitCode, 1);
		strictEqual(cancelled.failureMessage, undefined);
		deepStrictEqual(ends, ["aborted"]);
		const abortFrames = await aborting.frames();
		deepStrictEqual(
			abortFrames.filter((frame) => frame.method === "session/set_config_option").map((frame) => frame.params?.value),
			["default"],
		);

		// A steer answered with a null result is a response without a stop reason, not a crash in settlement.
		const nulled = await launch("null", "1.5.13", "null");
		for await (const event of nulled.run.events) {
			if ((event as { type: string }).type === "clio_coder_peer_question") nulled.run.steer?.("null please");
		}
		const missing = await nulled.run.promise;
		strictEqual(missing.stopReason, "error");
		strictEqual(missing.failureMessage, "ACP prompt response missing stopReason");

		// agy answers end_turn but recorded a quota error and a thinking-signature error in its store under the launch's
		// profile (HOME/.gemini/antigravity-cli): the run fails with the typed usage limit and the session is marked spent.
		const sideband = await (await launch("sideband", "1.5.13", "sideband")).run.promise;
		const usageLimit = {
			cause: "usage_limit_reached",
			reason: "QUOTA_EXHAUSTED",
			message: "Antigravity quota exhausted for gemini-x-high; resets at 2026-11-21T01:00:00.000Z",
			model: "gemini-x-high",
			resetAt: "2026-11-21T01:00:00.000Z",
			resetDelayMs: 7_200_000,
			retryAfterMs: 7_000,
		};
		deepStrictEqual(
			{ stopReason: sideband.stopReason, exitCode: sideband.exitCode, failureMessage: sideband.failureMessage },
			{ stopReason: "error", exitCode: 1, failureMessage: usageLimit.message },
		);
		deepStrictEqual(sideband.usageLimit, usageLimit);
		deepStrictEqual(sideband.delegation.nonResumable, { reason: "INVALID_THINKING_SIGNATURE" });
		// The same errors under a max_tokens end keep the peer's outcome; the session is still marked spent.
		const maxed = await (await launch("sideband-max", "1.5.13", "sideband-max")).run.promise;
		deepStrictEqual(
			{ stopReason: maxed.stopReason, failureMessage: maxed.failureMessage, usageLimit: maxed.usageLimit },
			{ stopReason: "max_tokens", failureMessage: "ACP stopReason=max_tokens", usageLimit: undefined },
		);
		deepStrictEqual(maxed.delegation.nonResumable, { reason: "INVALID_THINKING_SIGNATURE" });
		// The store's earlier error steps predate this session's first prompt (baseline): a clean turn succeeds.
		const clean = await (await launch("sideband-clean", "1.5.13", "sideband-clean")).run.promise;
		deepStrictEqual(
			{
				stopReason: clean.stopReason,
				exitCode: clean.exitCode,
				usageLimit: clean.usageLimit,
				nonResumable: clean.delegation.nonResumable,
			},
			{ stopReason: "end_turn", exitCode: 0, usageLimit: undefined, nonResumable: undefined },
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("ACP adapter fails a statusless Anthropic error envelope with end_turn", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "anthropic-error-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "anthropic-error"],
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage, "ACP peer reported error: The model is not supported.");
});

test("ACP adapter selects a requested Codex model before prompting", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-pin"],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		model: "gpt-6-luna",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.stopReason, "end_turn");
	strictEqual(result.delegation.selectedModelId, "gpt-6-luna[medium]");
});

test("ACP adapter uses the requested effort and rejects an ambiguous base model", async () => {
	const cwd = process.cwd();
	const agent = {
		id: "model-fixture",
		command: process.execPath,
		args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-variants"],
		connectTimeoutMs: 5_000,
	};
	const safety = createWorkerSafety({ cwd });
	const pinned = await startAcpDelegationRun({
		agent,
		task: "report version",
		model: "gpt-6-luna",
		thinkingLevel: "high",
		cwd,
		safety,
	}).promise;
	strictEqual(pinned.exitCode, 0, pinned.failureMessage);
	strictEqual(pinned.delegation.selectedModelId, "gpt-6-luna[high]");
	const ambiguous = await startAcpDelegationRun({ agent, task: "report version", model: "gpt-6-luna", cwd, safety })
		.promise;
	strictEqual(ambiguous.exitCode, 1);
	strictEqual(ambiguous.failureMessage?.includes("offers multiple efforts"), true);
});

test("ACP adapter selects model and thinking level through separate peer config options", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "thought-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "thought-option"],
		},
		task: "report version",
		model: "gpt-6-luna",
		thinkingLevel: "high",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.delegation.selectedModelId, "gpt-6-luna");
});

test("ACP adapter selects a peer thinking level without a model request", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "thought-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "thought-option"],
		},
		task: "report version",
		thinkingLevel: "high",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.delegation.selectedModelId, "gpt-6-astra");
});

test("ACP adapter fails before prompting when the peer keeps another thinking level", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "thought-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "thought-refuse"],
		},
		task: "report version",
		model: "gpt-6-luna",
		thinkingLevel: "high",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage?.includes("kept thinking level 'medium' after Clio selected 'high'"), true);
});

test("ACP adapter splits agy legacy <model>-<level> ids and names the offered choices when one is refused", {
	skip: process.platform === "win32",
}, async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-agy-levels-"));
	const agy = join(scratch, "agy");
	const fixture = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	await writeFile(agy, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" agy-levels "$AGY_START" "$AGY_EXPECT"\n`, {
		mode: 0o755,
	});
	const cwd = process.cwd();
	// The fixture ends the turn only when it runs the expected model and level; a level-less model has no thought_level.
	const run = (model: string, thinkingLevel?: string, start = "gemini-3.8-flash", expect = "") =>
		startAcpDelegationRun({
			agent: {
				id: "antigravity",
				command: agy,
				args: ["acp"],
				env: { HOME: scratch, AGY_START: start, AGY_EXPECT: expect },
				connectTimeoutMs: 5_000,
			},
			task: "report version",
			model,
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
			cwd,
			safety: createWorkerSafety({ cwd }),
		}).promise;
	try {
		for (const [model, thinkingLevel, start, expect] of [
			// xhigh is offered only once the model is pro, so the level is checked against the switched model's list.
			["gemini-3.8-pro-xhigh", undefined, undefined, "gemini-3.8-pro/xhigh"],
			// The offered spelling is sent whatever case the request used.
			["gemini-3.8-flash-high", "HIGH", undefined, "gemini-3.8-flash/high"],
			// Starting on a model without levels: an offered id is never rewritten as gemini-3.8-flash[low], and a
			// legacy id still splits; each level is checked once the switch returns flash's options.
			["gemini-3.8-flash", "low", "claude-sonnet-4-6", "gemini-3.8-flash/low"],
			["gemini-3.8-flash-medium", undefined, "claude-sonnet-4-6", "gemini-3.8-flash/medium"],
		] as const) {
			const selected = await run(model, thinkingLevel, start, expect);
			strictEqual(selected.exitCode, 0, `${model}: ${selected.failureMessage}`);
			strictEqual(selected.delegation.selectedModelId, expect.split("/")[0]);
		}
		for (const [model, thinkingLevel, failure] of [
			["gemini-3.8-pro-medium", undefined, "thinking level 'medium'; offered: low, high, xhigh"],
			[
				"gemini-9-ultra",
				undefined,
				"model 'gemini-9-ultra'; offered: gemini-3.8-flash, gemini-3.8-pro, claude-sonnet-4-6",
			],
			["gemini-3.8-pro-high", "low", "model 'gemini-3.8-pro-high' with thinking level 'low'"],
			// The switch's options drop thought_level, so the level is refused rather than ignored.
			["claude-sonnet-4-6", "low", "thinking level 'low'; the peer offers none"],
		] as const) {
			const refused = await run(model, thinkingLevel);
			strictEqual(refused.exitCode, 1);
			ok(refused.failureMessage?.includes(`ACP peer does not offer requested ${failure}`), refused.failureMessage);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("ACP adapter selects models only through the stable config option, never session/set_model", async () => {
	const cwd = process.cwd();
	// A peer that offers only the unstable `models` field has no stable model
	// selector, so an explicit model request fails before prompting, and
	// session/set_model is never sent (the fixture refuses the prompt if it is).
	const legacy = await startAcpDelegationRun({
		agent: {
			id: "legacy-model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "legacy-models"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		model: "gpt-6-luna",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(legacy.exitCode, 1);
	strictEqual(
		legacy.failureMessage?.includes("does not offer requested model 'gpt-6-luna'"),
		true,
		legacy.failureMessage,
	);
	strictEqual(legacy.delegation.selectedModelId, undefined);
	// Without a requested model, the unstable field is not read as the selection either.
	const unrequested = await startAcpDelegationRun({
		agent: {
			id: "legacy-model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "legacy-models"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(unrequested.delegation.selectedModelId, undefined);
});

test("ACP adapter reports the config option's current model when none is requested", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-variants"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.delegation.selectedModelId, "gpt-6-astra[medium]");
});

test("ACP adapter reopens an earlier session by session/resume over session/load, keeps a load's replay out of the run, and refuses a peer with neither", async () => {
	const home = makeScratchHome("acp-reopen-");
	const peer = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	const reopen = async (kind: "resume" | "load" | "none") => {
		const log = join(home.dir, `${kind}.jsonl`);
		const run = startAcpDelegationRun({
			agent: { id: `reopen-${kind}`, command: process.execPath, args: [peer, `reopen-${kind}`, log] },
			task: "next step",
			systemPrompt: "SYSTEM RULES",
			cwd: home.dir,
			safety: createWorkerSafety({ cwd: home.dir }),
			reopen: { sessionId: "earlier-session" },
		});
		const result = await run.promise;
		const events: Array<{ type: string; text?: string }> = [];
		for await (const event of run.events) events.push(event as { type: string; text?: string });
		const requests = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { method: string; params?: { prompt?: Array<{ text: string }> } });
		return { result, events, requests };
	};
	try {
		const resumed = await reopen("resume");
		strictEqual(resumed.result.exitCode, 0, resumed.result.failureMessage);
		strictEqual(resumed.result.delegation.opened, "resume");
		strictEqual(resumed.result.delegation.acpSessionId, "earlier-session");
		deepStrictEqual(
			resumed.requests.map((request) => request.method),
			["initialize", "session/resume", "session/prompt"],
		);
		// The reopened session already holds the system prompt; the turn carries only the task.
		const prompt = resumed.requests.at(-1)?.params?.prompt?.[0]?.text ?? "";
		ok(prompt.includes("next step") && !prompt.includes("SYSTEM RULES"), prompt);

		const loaded = await reopen("load");
		strictEqual(loaded.result.exitCode, 0, loaded.result.failureMessage);
		strictEqual(loaded.result.delegation.opened, "load");
		strictEqual(loaded.result.delegation.replayedUpdates, 2);
		deepStrictEqual(
			loaded.events.filter((event) => event.type === "text_delta").map((event) => event.text),
			["continued earlier-session"],
		);
		ok(!loaded.events.some((event) => event.type === "tool_execution_start"), "replayed tool calls are not this run's");

		const refused = await reopen("none");
		strictEqual(refused.result.exitCode, 1);
		ok(
			/^ACP delegation failed: ACP peer cannot reopen session 'earlier-session'/u.test(
				refused.result.failureMessage ?? "",
			),
			refused.result.failureMessage,
		);
		deepStrictEqual(
			refused.requests.map((request) => request.method),
			["initialize"],
		);

		// Dispatch's continue_run: the earlier row decides between reopening its session, a fresh one, and a refusal.
		const row = {
			runtimeKind: "acp-delegation",
			agentId: "antigravity",
			sessionId: "owner",
			endedAt: "2026-11-21T12:00:00.000Z",
			acpSession: { sessionId: "agy-1" },
		} as unknown as RunEnvelope;
		const ask = { runId: "run-1", agentId: "antigravity", ownerSessionId: "owner" };
		deepStrictEqual(resolveAcpContinuation({ ...ask, row }), {
			kind: "reopen",
			fromRunId: "run-1",
			acpSessionId: "agy-1",
		});
		const spent = { ...row, acpSession: { sessionId: "agy-1", nonResumable: { reason: "INVALID_THINKING_SIGNATURE" } } };
		strictEqual(resolveAcpContinuation({ ...ask, row: spent }).kind, "fresh");
		throws(() => resolveAcpContinuation({ ...ask, ownerSessionId: "other", row }), /belongs to another session/u);
		throws(() => resolveAcpContinuation({ ...ask, agentId: "codex", row }), /ran agent 'antigravity', not 'codex'/u);
		throws(() => resolveAcpContinuation({ ...ask, row: { ...row, endedAt: null } }), /has not settled/u);
		throws(() => resolveAcpContinuation({ ...ask, row: null }), /names no run/u);
	} finally {
		home.cleanup();
	}
});

test("ACP adapter keeps a session open after its prompt for background work within postSettleMs, and not when it is off", async () => {
	const cwd = process.cwd();
	const peer = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	const settle = async (scenario: "complete" | "hang", postSettleMs: number) => {
		const run = startAcpDelegationRun({
			agent: { id: "settle-fixture", command: process.execPath, args: [peer, "post-settle", scenario], postSettleMs },
			task: "build it",
			cwd,
			safety: createWorkerSafety({ cwd }),
			postSettleQuietMs: 50,
		});
		const result = await run.promise;
		const events: Array<{ type: string; message?: { content: Array<{ type: string; text?: string }> } }> = [];
		for await (const event of run.events) events.push(event as (typeof events)[number]);
		const end = events.find((event) => event.type === "message_end");
		const text = end?.message?.content.find((part) => part.type === "text")?.text ?? "";
		return { result, text, events };
	};
	const held = await settle("complete", 60_000);
	strictEqual(held.result.exitCode, 0, held.result.failureMessage);
	strictEqual(held.text, "started the build. background done");
	strictEqual(held.result.delegation.postSettle?.ended, "quiet");
	strictEqual(held.result.delegation.postSettle?.updates, 2);
	ok(
		held.events.some((event) => event.type === "tool_execution_end"),
		"the background call settled inside the run",
	);

	const off = await settle("complete", 0);
	strictEqual(off.result.delegation.postSettle, undefined);
	strictEqual(off.text, "started the build.");

	const bounded = await settle("hang", 200);
	strictEqual(bounded.result.exitCode, 0, bounded.result.failureMessage);
	strictEqual(bounded.result.delegation.postSettle?.ended, "bound");
	strictEqual(bounded.text, "started the build.");
});

test("ACP adapter fails a prompt response missing stopReason", async () => {
	const terminal = new AcpEventMapper().finalEvents({})[0] as {
		message: { stopReason: string; errorMessage: string };
	};
	strictEqual(terminal.message.stopReason, "error");
	strictEqual(terminal.message.errorMessage, "ACP prompt response missing stopReason");
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "missing-stop-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "missing-stop-reason"],
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage, "ACP prompt response missing stopReason");
});

test("ACP adapter selects the option whose id is model when a target option shares its category", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "target-first-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "target-first"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		model: "gpt-6-luna",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.delegation.selectedModelId, "gpt-6-luna[medium]");
});

test("ACP adapter fails an unavailable explicit model before prompting", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-pin"],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		model: "gpt-6-unknown",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage?.includes("does not offer requested model 'gpt-6-unknown'"), true);
});

test("ACP dispatch seals peer errors as failed and forwards a requested model", async () => {
	await isolateDispatchState();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.fleet.retry.routeCooldownMs = 0;
	settings.integrations.externalAgents.entries = [
		{
			id: "peer-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url))],
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	try {
		await bundle.extension.start();
		const request = { agentId: "peer-fixture", task: "report package version", executionRole: "builder" as const };
		const failure = await bundle.contract.dispatch(request);
		const failed = await failure.finalPromise;
		strictEqual(failed.outcome, "failed");
		strictEqual(failed.exitCode, 1);
		strictEqual(failed.failureMessage, "ACP peer reported HTTP 400: The model is not supported.");
		settings.integrations.externalAgents.entries[0]?.args.push("model-pin");
		const selected = await bundle.contract.dispatch({ ...request, model: "gpt-6-luna" });
		const succeeded = await selected.finalPromise;
		strictEqual(succeeded.outcome, "succeeded");
		strictEqual(succeeded.exitCode, 0);
		strictEqual(succeeded.delegation?.selectedModelId, "gpt-6-luna[medium]");
		// A typed admission refusal settles with its own outcome code; the peer's untyped error above keeps none (C-16).
		strictEqual(failed.outcomeCode, null);
		const unoffered = await (await bundle.contract.dispatch({ ...request, model: "gpt-9-unknown" })).finalPromise;
		strictEqual(unoffered.outcomeCode, "acp_model_unavailable");
		ok(
			unoffered.outcomeDetail?.includes("does not offer requested model 'gpt-9-unknown'"),
			unoffered.outcomeDetail ?? "",
		);
		const thought = settings.integrations.externalAgents.entries[0];
		if (thought !== undefined) thought.args = [thought.args[0] ?? "", "thought-option"];
		const level = await (await bundle.contract.dispatch({ ...request, thinkingLevel: "xhigh" })).finalPromise;
		strictEqual(level.outcomeCode, "acp_thinking_unavailable", level.failureMessage);
		// A peer that keeps another level after Clio selected one is the same refusal.
		if (thought !== undefined) thought.args = [thought.args[0] ?? "", "thought-refuse"];
		const kept = await (await bundle.contract.dispatch({ ...request, model: "gpt-6-luna", thinkingLevel: "high" }))
			.finalPromise;
		strictEqual(kept.outcomeCode, "acp_thinking_unavailable", kept.failureMessage);
		// The headline is the adapter's words, without the generic stop reason.
		strictEqual(
			workerFailureHeadline(unoffered.outcomeDetail)?.startsWith("ACP delegation failed: ACP peer does not offer"),
			true,
			unoffered.outcomeDetail ?? "",
		);
		// A sign-in refusal moves to another target, as a 401/403 does, never a same-target retry.
		const evidence = {
			exitCode: 1,
			abortedByOperator: false,
			stallKilled: false,
			timedOut: false,
			permissionFailure: false,
			policyDenied: null,
			stopReason: "error",
		};
		strictEqual(classifyFailure(evidence, null, "failed", "acp_auth_required"), "target-auth");
	} finally {
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});

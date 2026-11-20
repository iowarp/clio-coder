import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { startAcpDelegationRun } from "../../src/engine/acp/adapter.js";
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

test("ACP adapter applies the agy shims: version floor, explicit capabilities, prompt append, default mode, questions, steering, sign-in, store sideband", {
	skip: process.platform === "win32",
}, async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-agy-shims-"));
	const fixture = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	const cwd = process.cwd();
	const launch = async (name: string, version: string, session: "ok" | "auth" | "abort" | "null" | "sideband") => {
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
		strictEqual(result.delegation.toolCallsRequested, 3);
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
	} finally {
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});

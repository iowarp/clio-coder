// Runtime verification: drives startSubprocessWorkerRun against argv-logging
// shims for every (cli runtime x mode x CLIO_ALLOW_EXTERNAL_FULL_ACCESS) cell,
// then asserts the actual argv received by the spawned binary contains (or omits)
// the runtime's dangerous flag set. This is the integration counterpart to the
// plan-layer matrix in subprocess-dispatch.test.ts: it proves the gate fires at
// spawn time, not just in the plan object.

import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";
import { startSubprocessWorkerRun } from "../../../src/engine/subprocess-runtime.js";
import type { AgentEvent } from "../../../src/engine/types.js";

const FULL_ACCESS_ENV = "CLIO_ALLOW_EXTERNAL_FULL_ACCESS";
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_FULL_ACCESS = process.env[FULL_ACCESS_ENV];

interface RuntimeCase {
	id: string;
	model: string;
	dangerous: ReadonlyArray<string>; // tokens that must appear iff super + env=1
	adviseFlag: ReadonlyArray<string> | null; // tokens that must appear in advise mode
	shimStdout: string; // payload the shim prints so the runtime parser sees a success event
}

const SUCCESS_STDOUT: Record<string, string> = {
	"claude-code-cli": JSON.stringify({
		type: "result",
		subtype: "success",
		result: "OK",
		usage: { input_tokens: 1, output_tokens: 1 },
		total_cost_usd: 0,
	}),
	"codex-cli": [
		JSON.stringify({ type: "thread.started", thread_id: "stub-1" }),
		JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
		JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
	].join("\n"),
	"gemini-cli": [
		JSON.stringify({ type: "message", message: { content: "OK" } }),
		JSON.stringify({
			type: "result",
			status: "success",
			result: "OK",
			stats: { total_tokens: 2, input_tokens: 1, output_tokens: 1 },
		}),
	].join("\n"),
	"copilot-cli": [
		JSON.stringify({ type: "assistant.message", data: { messageId: "x", content: "OK" } }),
		JSON.stringify({ type: "result", exitCode: 0 }),
	].join("\n"),
};

const SHIM_BINARY_BY_RUNTIME: Record<string, string> = {
	"claude-code-cli": "claude",
	"codex-cli": "codex",
	"gemini-cli": "gemini",
	"copilot-cli": "copilot",
};

const cases: ReadonlyArray<RuntimeCase> = [
	{
		id: "claude-code-cli",
		model: "claude-sonnet-4-6",
		dangerous: ["bypassPermissions"],
		adviseFlag: ["plan"],
		shimStdout: SUCCESS_STDOUT["claude-code-cli"] ?? "",
	},
	{
		id: "codex-cli",
		model: "gpt-5.4-mini",
		dangerous: ["danger-full-access"],
		adviseFlag: ["read-only"],
		shimStdout: SUCCESS_STDOUT["codex-cli"] ?? "",
	},
	{
		id: "gemini-cli",
		model: "gemini-3-flash-preview",
		dangerous: ["yolo"],
		adviseFlag: ["plan"],
		shimStdout: SUCCESS_STDOUT["gemini-cli"] ?? "",
	},
	{
		id: "copilot-cli",
		model: "gpt-5.4-mini",
		dangerous: ["--allow-all-tools"],
		adviseFlag: ["plan"],
		shimStdout: SUCCESS_STDOUT["copilot-cli"] ?? "",
	},
];

function runtimeDesc(id: string): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "subprocess",
		apiFamily: "subprocess-claude-code",
		auth: "cli",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: "test-model", provider: "p", baseUrl: "" }) as never,
	};
}

describe("external runtime gate (real spawn via argv-logging shims)", () => {
	let scratch: string;
	let logPath: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-external-gate-"));
		logPath = join(scratch, "argv.log");
		writeFileSync(logPath, "");
		// One shim per CLI binary. Logs argv (one token per ARG line) and prints success payload.
		for (const c of cases) {
			const binName = SHIM_BINARY_BY_RUNTIME[c.id];
			if (!binName) continue;
			const shim = [
				"#!/usr/bin/env node",
				`const fs = require("node:fs");`,
				`const lines = ["TS=" + new Date().toISOString() + " BIN=" + ${JSON.stringify(binName)}];`,
				`for (const a of process.argv.slice(2)) lines.push("ARG " + a);`,
				`lines.push("END");`,
				`fs.appendFileSync(${JSON.stringify(logPath)}, lines.join("\\n") + "\\n");`,
				`process.stdout.write(${JSON.stringify(c.shimStdout)});`,
				`process.exit(0);`,
			].join("\n");
			const shimPath = join(scratch, binName);
			writeFileSync(shimPath, shim);
			chmodSync(shimPath, 0o755);
		}
		process.env.PATH = `${scratch}${delimiter}${ORIGINAL_PATH ?? ""}`;
	});

	afterEach(() => {
		if (ORIGINAL_PATH === undefined) Reflect.deleteProperty(process.env, "PATH");
		else process.env.PATH = ORIGINAL_PATH;
		if (ORIGINAL_FULL_ACCESS === undefined) Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
		else process.env[FULL_ACCESS_ENV] = ORIGINAL_FULL_ACCESS;
		rmSync(scratch, { recursive: true, force: true });
	});

	async function driveAndReadArgv(c: RuntimeCase, mode: "advise" | "super"): Promise<ReadonlyArray<string>> {
		writeFileSync(logPath, "");
		const events: AgentEvent[] = [];
		const handle = startSubprocessWorkerRun(
			{
				systemPrompt: "",
				task: "say OK",
				endpoint: { id: "test-ep", runtime: c.id } as EndpointDescriptor,
				runtime: runtimeDesc(c.id),
				wireModelId: c.model,
				mode,
			},
			(event) => events.push(event),
		);
		const result = await handle.promise;
		strictEqual(result.exitCode, 0, `${c.id}/${mode}: shim should exit 0`);
		const log = readFileSync(logPath, "utf8");
		const argv: string[] = [];
		for (const line of log.split("\n")) {
			const m = line.match(/^ARG (.*)$/);
			if (m && m[1] !== undefined) argv.push(m[1]);
		}
		return argv;
	}

	function tokenIn(haystack: ReadonlyArray<string>, needle: string): boolean {
		return haystack.some((arg) => arg === needle || arg.includes(needle));
	}

	for (const c of cases) {
		it(`${c.id}: advise mode -> safe flag(s) present, dangerous absent`, async () => {
			Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
			const argv = await driveAndReadArgv(c, "advise");
			if (c.adviseFlag) {
				for (const safe of c.adviseFlag) {
					ok(tokenIn(argv, safe), `${c.id}/advise: expected safe token '${safe}' in argv [${argv.join(" ")}]`);
				}
			}
			for (const danger of c.dangerous) {
				ok(!tokenIn(argv, danger), `${c.id}/advise: expected '${danger}' to be absent in [${argv.join(" ")}]`);
			}
		});

		it(`${c.id}: super mode without env -> dangerous absent`, async () => {
			Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
			const argv = await driveAndReadArgv(c, "super");
			for (const danger of c.dangerous) {
				ok(!tokenIn(argv, danger), `${c.id}/super-no-env: expected '${danger}' absent in [${argv.join(" ")}]`);
			}
		});

		it(`${c.id}: super mode with env=0 -> dangerous absent`, async () => {
			process.env[FULL_ACCESS_ENV] = "0";
			const argv = await driveAndReadArgv(c, "super");
			for (const danger of c.dangerous) {
				ok(!tokenIn(argv, danger), `${c.id}/super-env-0: expected '${danger}' absent in [${argv.join(" ")}]`);
			}
		});

		it(`${c.id}: super mode with env=1 -> dangerous PRESENT`, async () => {
			process.env[FULL_ACCESS_ENV] = "1";
			const argv = await driveAndReadArgv(c, "super");
			let foundDangerous = false;
			for (const danger of c.dangerous) {
				if (tokenIn(argv, danger)) foundDangerous = true;
			}
			ok(
				foundDangerous,
				`${c.id}/super-env-1: expected at least one of [${c.dangerous.join(",")}] in argv [${argv.join(" ")}]`,
			);
		});
	}
});

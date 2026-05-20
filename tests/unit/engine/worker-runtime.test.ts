import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";
import { startWorkerRun } from "../../../src/engine/worker-runtime.js";

const ORIGINAL_PATH = process.env.PATH;

const endpoint: EndpointDescriptor = {
	id: "claude-cli-test",
	runtime: "claude-code-cli",
};

const subprocessRuntime: RuntimeDescriptor = {
	id: "claude-code-cli",
	displayName: "Claude Code CLI",
	kind: "subprocess",
	tier: "cli",
	apiFamily: "subprocess-claude-code",
	auth: "cli",
	defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
	synthesizeModel: () => ({ id: "claude-sonnet-4-6", provider: "anthropic", baseUrl: "" }) as never,
};

describe("worker-runtime dynamic prompt routing", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-worker-runtime-"));
	});

	afterEach(() => {
		if (ORIGINAL_PATH === undefined) Reflect.deleteProperty(process.env, "PATH");
		else process.env.PATH = ORIGINAL_PATH;
		Reflect.deleteProperty(process.env, "CLIO_TEST_ARGV_FILE");
		rmSync(scratch, { recursive: true, force: true });
	});

	it("flattens dynamic prompt messages into subprocess task text in order", async () => {
		const argvFile = join(scratch, "argv.json");
		const bin = join(scratch, "claude");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"const fs = require('node:fs');",
				"fs.writeFileSync(process.env.CLIO_TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
				"process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');",
			].join("\n"),
			"utf8",
		);
		chmodSync(bin, 0o755);
		process.env.PATH = `${scratch}${delimiter}${ORIGINAL_PATH ?? ""}`;
		process.env.CLIO_TEST_ARGV_FILE = argvFile;

		const handle = startWorkerRun(
			{
				systemPrompt: "stable system",
				dynamicPromptMessages: [
					{ id: "memory", body: "# Memory\n\n- lesson", contentHash: "hash-memory" },
					{ id: "context", body: "# Context\n\nstate", contentHash: "hash-context" },
				],
				task: "complete task",
				endpoint,
				runtime: subprocessRuntime,
				wireModelId: "claude-sonnet-4-6",
				allowedTools: [],
			},
			() => undefined,
		);
		const result = await handle.promise;

		strictEqual(result.exitCode, 0);
		const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
		deepStrictEqual(argv.slice(-1), ["# Memory\n\n- lesson\n\n# Context\n\nstate\n\ncomplete task"]);
	});

	it("leaves subprocess task text unchanged when there are no dynamic prompt messages", async () => {
		const argvFile = join(scratch, "argv.json");
		const bin = join(scratch, "claude");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"const fs = require('node:fs');",
				"fs.writeFileSync(process.env.CLIO_TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
				"process.stdout.write('ok');",
			].join("\n"),
			"utf8",
		);
		chmodSync(bin, 0o755);
		process.env.PATH = `${scratch}${delimiter}${ORIGINAL_PATH ?? ""}`;
		process.env.CLIO_TEST_ARGV_FILE = argvFile;

		const handle = startWorkerRun(
			{
				systemPrompt: "",
				task: "plain task",
				endpoint,
				runtime: subprocessRuntime,
				wireModelId: "claude-sonnet-4-6",
				allowedTools: [],
			},
			() => undefined,
		);
		const result = await handle.promise;

		strictEqual(result.exitCode, 0);
		const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
		ok(argv.includes("plain task"));
		deepStrictEqual(argv.slice(-1), ["plain task"]);
	});
});

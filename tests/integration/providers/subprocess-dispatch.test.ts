import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AssistantMessage } from "@mariozechner/pi-ai";

import { startSubprocessWorkerRun } from "../../../src/engine/subprocess-runtime.js";
import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";
import type { AgentEvent, AgentMessage } from "../../../src/engine/types.js";

const ORIGINAL_PATH = process.env.PATH;

const endpoint: EndpointDescriptor = {
	id: "claude-cli-test",
	runtime: "claude-code-cli",
};

const runtime: RuntimeDescriptor = {
	id: "claude-code-cli",
	displayName: "Claude Code CLI",
	kind: "subprocess",
	apiFamily: "subprocess-claude-code",
	auth: "api-key",
	credentialsEnvVar: "ANTHROPIC_API_KEY",
	defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
	synthesizeModel: () =>
		({ id: "claude-sonnet-4-6", provider: "anthropic", baseUrl: "" }) as never,
};

function installShim(dir: string, script: string): string {
	const binPath = join(dir, "claude");
	writeFileSync(binPath, script, "utf8");
	chmodSync(binPath, 0o755);
	return binPath;
}

describe("subprocess-runtime startSubprocessWorkerRun", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-subprocess-"));
	});

	afterEach(() => {
		if (ORIGINAL_PATH === undefined) Reflect.deleteProperty(process.env, "PATH");
		else process.env.PATH = ORIGINAL_PATH;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("drives a shimmed binary to exit 0 and carries its stdout in the final assistant message", async () => {
		installShim(scratch, "#!/bin/sh\nexec /usr/bin/env node -e 'process.stdout.write(\"hello world\")'\n");
		process.env.PATH = `${scratch}${delimiter}${ORIGINAL_PATH ?? ""}`;

		const events: AgentEvent[] = [];
		const handle = startSubprocessWorkerRun(
			{
				systemPrompt: "",
				task: "hi",
				endpoint,
				runtime,
				wireModelId: "claude-sonnet-4-6",
			},
			(event) => events.push(event),
		);
		const result = await handle.promise;

		strictEqual(result.exitCode, 0, `expected exit code 0, got ${result.exitCode}`);
		const end = events.find((e) => e.type === "message_end") as
			| { type: "message_end"; message: AgentMessage }
			| undefined;
		ok(end, "message_end event missing");
		const content = end.message.content;
		const blocks = Array.isArray(content) ? content : [];
		const text = blocks
			.filter(
				(block: unknown): block is { type: "text"; text: string } =>
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text",
			)
			.map((b) => b.text)
			.join("");
		ok(text.includes("hello world"), `expected 'hello world' in message text, got '${text}'`);
	});

	it("resolves synchronously as exit 1 when the signal is pre-aborted before spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		const events: AgentEvent[] = [];
		const handle = startSubprocessWorkerRun(
			{
				systemPrompt: "",
				task: "hi",
				endpoint,
				runtime,
				wireModelId: "claude-sonnet-4-6",
				signal: controller.signal,
			},
			(event) => events.push(event),
		);
		const result = await handle.promise;
		strictEqual(result.exitCode, 1);
		const end = events.find((e) => e.type === "message_end") as
			| { type: "message_end"; message: AgentMessage }
			| undefined;
		ok(end);
		strictEqual((end.message as AssistantMessage).stopReason, "aborted");
	});
});

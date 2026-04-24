import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AssistantMessage } from "@mariozechner/pi-ai";

import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";
import {
	parseSubprocessOutput,
	planSubprocessInvocation,
	type SubprocessParserKind,
	startSubprocessWorkerRun,
} from "../../../src/engine/subprocess-runtime.js";
import type { AgentEvent, AgentMessage } from "../../../src/engine/types.js";

const ORIGINAL_PATH = process.env.PATH;

const endpoint: EndpointDescriptor = {
	id: "claude-cli-test",
	runtime: "claude-code-cli",
};

function runtime(id: string): RuntimeDescriptor {
	const apiFamilyById: Record<string, RuntimeDescriptor["apiFamily"]> = {
		"claude-code-cli": "subprocess-claude-code",
		"codex-cli": "subprocess-codex",
		"gemini-cli": "subprocess-gemini",
		"copilot-cli": "subprocess-copilot",
		"opencode-cli": "subprocess-opencode",
	};
	return {
		id,
		displayName: id,
		kind: "subprocess",
		apiFamily: apiFamilyById[id] ?? "subprocess-claude-code",
		auth: "cli",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: "claude-sonnet-4-6", provider: "anthropic", baseUrl: "" }) as never,
	};
}

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
				runtime: runtime("claude-code-cli"),
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
					typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
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
				runtime: runtime("claude-code-cli"),
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

	it("builds runtime-specific command plans", () => {
		const cases: Array<{
			id: string;
			binary: string;
			parser: SubprocessParserKind;
			requiredArgs: string[];
		}> = [
			{
				id: "claude-code-cli",
				binary: "claude",
				parser: "claude-code-stream-json",
				requiredArgs: ["--print", "--output-format", "stream-json", "--include-partial-messages"],
			},
			{ id: "codex-cli", binary: "codex", parser: "codex-jsonl", requiredArgs: ["exec", "--json", "-"] },
			{
				id: "gemini-cli",
				binary: "gemini",
				parser: "gemini-stream-json",
				requiredArgs: ["--output-format", "stream-json"],
			},
			{
				id: "copilot-cli",
				binary: "copilot",
				parser: "copilot-jsonl",
				requiredArgs: ["--output-format", "json"],
			},
			{ id: "opencode-cli", binary: "opencode", parser: "opencode-json", requiredArgs: ["--format", "json"] },
		];
		for (const item of cases) {
			const plan = planSubprocessInvocation({
				systemPrompt: "system",
				task: "task",
				endpoint: { ...endpoint, runtime: item.id },
				runtime: runtime(item.id),
				wireModelId: "model-1",
			});
			strictEqual(plan.binary, item.binary, item.id);
			strictEqual(plan.parser, item.parser, item.id);
			for (const arg of item.requiredArgs) ok(plan.args.includes(arg), `${item.id}: expected arg ${arg}`);
		}
	});

	it("maps permissions conservatively in command plans", () => {
		const advise = planSubprocessInvocation({
			systemPrompt: "",
			task: "task",
			endpoint,
			runtime: runtime("claude-code-cli"),
			wireModelId: "claude-sonnet-4-6",
			mode: "advise",
		});
		deepStrictEqual(
			[advise.permissionStrategy, advise.args[advise.args.indexOf("--permission-mode") + 1]],
			["read-only", "plan"],
		);

		const superCopilot = planSubprocessInvocation({
			systemPrompt: "",
			task: "task",
			endpoint: { ...endpoint, runtime: "copilot-cli" },
			runtime: runtime("copilot-cli"),
			wireModelId: "gpt-5.4",
			mode: "super",
		});
		strictEqual(superCopilot.permissionStrategy, "full-access");
		ok(superCopilot.args.includes("--allow-all-tools"));
	});

	it("parses structured CLI outputs into assistant text and usage", () => {
		const claudePlan = planSubprocessInvocation({
			systemPrompt: "",
			task: "task",
			endpoint,
			runtime: runtime("claude-code-cli"),
			wireModelId: "claude-sonnet-4-6",
		});
		const claude = parseSubprocessOutput(
			claudePlan,
			[
				JSON.stringify({
					type: "stream_event",
					event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
				}),
				JSON.stringify({
					type: "result",
					subtype: "success",
					result: "hello",
					usage: { input_tokens: 2, output_tokens: 3 },
					total_cost_usd: 0.01,
				}),
			].join("\n"),
			"",
			0,
		);
		strictEqual(claude.text, "hello");
		strictEqual(claude.usage?.input, 2);
		strictEqual(claude.usage?.output, 3);
		strictEqual(claude.usage?.cost.total, 0.01);

		const geminiPlan = planSubprocessInvocation({
			systemPrompt: "",
			task: "task",
			endpoint: { ...endpoint, runtime: "gemini-cli" },
			runtime: runtime("gemini-cli"),
			wireModelId: "gemini-2.5-pro",
		});
		const gemini = parseSubprocessOutput(
			geminiPlan,
			`${JSON.stringify({ type: "message", message: { content: "hi" } })}\n${JSON.stringify({ type: "result", result: "hi there" })}`,
			"",
			0,
		);
		strictEqual(gemini.text, "hi there");
	});
});

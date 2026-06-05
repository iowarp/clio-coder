import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";
import { mapClioModeToClaudePermission } from "../../../src/engine/claude-code-sdk-runtime.js";
import {
	parseSubprocessOutput,
	planSubprocessInvocation,
	type SubprocessParserKind,
	startSubprocessWorkerRun,
} from "../../../src/engine/subprocess-runtime.js";
import type { AgentEvent, AgentMessage } from "../../../src/engine/types.js";

const FULL_ACCESS_ENV = "CLIO_ALLOW_EXTERNAL_FULL_ACCESS";

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
		const content = "content" in end.message ? end.message.content : [];
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

	describe("permission-strategy matrix (mode x CLIO_ALLOW_EXTERNAL_FULL_ACCESS)", () => {
		const originalFullAccess = process.env[FULL_ACCESS_ENV];

		afterEach(() => {
			if (originalFullAccess === undefined) Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
			else process.env[FULL_ACCESS_ENV] = originalFullAccess;
		});

		interface CliCase {
			id: string;
			model: string;
			// Flag tokens that must be absent unless full-access is granted.
			dangerousFlags: ReadonlyArray<string>;
			// Specific argv sequences expected in each cell. `null` means "absent".
			cells: {
				default: ReadonlyArray<string> | null;
				advise: ReadonlyArray<string> | null;
				superSupervised: ReadonlyArray<string> | null;
				superFullAccess: ReadonlyArray<string>;
			};
		}

		const cliCases: ReadonlyArray<CliCase> = [
			{
				id: "claude-code-cli",
				model: "claude-sonnet-4-6",
				dangerousFlags: ["bypassPermissions"],
				cells: {
					default: ["--permission-mode", "default"],
					advise: ["--permission-mode", "plan"],
					superSupervised: ["--permission-mode", "default"],
					superFullAccess: ["--permission-mode", "bypassPermissions"],
				},
			},
			{
				id: "codex-cli",
				model: "gpt-5.4",
				dangerousFlags: ["danger-full-access", "--ask-for-approval"],
				cells: {
					default: null,
					advise: ["--sandbox", "read-only"],
					superSupervised: null,
					superFullAccess: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
				},
			},
			{
				id: "gemini-cli",
				model: "gemini-2.5-pro",
				dangerousFlags: ["yolo"],
				cells: {
					default: ["--approval-mode", "default"],
					advise: ["--approval-mode", "plan"],
					superSupervised: ["--approval-mode", "default"],
					superFullAccess: ["--approval-mode", "yolo"],
				},
			},
			{
				id: "copilot-cli",
				model: "gpt-5.4",
				dangerousFlags: ["--allow-all-tools"],
				cells: {
					default: null,
					advise: ["--mode", "plan"],
					superSupervised: null,
					superFullAccess: ["--allow-all-tools"],
				},
			},
			{
				id: "opencode-cli",
				model: "anthropic/claude-sonnet-4-6",
				dangerousFlags: ["--dangerously-skip-permissions"],
				cells: {
					default: null,
					advise: null,
					superSupervised: null,
					superFullAccess: ["--dangerously-skip-permissions"],
				},
			},
		];

		function planFor(id: string, model: string, mode: "default" | "advise" | "super") {
			return planSubprocessInvocation({
				systemPrompt: "",
				task: "task",
				endpoint: { ...endpoint, runtime: id },
				runtime: runtime(id),
				wireModelId: model,
				mode,
			});
		}

		function assertContainsSequence(haystack: ReadonlyArray<string>, needle: ReadonlyArray<string>, label: string) {
			outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
				for (let j = 0; j < needle.length; j++) {
					if (haystack[i + j] !== needle[j]) continue outer;
				}
				return;
			}
			throw new Error(`${label}: expected argv to contain sequence [${needle.join(" ")}], got [${haystack.join(" ")}]`);
		}

		function assertAbsent(haystack: ReadonlyArray<string>, tokens: ReadonlyArray<string>, label: string) {
			for (const token of tokens) {
				ok(!haystack.includes(token), `${label}: expected token '${token}' to be absent, got [${haystack.join(" ")}]`);
			}
		}

		for (const c of cliCases) {
			it(`${c.id}: default mode -> supervised, no dangerous flags`, () => {
				Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
				const plan = planFor(c.id, c.model, "default");
				strictEqual(plan.permissionStrategy, "supervised", c.id);
				assertAbsent(plan.args, c.dangerousFlags, `${c.id}/default`);
				if (c.cells.default) assertContainsSequence(plan.args, c.cells.default, `${c.id}/default`);
			});

			it(`${c.id}: advise mode -> read-only with safe flags, no dangerous flags`, () => {
				Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
				const plan = planFor(c.id, c.model, "advise");
				strictEqual(plan.permissionStrategy, "read-only", c.id);
				assertAbsent(plan.args, c.dangerousFlags, `${c.id}/advise`);
				if (c.cells.advise) assertContainsSequence(plan.args, c.cells.advise, `${c.id}/advise`);
			});

			it(`${c.id}: super mode without env -> supervised, no dangerous flags`, () => {
				Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
				const plan = planFor(c.id, c.model, "super");
				strictEqual(plan.permissionStrategy, "supervised", c.id);
				assertAbsent(plan.args, c.dangerousFlags, `${c.id}/super-no-env`);
				if (c.cells.superSupervised) assertContainsSequence(plan.args, c.cells.superSupervised, `${c.id}/super-no-env`);
			});

			it(`${c.id}: super mode with env=0 stays supervised`, () => {
				process.env[FULL_ACCESS_ENV] = "0";
				const plan = planFor(c.id, c.model, "super");
				strictEqual(plan.permissionStrategy, "supervised", c.id);
				assertAbsent(plan.args, c.dangerousFlags, `${c.id}/super-env-0`);
			});

			it(`${c.id}: super mode with env=1 -> full-access with dangerous flags`, () => {
				process.env[FULL_ACCESS_ENV] = "1";
				const plan = planFor(c.id, c.model, "super");
				strictEqual(plan.permissionStrategy, "full-access", c.id);
				assertContainsSequence(plan.args, c.cells.superFullAccess, `${c.id}/super-env-1`);
			});
		}

		it("claude-code-sdk: maps modes correctly and gates bypassPermissions on env=1", () => {
			Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
			const def = mapClioModeToClaudePermission("default", undefined);
			strictEqual(def.permissionMode, "default");
			strictEqual(def.allowDangerouslySkipPermissions, false);

			const advise = mapClioModeToClaudePermission("advise", undefined);
			strictEqual(advise.permissionMode, "plan");
			strictEqual(advise.allowDangerouslySkipPermissions, false);

			const superNoEnv = mapClioModeToClaudePermission("super", undefined);
			strictEqual(superNoEnv.permissionMode, "default");
			strictEqual(superNoEnv.allowDangerouslySkipPermissions, false);

			process.env[FULL_ACCESS_ENV] = "1";
			const superEnv = mapClioModeToClaudePermission("super", undefined);
			strictEqual(superEnv.permissionMode, "bypassPermissions");
			strictEqual(superEnv.allowDangerouslySkipPermissions, true);

			process.env[FULL_ACCESS_ENV] = "0";
			const superEnvZero = mapClioModeToClaudePermission("super", undefined);
			strictEqual(superEnvZero.permissionMode, "default");
			strictEqual(superEnvZero.allowDangerouslySkipPermissions, false);
		});

		// Sanity: deepStrictEqual sanity for the existing pair (kept from prior coverage).
		it("legacy: claude-code-cli advise pin still matches", () => {
			Reflect.deleteProperty(process.env, FULL_ACCESS_ENV);
			const plan = planFor("claude-code-cli", "claude-sonnet-4-6", "advise");
			deepStrictEqual(
				[plan.permissionStrategy, plan.args[plan.args.indexOf("--permission-mode") + 1]],
				["read-only", "plan"],
			);
		});
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

	it("reads gemini per-call token counts from `stats` (modern CLI shape)", () => {
		const plan = planSubprocessInvocation({
			systemPrompt: "",
			task: "task",
			endpoint: { ...endpoint, runtime: "gemini-cli" },
			runtime: runtime("gemini-cli"),
			wireModelId: "gemini-3-flash-preview",
		});
		const parsed = parseSubprocessOutput(
			plan,
			[
				JSON.stringify({ type: "message", message: { role: "assistant", content: "OK" } }),
				JSON.stringify({
					type: "result",
					status: "success",
					stats: { total_tokens: 10345, input_tokens: 9948, output_tokens: 28, cached: 0 },
				}),
			].join("\n"),
			"",
			0,
		);
		strictEqual(parsed.usage?.input, 9948);
		strictEqual(parsed.usage?.output, 28);
		strictEqual(parsed.usage?.totalTokens, 10345);
	});
});

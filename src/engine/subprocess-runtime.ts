/**
 * CLI-agent subprocess worker. This path is still adapted to one worker run,
 * but each CLI now has a typed command plan and parser so session/resume and
 * streaming support can grow without pretending every target is the same
 * stdout-only executable.
 */

import { type ChildProcess, spawn } from "node:child_process";

import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import type { ToolName } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type { EndpointDescriptor, RuntimeDescriptor } from "../domains/providers/index.js";
import type { AgentEvent, AgentMessage } from "./types.js";

export interface SubprocessWorkerInput {
	systemPrompt: string;
	task: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	apiKey?: string;
	mode?: ModeName;
	allowedTools?: ReadonlyArray<ToolName>;
	sessionId?: string;
	cwd?: string;
	signal?: AbortSignal;
}

export interface SubprocessWorkerResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface SubprocessWorkerHandle {
	promise: Promise<SubprocessWorkerResult>;
	abort(): void;
}

export type SubprocessParserKind =
	| "plain-text"
	| "claude-code-stream-json"
	| "codex-jsonl"
	| "gemini-stream-json"
	| "copilot-jsonl"
	| "opencode-json";

export type SubprocessResumeStrategy =
	| { type: "none" }
	| { type: "claude-resume"; sessionId: string }
	| { type: "codex-resume"; sessionId: string }
	| { type: "gemini-resume"; sessionId: string }
	| { type: "copilot-resume"; sessionId: string }
	| { type: "opencode-session"; sessionId: string };

export interface SubprocessRuntimePlan {
	runtimeId: string;
	binary: string;
	args: string[];
	stdin?: string;
	cwd?: string;
	envKeyName?: string;
	provider: string;
	api: string;
	parser: SubprocessParserKind;
	resumeStrategy: SubprocessResumeStrategy;
	permissionStrategy: "read-only" | "supervised" | "full-access";
	modelArgument: "flag" | "stdin" | "provider-model";
	environmentPolicy: "inherit" | "api-key-env";
	headlessCommand: string;
}

export interface ParsedSubprocessOutput {
	text: string;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
	usage?: Usage;
}

export function planSubprocessInvocation(input: SubprocessWorkerInput): SubprocessRuntimePlan {
	const { runtime, wireModelId, task, systemPrompt } = input;
	const permissionStrategy = permissionStrategyForMode(input.mode);
	const resumeStrategy = resumeStrategyFor(runtime.id, input.sessionId);
	switch (runtime.id) {
		case "claude-code-cli": {
			const args = ["--print", "--model", wireModelId, "--output-format", "stream-json", "--include-partial-messages"];
			args.push("--permission-mode", claudePermissionMode(permissionStrategy));
			if (resumeStrategy.type === "claude-resume") args.push("--resume", resumeStrategy.sessionId);
			if (systemPrompt.length > 0) {
				args.push("--append-system-prompt", systemPrompt);
			}
			args.push(task);
			return {
				runtimeId: runtime.id,
				binary: "claude",
				args,
				provider: "anthropic",
				api: "subprocess-claude-code",
				parser: "claude-code-stream-json",
				resumeStrategy,
				permissionStrategy,
				modelArgument: "flag",
				environmentPolicy: runtime.credentialsEnvVar ? "api-key-env" : "inherit",
				headlessCommand: runtime.headlessCommand ?? "claude --print --output-format stream-json <prompt>",
				...(runtime.credentialsEnvVar ? { envKeyName: runtime.credentialsEnvVar } : {}),
			};
		}
		case "codex-cli": {
			const args =
				resumeStrategy.type === "codex-resume"
					? ["exec", "resume", resumeStrategy.sessionId, "--json", "-m", wireModelId]
					: ["exec", "--json", "-m", wireModelId];
			if (input.cwd) args.push("--cd", input.cwd);
			if (permissionStrategy === "read-only") args.push("--sandbox", "read-only");
			if (permissionStrategy === "full-access")
				args.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
			const stdinChunks: string[] = [];
			if (systemPrompt.length > 0) stdinChunks.push(systemPrompt, "");
			stdinChunks.push(task);
			return {
				runtimeId: runtime.id,
				binary: "codex",
				args: [...args, "-"],
				stdin: stdinChunks.join("\n"),
				provider: "openai",
				api: "subprocess-codex",
				parser: "codex-jsonl",
				resumeStrategy,
				permissionStrategy,
				modelArgument: "stdin",
				environmentPolicy: runtime.credentialsEnvVar ? "api-key-env" : "inherit",
				headlessCommand: runtime.headlessCommand ?? "codex exec --json -m <model> -",
				...(runtime.credentialsEnvVar ? { envKeyName: runtime.credentialsEnvVar } : {}),
			};
		}
		case "gemini-cli": {
			const args = ["-p", task, "-m", wireModelId, "--output-format", "stream-json"];
			args.push("--approval-mode", geminiApprovalMode(permissionStrategy));
			if (resumeStrategy.type === "gemini-resume") args.push("--resume", resumeStrategy.sessionId);
			const plan: SubprocessRuntimePlan = {
				runtimeId: runtime.id,
				binary: "gemini",
				args,
				provider: "google",
				api: "subprocess-gemini",
				parser: "gemini-stream-json",
				resumeStrategy,
				permissionStrategy,
				modelArgument: "flag",
				environmentPolicy: runtime.credentialsEnvVar ? "api-key-env" : "inherit",
				headlessCommand: runtime.headlessCommand ?? "gemini --prompt <prompt> --output-format stream-json",
			};
			if (systemPrompt.length > 0) plan.stdin = systemPrompt;
			if (runtime.credentialsEnvVar) plan.envKeyName = runtime.credentialsEnvVar;
			return plan;
		}
		case "copilot-cli": {
			const args = ["-p", task, "--model", wireModelId, "--output-format", "json"];
			if (permissionStrategy === "full-access") args.push("--allow-all-tools");
			if (permissionStrategy === "read-only") args.push("--mode", "plan");
			if (resumeStrategy.type === "copilot-resume") args.push(`--resume=${resumeStrategy.sessionId}`);
			return {
				runtimeId: runtime.id,
				binary: "copilot",
				args,
				provider: "github-copilot",
				api: "subprocess-copilot",
				parser: "copilot-jsonl",
				resumeStrategy,
				permissionStrategy,
				modelArgument: "flag",
				environmentPolicy: runtime.credentialsEnvVar ? "api-key-env" : "inherit",
				headlessCommand: runtime.headlessCommand ?? "copilot --prompt <prompt> --output-format json",
				...(runtime.credentialsEnvVar ? { envKeyName: runtime.credentialsEnvVar } : {}),
			};
		}
		case "opencode-cli": {
			const args = ["run", "--model", wireModelId, "--format", "json"];
			if (permissionStrategy === "full-access") args.push("--dangerously-skip-permissions");
			if (resumeStrategy.type === "opencode-session") args.push("--session", resumeStrategy.sessionId);
			args.push(task);
			return {
				runtimeId: runtime.id,
				binary: "opencode",
				args,
				provider: "opencode",
				api: "subprocess-opencode",
				parser: "opencode-json",
				resumeStrategy,
				permissionStrategy,
				modelArgument: "provider-model",
				environmentPolicy: runtime.credentialsEnvVar ? "api-key-env" : "inherit",
				headlessCommand: runtime.headlessCommand ?? "opencode run --model <provider/model> --format json <prompt>",
				...(runtime.credentialsEnvVar ? { envKeyName: runtime.credentialsEnvVar } : {}),
			};
		}
		default:
			throw new Error(`subprocess-runtime: unknown runtime id '${runtime.id}'`);
	}
}

function buildAssistantMessage(
	plan: SubprocessRuntimePlan,
	wireModelId: string,
	text: string,
	stopReason: AssistantMessage["stopReason"],
	usage: Usage = emptyUsage(),
): AssistantMessage {
	return {
		role: "assistant",
		content: text.length > 0 ? [{ type: "text", text }] : [],
		api: plan.api,
		provider: plan.provider,
		model: wireModelId,
		usage,
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

export function parseSubprocessOutput(
	plan: SubprocessRuntimePlan,
	stdout: string,
	stderr: string,
	exitCode: number,
	aborted = false,
): ParsedSubprocessOutput {
	if (aborted) return { text: "", stopReason: "aborted" };
	const parsed = parseByKind(plan.parser, stdout);
	const errorText = [...parsed.errors, stderr.trim()].filter((value) => value.length > 0).join("\n");
	const stopReason: AssistantMessage["stopReason"] = exitCode === 0 && errorText.length === 0 ? "stop" : "error";
	const text = parsed.text.trim().length > 0 ? parsed.text : stdout;
	return {
		text,
		stopReason,
		...(errorText.length > 0 ? { errorMessage: errorText } : {}),
		...(parsed.usage ? { usage: parsed.usage } : {}),
	};
}

export function parseJsonlLines(output: string): unknown[] {
	const events: unknown[] = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			events.push({ type: "text", text: line });
		}
	}
	return events;
}

interface ParserAccumulator {
	text: string;
	errors: string[];
	usage?: Usage;
}

function parseByKind(parser: SubprocessParserKind, stdout: string): ParserAccumulator {
	if (parser === "plain-text") return { text: stdout, errors: [] };
	const events = parser === "opencode-json" ? parseJsonEvents(stdout) : parseJsonlLines(stdout);
	const acc: ParserAccumulator = { text: "", errors: [] };
	for (const event of events) {
		parseStructuredEvent(parser, event, acc);
	}
	return acc;
}

function parseJsonEvents(output: string): unknown[] {
	const trimmed = output.trim();
	if (trimmed.length === 0) return [];
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return parseJsonlLines(output);
	}
}

function parseStructuredEvent(parser: SubprocessParserKind, event: unknown, acc: ParserAccumulator): void {
	if (!isRecord(event)) {
		if (typeof event === "string") appendText(acc, event);
		return;
	}
	const type = typeof event.type === "string" ? event.type : "";
	if (type === "text" && typeof event.text === "string") {
		appendText(acc, event.text);
		return;
	}
	if (type === "error" || type.endsWith(".failed")) {
		const message = extractFirstString(event, ["message", "error", "detail"]);
		if (message) acc.errors.push(message);
	}
	if (parser === "claude-code-stream-json") parseClaudeCliEvent(event, acc);
	else if (parser === "codex-jsonl") parseCodexEvent(event, acc);
	else if (parser === "gemini-stream-json") parseGeminiEvent(event, acc);
	else if (parser === "copilot-jsonl") parseCopilotEvent(event, acc);
	else if (parser === "opencode-json") parseOpenCodeEvent(event, acc);
}

function parseClaudeCliEvent(event: Record<string, unknown>, acc: ParserAccumulator): void {
	if (event.type === "stream_event" && isRecord(event.event)) {
		const streamEvent = event.event;
		if (streamEvent.type === "content_block_delta" && isRecord(streamEvent.delta)) {
			const delta = streamEvent.delta;
			appendText(acc, extractFirstString(delta, ["text", "thinking"]) ?? "");
		}
		return;
	}
	if (event.type === "assistant" && isRecord(event.message)) {
		appendText(acc, extractClaudeContent(event.message.content));
		setMergedUsage(acc, normalizeUsage(event.message.usage, undefined));
		return;
	}
	if (event.type === "result") {
		const result = extractFirstString(event, ["result"]);
		if (result && result.length > 0) acc.text = result;
		setMergedUsage(acc, normalizeUsage(event.usage, numberField(event, "total_cost_usd")));
		if (event.subtype !== "success") {
			const errors = Array.isArray(event.errors)
				? event.errors.filter((value): value is string => typeof value === "string")
				: [];
			acc.errors.push(...errors);
		}
	}
	if (event.type === "auth_status" && typeof event.error === "string") acc.errors.push(event.error);
}

function parseCodexEvent(event: Record<string, unknown>, acc: ParserAccumulator): void {
	const type = typeof event.type === "string" ? event.type : "";
	if (type === "item.completed" || type === "item.updated" || type === "item.delta") {
		appendText(acc, extractTextDeep(event.item ?? event.delta ?? event));
	}
	if (type === "turn.completed") {
		appendText(acc, extractTextDeep(event.turn ?? event));
		setMergedUsage(acc, normalizeUsage(event.usage, undefined));
	}
	if (type === "turn.failed" || type === "error") {
		const message = extractFirstString(event, ["message", "error"]);
		if (message) acc.errors.push(message);
	}
}

function parseGeminiEvent(event: Record<string, unknown>, acc: ParserAccumulator): void {
	if (event.type === "message") appendText(acc, extractTextDeep(event.message ?? event.content ?? event));
	if (event.type === "result") {
		const result = extractTextDeep(event.result ?? event.response ?? event);
		if (result.length > 0) acc.text = result;
		setMergedUsage(acc, normalizeUsage(event.usage, undefined));
	}
	if (event.type === "error") {
		const message = extractFirstString(event, ["message", "error"]);
		if (message) acc.errors.push(message);
	}
}

function parseCopilotEvent(event: Record<string, unknown>, acc: ParserAccumulator): void {
	appendText(acc, extractTextDeep(event.delta ?? event.message ?? event.response ?? event.content ?? ""));
	if (event.type === "result" || event.type === "turn.completed") {
		const result = extractTextDeep(event.result ?? event.output ?? event);
		if (result.length > 0) acc.text = result;
		setMergedUsage(acc, normalizeUsage(event.usage, undefined));
	}
}

function parseOpenCodeEvent(event: Record<string, unknown>, acc: ParserAccumulator): void {
	appendText(acc, extractTextDeep(event.part ?? event.message ?? event.delta ?? event.content ?? ""));
	if (event.type === "result" || event.type === "session.result") {
		const result = extractTextDeep(event.result ?? event.output ?? event);
		if (result.length > 0) acc.text = result;
		setMergedUsage(acc, normalizeUsage(event.usage, undefined));
	}
}

export function startSubprocessWorkerRun(
	input: SubprocessWorkerInput,
	emit: (event: AgentEvent) => void,
): SubprocessWorkerHandle {
	const plan = planSubprocessInvocation(input);
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (plan.envKeyName && input.apiKey && input.apiKey.length > 0) {
		env[plan.envKeyName] = input.apiKey;
	}

	let child: ChildProcess;
	let aborted = false;
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];

	const promise = new Promise<SubprocessWorkerResult>((resolve) => {
		emit({ type: "agent_start" });

		if (input.signal?.aborted) {
			aborted = true;
			const message = buildAssistantMessage(plan, input.wireModelId, "", "aborted");
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			resolve({ messages: [message], exitCode: 1 });
			return;
		}

		try {
			const spawnOptions: Parameters<typeof spawn>[2] = { env, stdio: ["pipe", "pipe", "pipe"] };
			if (plan.cwd) spawnOptions.cwd = plan.cwd;
			child = spawn(plan.binary, plan.args, spawnOptions);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[subprocess-runtime] spawn ${plan.binary} failed: ${msg}\n`);
			const message = buildAssistantMessage(plan, input.wireModelId, "", "error");
			const withError = { ...message, errorMessage: msg };
			emit({ type: "message_end", message: withError });
			emit({ type: "agent_end", messages: [withError] });
			resolve({ messages: [withError], exitCode: 1 });
			return;
		}

		const onAbort = () => {
			aborted = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// child may already be gone
			}
		};
		input.signal?.addEventListener("abort", onAbort);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		child.on("error", (err) => {
			process.stderr.write(`[subprocess-runtime] ${plan.binary} error: ${err.message}\n`);
		});

		if (plan.stdin !== undefined && child.stdin) {
			child.stdin.write(plan.stdin);
			child.stdin.end();
		} else if (child.stdin) {
			child.stdin.end();
		}

		child.on("close", (code) => {
			input.signal?.removeEventListener("abort", onAbort);
			const text = Buffer.concat(stdoutChunks).toString("utf8");
			const errText = Buffer.concat(stderrChunks).toString("utf8");
			if (errText.length > 0) {
				process.stderr.write(`[subprocess-runtime] ${plan.binary} stderr: ${errText}`);
			}
			const exitCode = code ?? 1;
			const parsed = parseSubprocessOutput(plan, text, errText, exitCode, aborted);
			const message = buildAssistantMessage(
				plan,
				input.wireModelId,
				parsed.text,
				parsed.stopReason,
				parsed.usage ?? emptyUsage(),
			);
			const finalMessage =
				parsed.errorMessage && parsed.errorMessage.length > 0 ? { ...message, errorMessage: parsed.errorMessage } : message;
			emit({ type: "message_end", message: finalMessage });
			emit({ type: "agent_end", messages: [finalMessage] });
			resolve({ messages: [finalMessage], exitCode: aborted ? 1 : exitCode });
		});
	});

	return {
		promise,
		abort: () => {
			if (!child) return;
			aborted = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore; close handler still resolves
			}
		},
	};
}

function permissionStrategyForMode(mode: ModeName | undefined): SubprocessRuntimePlan["permissionStrategy"] {
	switch (mode) {
		case "advise":
			return "read-only";
		case "super":
			return "full-access";
		default:
			return "supervised";
	}
}

function resumeStrategyFor(runtimeId: string, sessionId: string | undefined): SubprocessResumeStrategy {
	if (!sessionId) return { type: "none" };
	switch (runtimeId) {
		case "claude-code-cli":
			return { type: "claude-resume", sessionId };
		case "codex-cli":
			return { type: "codex-resume", sessionId };
		case "gemini-cli":
			return { type: "gemini-resume", sessionId };
		case "copilot-cli":
			return { type: "copilot-resume", sessionId };
		case "opencode-cli":
			return { type: "opencode-session", sessionId };
		default:
			return { type: "none" };
	}
}

function claudePermissionMode(strategy: SubprocessRuntimePlan["permissionStrategy"]): string {
	switch (strategy) {
		case "read-only":
			return "plan";
		case "full-access":
			return "bypassPermissions";
		default:
			return "default";
	}
}

function geminiApprovalMode(strategy: SubprocessRuntimePlan["permissionStrategy"]): string {
	switch (strategy) {
		case "read-only":
			return "plan";
		case "full-access":
			return "yolo";
		default:
			return "default";
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mergeUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
	if (!current) return next;
	if (!next) return current;
	return {
		input: current.input + next.input,
		output: current.output + next.output,
		cacheRead: current.cacheRead + next.cacheRead,
		cacheWrite: current.cacheWrite + next.cacheWrite,
		totalTokens: current.totalTokens + next.totalTokens,
		cost: {
			input: current.cost.input + next.cost.input,
			output: current.cost.output + next.cost.output,
			cacheRead: current.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
			total: current.cost.total + next.cost.total,
		},
	};
}

function setMergedUsage(acc: ParserAccumulator, next: Usage | undefined): void {
	const merged = mergeUsage(acc.usage, next);
	if (merged) acc.usage = merged;
}

function normalizeUsage(raw: unknown, totalCostUsd: number | undefined): Usage | undefined {
	if (!isRecord(raw)) {
		if (totalCostUsd === undefined) return undefined;
		return { ...emptyUsage(), cost: { ...emptyUsage().cost, total: totalCostUsd } };
	}
	const input = numberField(raw, "input_tokens") ?? numberField(raw, "inputTokens") ?? 0;
	const output = numberField(raw, "output_tokens") ?? numberField(raw, "outputTokens") ?? 0;
	const cacheRead = numberField(raw, "cache_read_input_tokens") ?? numberField(raw, "cacheReadInputTokens") ?? 0;
	const cacheWrite =
		numberField(raw, "cache_creation_input_tokens") ?? numberField(raw, "cacheCreationInputTokens") ?? 0;
	const totalTokens =
		numberField(raw, "total_tokens") ?? numberField(raw, "totalTokens") ?? input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCostUsd ?? 0 },
	};
}

function extractClaudeContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((block) => extractTextDeep(block)).join("");
}

function extractTextDeep(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractTextDeep).join("");
	if (!isRecord(value)) return "";
	const direct = extractFirstString(value, ["text", "content", "delta", "result", "output", "response"]);
	if (direct) return direct;
	for (const key of ["message", "part", "parts", "content", "children"]) {
		const nested = value[key];
		const text = extractTextDeep(nested);
		if (text.length > 0) return text;
	}
	return "";
}

function extractFirstString(value: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return null;
}

function appendText(acc: ParserAccumulator, text: string): void {
	if (text.length === 0) return;
	acc.text += text;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const raw = value[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

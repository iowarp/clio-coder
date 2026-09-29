import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { buildSafeToolEnv, resolveSafeCwd, runCommandVector } from "../../core/safe-exec.js";
import { piCliMode } from "../../domains/providers/runtimes/external-cli-policy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import type { AgentMessage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";
import type { JsonlCliConnector, JsonlCliDependencies, JsonlCliState } from "./jsonl-runner.js";
import { cliEventRecord, emptyCliUsage, finiteUsage, startJsonlCliRun } from "./jsonl-runner.js";

export const PI_CLI_DEFAULT_MODEL = "pi-cli-default";

export { piCliMode } from "../../domains/providers/runtimes/external-cli-policy.js";

export function buildPiCliArgs(input: WorkerRunInput, builtinLlamaCpp = false): string[] {
	assertToolProfileEnforceable(input.toolProfile, "pi-cli");
	const mode = piCliMode(input.readOnly === true);
	const args = ["--print", "--mode", "json", "--no-session", "--no-extensions", "--no-approve"];
	if (builtinLlamaCpp) args.push("-e", "builtin:llama.cpp");
	if (mode === "read-only") args.push("--tools", "read,grep,find,ls");
	if (input.wireModelId.trim() && input.wireModelId !== PI_CLI_DEFAULT_MODEL) {
		args.push("--model", input.wireModelId.trim());
	}
	return args;
}

const builtinProviderProbes = new Map<string, Promise<boolean>>();

function resolvePiBinary(binary: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
	const names =
		process.platform === "win32" && path.extname(binary) === ""
			? [binary, ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((extension) => binary + extension)]
			: [binary];
	const directories = binary.includes("/") || binary.includes("\\") ? [cwd] : (env.PATH ?? "").split(path.delimiter);
	for (const directory of directories) {
		for (const name of names) {
			const candidate = path.resolve(cwd, directory, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// An inaccessible PATH entry cannot prove which Pi version will run.
			}
		}
	}
	return null;
}

function hasBuiltinLlamaCpp(binary: string, cwd: string, sourceEnv: NodeJS.ProcessEnv): Promise<boolean> {
	const held = builtinProviderProbes.get(binary);
	if (held !== undefined) return held;
	// Unknown versions retain the established flags, so a failed probe cannot prevent a worker from starting.
	const probe = (async () => {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(buildSafeToolEnv({}, sourceEnv))) {
			if (value !== undefined) env[key] = value;
		}
		const result = await runCommandVector(binary, ["--version"], {
			cwd,
			workspaceRoot: cwd,
			env,
			timeoutMs: 2_000,
			maxOutputBytes: 4_096,
			killGraceMs: 0,
		});
		if (result.exitCode !== 0 || result.aborted || result.timedOut || result.outputCapped) return false;
		const version = /^(?:pi\s+(?:version\s+)?)?v?(\d+)\.(\d+)\.\d+(?:[-+][\w.-]+)?$/iu.exec(result.stdout.trim());
		return version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 99);
	})().catch(() => false);
	builtinProviderProbes.set(binary, probe);
	return probe;
}

export function startPiCliWorkerRun(
	input: WorkerRunInput,
	emit: WorkerEventEmit,
	dependencies: JsonlCliDependencies = {},
): WorkerRunHandle {
	assertToolProfileEnforceable(input.toolProfile, "pi-cli");
	piCliMode(input.readOnly === true);
	const cwd = resolveSafeCwd(input.cwd, dependencies.workspaceRoot ?? process.cwd());
	const sourceEnv = dependencies.environment ?? process.env;
	const binary = resolvePiBinary(dependencies.binary ?? PI_CLI_CONNECTOR.binary, cwd, sourceEnv);
	const controller = new AbortController();
	const abort = (): void => controller.abort(input.signal?.reason);
	input.signal?.addEventListener("abort", abort, { once: true });
	if (input.signal?.aborted) abort();
	let cancelProbeWait: (() => void) | undefined;
	const promise = (async (): Promise<WorkerRunResult> => {
		try {
			const cancelled = new Promise<boolean>((resolve) => {
				cancelProbeWait = () => resolve(false);
				controller.signal.addEventListener("abort", cancelProbeWait, { once: true });
				if (controller.signal.aborted) cancelProbeWait();
			});
			const builtinLlamaCpp = await Promise.race([
				binary === null || controller.signal.aborted ? Promise.resolve(false) : hasBuiltinLlamaCpp(binary, cwd, sourceEnv),
				cancelled,
			]);
			if (controller.signal.aborted) {
				const message: AgentMessage & { role: "assistant" } = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					api: "external-agent-subprocess",
					provider: "pi-cli",
					model: input.wireModelId,
					usage: Object.assign(emptyCliUsage(), {
						clioExternal: { tokenUsage: "missing", cost: "missing", sessionId: null },
					}),
					stopReason: "aborted",
					errorMessage: "Pi CLI run was cancelled",
					timestamp: Date.now(),
				};
				emit({ type: "agent_start" });
				emit({ type: "message_start", message });
				emit({ type: "message_end", message });
				emit({ type: "agent_end", messages: [message] });
				return { messages: [message], exitCode: 1 };
			}
			return await startJsonlCliRun(
				{ ...PI_CLI_CONNECTOR, args: (run) => buildPiCliArgs(run, builtinLlamaCpp) },
				{ ...input, signal: controller.signal },
				emit,
				{ ...dependencies, ...(binary === null ? {} : { binary }) },
			).promise;
		} finally {
			if (cancelProbeWait !== undefined) controller.signal.removeEventListener("abort", cancelProbeWait);
			input.signal?.removeEventListener("abort", abort);
		}
	})();
	return { promise, abort };
}

function textFromContent(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((entry) => {
			const block = cliEventRecord(entry);
			return block?.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

function piUsage(raw: unknown): JsonlCliState["usage"] {
	const observed = cliEventRecord(raw);
	if (!observed) return null;
	const usage = emptyCliUsage();
	usage.input = finiteUsage(observed.input);
	usage.output = finiteUsage(observed.output);
	usage.cacheRead = finiteUsage(observed.cacheRead);
	usage.cacheWrite = finiteUsage(observed.cacheWrite);
	usage.totalTokens =
		finiteUsage(observed.totalTokens) || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = cliEventRecord(observed.cost);
	usage.cost = {
		input: finiteUsage(cost?.input),
		output: finiteUsage(cost?.output),
		cacheRead: finiteUsage(cost?.cacheRead),
		cacheWrite: finiteUsage(cost?.cacheWrite),
		total: finiteUsage(cost?.total),
	};
	return usage;
}

export const PI_CLI_CONNECTOR: JsonlCliConnector = {
	runtimeId: "pi-cli",
	label: "Pi CLI",
	binary: "pi",
	configDirEnv: "PI_CODING_AGENT_DIR",
	args: buildPiCliArgs,
	prompt(input) {
		return [
			input.systemPrompt.trim(),
			...(input.dynamicPromptMessages ?? []).map((message) => message.body.trim()),
			input.task.trim(),
		]
			.filter(Boolean)
			.join("\n\n");
	},
	requireTerminalEvent: true,
	onEvent(event, state, append) {
		if (event.type === "session" && typeof event.id === "string") {
			state.sessionId = event.id;
		} else if (event.type === "message_end") {
			const message = cliEventRecord(event.message);
			if (message?.role !== "assistant") return;
			const text = textFromContent(message.content);
			if (text) append(`${state.text ? "\n" : ""}${text}`);
			if (typeof message.model === "string") state.model = message.model;
			if (typeof message.responseId === "string") state.responseId = message.responseId;
			state.usage = piUsage(message.usage);
			const rawUsage = cliEventRecord(message.usage);
			state.usageReported =
				rawUsage !== null &&
				[rawUsage.input, rawUsage.output, rawUsage.totalTokens].some(
					(value) => typeof value === "number" && Number.isFinite(value),
				);
			const rawCost = cliEventRecord(rawUsage?.cost);
			state.costReported = typeof rawCost?.total === "number" && Number.isFinite(rawCost.total);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				state.error =
					typeof message.errorMessage === "string" ? message.errorMessage : "Pi returned a failed assistant turn";
			}
		} else if (event.type === "agent_settled") {
			state.terminal = true;
		} else if (event.type === "error") {
			state.error = typeof event.message === "string" ? event.message : "Pi reported an error";
		}
	},
};

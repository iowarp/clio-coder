import { piCliModeForAutonomy } from "../../domains/providers/runtimes/external-cli-policy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import type { WorkerRunInput } from "../worker-runtime.js";
import {
	cliEventRecord,
	emptyCliUsage,
	finiteUsage,
	type JsonlCliConnector,
	type JsonlCliState,
} from "./jsonl-runner.js";

export const PI_CLI_DEFAULT_MODEL = "pi-cli-default";

export { piCliModeForAutonomy } from "../../domains/providers/runtimes/external-cli-policy.js";

export function buildPiCliArgs(input: WorkerRunInput): string[] {
	assertToolProfileEnforceable(input.toolProfile, "pi-cli");
	const mode = piCliModeForAutonomy(input.autonomy);
	const args = ["--print", "--mode", "json", "--no-session", "--no-extensions", "--no-approve"];
	if (mode === "read-only") args.push("--tools", "read,grep,find,ls");
	if (input.wireModelId.trim() && input.wireModelId !== PI_CLI_DEFAULT_MODEL) {
		args.push("--model", input.wireModelId.trim());
	}
	return args;
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

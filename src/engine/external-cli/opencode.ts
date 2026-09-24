import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { opencodeCliModeForAutonomy } from "../../domains/providers/runtimes/external-cli-policy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import type { WorkerRunInput } from "../worker-runtime.js";
import { cliEventRecord, emptyCliUsage, finiteUsage, type JsonlCliConnector } from "./jsonl-runner.js";

export const OPENCODE_CLI_DEFAULT_MODEL = "opencode-cli-default";

function referencedOpenCodeCredentials(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
	const configRoot =
		sourceEnv.OPENCODE_CONFIG_DIR ??
		join(sourceEnv.XDG_CONFIG_HOME ?? join(sourceEnv.HOME ?? homedir(), ".config"), "opencode");
	const paths = [sourceEnv.OPENCODE_CONFIG, join(configRoot, "opencode.json"), join(configRoot, "opencode.jsonc")];
	const forwarded: Record<string, string> = {};
	for (const path of paths) {
		if (path === undefined) continue;
		let content: string;
		try {
			if (statSync(path).size > 1024 * 1024) continue;
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		for (const match of content.matchAll(/(?:["']apiKey["']|apiKey)\s*:\s*["']\{env:([A-Z_][A-Z0-9_]*)\}["']/gu)) {
			const name = match[1];
			if (name !== undefined && sourceEnv[name]) forwarded[name] = sourceEnv[name];
		}
	}
	return forwarded;
}

export { opencodeCliModeForAutonomy } from "../../domains/providers/runtimes/external-cli-policy.js";

export function buildOpenCodeCliArgs(input: WorkerRunInput): string[] {
	assertToolProfileEnforceable(input.toolProfile, "opencode-cli");
	opencodeCliModeForAutonomy(input.autonomy);
	const args = ["run", "--format", "json"];
	if (input.wireModelId.trim() && input.wireModelId !== OPENCODE_CLI_DEFAULT_MODEL) {
		args.push("--model", input.wireModelId.trim());
	}
	return args;
}

export const OPENCODE_CLI_CONNECTOR: JsonlCliConnector = {
	runtimeId: "opencode-cli",
	label: "OpenCode CLI",
	binary: "opencode",
	configDirEnv: "OPENCODE_CONFIG_DIR",
	extraEnv: referencedOpenCodeCredentials,
	args: buildOpenCodeCliArgs,
	prompt(input) {
		return [
			input.systemPrompt.trim(),
			...(input.dynamicPromptMessages ?? []).map((message) => message.body.trim()),
			input.task.trim(),
		]
			.filter(Boolean)
			.join("\n\n");
	},
	// OpenCode's run command emits text/step/error events and then exits on session idle.
	requireTerminalEvent: false,
	onEvent(event, state, append) {
		if (typeof event.sessionID === "string") {
			state.responseId = event.sessionID;
			state.sessionId = event.sessionID;
		}
		const part = cliEventRecord(event.part);
		if (event.type === "text" && part?.type === "text" && typeof part.text === "string") {
			append(`${state.text ? "\n" : ""}${part.text}`);
		} else if (event.type === "step_finish" && part?.type === "step-finish") {
			const tokens = cliEventRecord(part.tokens);
			const cache = cliEventRecord(tokens?.cache);
			const usage = state.usage ?? emptyCliUsage();
			usage.input += finiteUsage(tokens?.input);
			usage.output += finiteUsage(tokens?.output);
			usage.cacheRead += finiteUsage(cache?.read);
			usage.cacheWrite += finiteUsage(cache?.write);
			usage.totalTokens += finiteUsage(tokens?.total) || finiteUsage(tokens?.input) + finiteUsage(tokens?.output);
			usage.cost.total += finiteUsage(part.cost);
			state.usage = usage;
			state.usageReported ||=
				tokens !== null &&
				[tokens.input, tokens.output, tokens.total].some((value) => typeof value === "number" && Number.isFinite(value));
			state.costReported ||= typeof part.cost === "number" && Number.isFinite(part.cost);
		} else if (event.type === "error") {
			const error = cliEventRecord(event.error);
			const data = cliEventRecord(error?.data);
			state.error = String(data?.message ?? error?.name ?? "OpenCode reported a session error");
		}
	},
};

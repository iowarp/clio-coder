import type { JobThinkingLevel } from "../domains/dispatch/validation.js";

export interface CliArgDiagnostic {
	type: "warning" | "error";
	message: string;
}

export interface RunCliArgs {
	help: boolean;
	json: boolean;
	target?: string;
	model?: string;
	thinking?: JobThinkingLevel;
	agentId?: string;
	agentProfile?: string;
	agentRuntime?: string;
	toolProfile?: string;
	required: string[];
	autoApprove?: "allow" | "deny";
	supervised: boolean;
	fileArgs: string[];
	messages: string[];
	diagnostics: CliArgDiagnostic[];
}

const VALID_THINKING: ReadonlyArray<JobThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function parseRunCliArgs(argv: ReadonlyArray<string>): RunCliArgs {
	const parsed: RunCliArgs = {
		help: false,
		json: false,
		required: [],
		supervised: false,
		fileArgs: [],
		messages: [],
		diagnostics: [],
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const need = (flag: string): string | null => {
			const value = argv[i + 1];
			if (value === undefined) {
				parsed.diagnostics.push({ type: "error", message: `${flag} requires a value` });
				return null;
			}
			i += 1;
			return value;
		};
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--target") {
			const value = need(arg);
			if (value !== null) parsed.target = value;
			continue;
		}
		if (arg === "--model") {
			const value = need(arg);
			if (value !== null) parsed.model = value;
			continue;
		}
		if (arg === "--thinking") {
			const value = need(arg);
			if (value !== null) {
				if (VALID_THINKING.includes(value as JobThinkingLevel)) parsed.thinking = value as JobThinkingLevel;
				else
					parsed.diagnostics.push({
						type: "error",
						message: "--thinking must be one of: off|minimal|low|medium|high|xhigh",
					});
			}
			continue;
		}
		if (arg === "--agent") {
			const value = need(arg);
			if (value !== null) parsed.agentId = value;
			continue;
		}
		if (arg === "--agent-profile" || arg === "--worker-profile" || arg === "--worker") {
			const value = need(arg);
			if (value !== null) parsed.agentProfile = value;
			continue;
		}
		if (arg === "--agent-runtime" || arg === "--worker-runtime" || arg === "--runtime") {
			const value = need(arg);
			if (value !== null) parsed.agentRuntime = value;
			continue;
		}
		if (arg === "--tool-profile") {
			const value = need(arg);
			if (value !== null) parsed.toolProfile = value;
			continue;
		}
		if (arg === "--require") {
			const value = need(arg);
			if (value !== null) parsed.required.push(value);
			continue;
		}
		if (arg === "--auto-approve") {
			const value = need(arg);
			if (value !== null) {
				const normalized = value.toLowerCase();
				if (normalized === "allow" || normalized === "deny") parsed.autoApprove = normalized;
				else parsed.diagnostics.push({ type: "error", message: "--auto-approve must be 'allow' or 'deny'" });
			}
			continue;
		}
		if (arg === "--supervised") {
			parsed.supervised = true;
			continue;
		}
		if (arg?.startsWith("-")) {
			parsed.diagnostics.push({ type: "error", message: `unknown clio run option: ${arg}` });
			continue;
		}
		if (arg !== undefined) {
			if (arg.startsWith("@") && arg.length > 1) parsed.fileArgs.push(arg.slice(1));
			else parsed.messages.push(arg);
		}
	}

	return parsed;
}

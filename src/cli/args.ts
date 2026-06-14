import type { JobThinkingLevel } from "../domains/dispatch/validation.js";

export interface CliArgDiagnostic {
	type: "warning" | "error";
	message: string;
}

export interface RunSamplingArgs {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

export interface RunCliArgs {
	help: boolean;
	json: boolean;
	target?: string;
	model?: string;
	thinking?: JobThinkingLevel;
	sampling?: RunSamplingArgs;
	agentId?: string;
	agentProfile?: string;
	agentRuntime?: string;
	toolProfile?: string;
	required: string[];
	noSkills: boolean;
	skillPaths: string[];
	maxContextTokens?: number;
	kvCacheMode?: string;
	steerChannel?: string;
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
		noSkills: false,
		skillPaths: [],
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
		if (arg === "--temperature") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "temperature", value, { min: 0 });
			continue;
		}
		if (arg === "--top-p") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "topP", value, { min: 0, max: 1 });
			continue;
		}
		if (arg === "--top-k") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "topK", value, { min: 0, integer: true });
			continue;
		}
		if (arg === "--min-p") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "minP", value, { min: 0, max: 1 });
			continue;
		}
		if (arg === "--presence-penalty") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "presencePenalty", value);
			continue;
		}
		if (arg === "--frequency-penalty") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "frequencyPenalty", value);
			continue;
		}
		if (arg === "--repeat-penalty") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "repeatPenalty", value);
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
		if (arg === "--no-skills") {
			parsed.noSkills = true;
			continue;
		}
		if (arg === "--skill") {
			const value = need(arg);
			if (value !== null) parsed.skillPaths.push(value);
			continue;
		}
		if (arg === "--max-context-tokens") {
			const value = need(arg);
			if (value !== null) {
				const n = Number(value);
				if (Number.isInteger(n) && n > 0) {
					parsed.maxContextTokens = n;
				} else {
					parsed.diagnostics.push({ type: "error", message: "--max-context-tokens must be a positive integer" });
				}
			}
			continue;
		}
		if (arg === "--kv-cache-mode") {
			const value = need(arg);
			if (value !== null) {
				parsed.kvCacheMode = value;
			}
			continue;
		}
		if (arg === "--steer-channel") {
			const value = need(arg);
			if (value !== null) {
				parsed.steerChannel = value;
			}
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

function setNumberOption(
	parsed: RunCliArgs,
	key: keyof NonNullable<RunCliArgs["sampling"]>,
	raw: string,
	limits: { min?: number; max?: number; integer?: boolean } = {},
): void {
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		parsed.diagnostics.push({ type: "error", message: `--${kebab(key)} must be a number` });
		return;
	}
	if (limits.min !== undefined && value < limits.min) {
		parsed.diagnostics.push({ type: "error", message: `--${kebab(key)} must be >= ${limits.min}` });
		return;
	}
	if (limits.max !== undefined && value > limits.max) {
		parsed.diagnostics.push({ type: "error", message: `--${kebab(key)} must be <= ${limits.max}` });
		return;
	}
	const normalized = limits.integer === true ? Math.floor(value) : value;
	parsed.sampling = { ...(parsed.sampling ?? {}), [key]: normalized };
}

function kebab(value: string): string {
	return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

import { ceilChars } from "../session/context-accounting.js";
import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { sha256 } from "./hash.js";

/**
 * Session-prompt compiler. The system prompt is compiled once per session
 * from inputs that are constant for the session's lifetime (identity,
 * operating contract, safety level, provider/model, project context, tool
 * surface). Volatile runtime state (thinking level, send heuristics,
 * per-turn requests) never renders into the prompt: the prompt prefix must
 * stay byte-stable so local prefix caches survive across turns and sessions.
 */

export interface SessionPromptInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	providerSupportsTools?: boolean | null;
	/** Model-stable thinking guidance from local-model quirks (changes only on model change). */
	thinkingGuidance?: string | null;
	/** The session's frozen tool surface, used only to tailor static contract lines. */
	activeToolNames?: ReadonlyArray<string>;
	contextFiles?: string;
	memorySection?: string;
}

export interface CompileInputs {
	identity: string;
	operatingContract: string;
	safety: string;
	sessionInputs: SessionPromptInputs;
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
}

export interface FragmentManifestEntry {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface RenderedPromptFragment {
	id: string;
	relPath: string;
	body: string;
	contentHash: string;
	dynamic: boolean;
}

export interface PromptSection {
	id: string;
	tokenEstimate: number;
}

export interface CompiledSessionPrompt {
	systemPrompt: string;
	systemPromptHash: string;
	tokenEstimate: number;
	sections: ReadonlyArray<PromptSection>;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
}

function lookupFragment(table: FragmentTable, id: string, role: string): LoadedFragment {
	const frag = table.byId.get(id);
	if (!frag) {
		throw new Error(`prompts/compiler: ${role} fragment id "${id}" not found`);
	}
	return frag;
}

function safetyOneLiner(level: string): string {
	switch (level) {
		case "suggest":
			return "describe the work; do not modify files or run effectful commands.";
		case "auto-edit":
			return "edits inside the workspace are allowed; execute-class actions need confirmation.";
		case "full-auto":
			return "edits and local commands are allowed; system_modify and git_destructive remain gated.";
		default:
			return "follow the active safety contract.";
	}
}

function renderSafetySection(safetyFragment: LoadedFragment, level: string): string {
	const oneLine = `Safety: ${level}. ${safetyOneLiner(level)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n\n${body}` : oneLine;
}

function renderRuntimeBlock(inputs: SessionPromptInputs): string {
	const lines: string[] = ["# Runtime"];
	const provider = inputs.provider ?? "";
	const model = inputs.model ?? "";
	if (provider.length > 0) lines.push(`Provider: ${provider}`);
	if (model.length > 0) lines.push(`Model: ${model}`);
	if (typeof inputs.contextWindow === "number" && inputs.contextWindow > 0) {
		lines.push(`Context window: ${inputs.contextWindow}`);
	}
	const guidance = inputs.thinkingGuidance?.trim();
	if (guidance && guidance.length > 0) {
		lines.push("");
		lines.push(guidance);
	}
	return lines.join("\n");
}

function renderToolContractBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Tool Contract",
			"Provider tool calls: unavailable.",
			"This target cannot call tools; answer from the visible user request and compact context only.",
		].join("\n");
	}
	const activeToolNames = normalizeToolNames(inputs.activeToolNames) ?? [];
	const lines = [
		"# Tool Contract",
		"The attached schemas are the session's complete tool surface; follow each schema exactly.",
		"Call tools only for concrete inspection or changes the task requires. If the user asks for a tool-free answer, simply answer without calling tools.",
		"Prefer workspace_context, grep, and read for repository orientation instead of assuming source-tree details were preloaded.",
	];
	if (activeToolNames.includes("code_nav")) {
		lines.push("Use code_nav for indexed TypeScript navigation (modes: symbol, path, entries).");
	}
	if (activeToolNames.includes("read_skill")) {
		lines.push(
			"Call read_skill with no name to list available skills. When the user message carries a skill request, first call read_skill for that skill before doing anything else.",
		);
	}
	if (activeToolNames.includes("dispatch")) {
		lines.push("Call dispatch with list:true to see the agent fleet.");
	}
	if (activeToolNames.includes("ask_user")) {
		lines.push(
			'Use ask_user for operator interviews, confirmations, and choices: one question per round in interview workflows, up to four tightly related questions otherwise, recommended option first. Finish with action="complete" and a compact decisions array before final prose. If cancelled, continue with defaults and do not ask again.',
		);
	}
	return lines.join("\n");
}

function renderRetrievalHintsBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Retrieval Hints",
			"Repository details are intentionally compact because this target has no tool channel.",
			"Use only facts present in the current turn and say what file-specific context would be needed for precise code work.",
		].join("\n");
	}
	return [
		"# Retrieval Hints",
		"Compact CLIO.md project instructions may be preloaded above; everything else about the repository must be fetched, not assumed.",
		"For questions about where code, skills, tools, prompts, or harness behavior live, inspect with code_nav, workspace_context, grep, or read before answering. Never invent file paths, automatic tool behavior, or mutable repo details from the system prompt.",
	].join("\n");
}

function normalizeToolNames(tools: ReadonlyArray<string> | undefined): string[] | null {
	if (!tools) return null;
	return [...new Set(tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0))];
}

function renderProjectBlock(contextFiles: string | undefined): string {
	const trimmedFiles = contextFiles?.trim() ?? "";
	return trimmedFiles.length === 0 ? "" : `# Project\n\n${trimmedFiles}`;
}

function renderMemoryBlock(memorySection: string | undefined): string {
	const trimmed = memorySection?.trim() ?? "";
	return trimmed.length === 0 ? "" : `# Memory\n\n${trimmed}`;
}

function estimatePromptTokens(text: string): number {
	return ceilChars(text.trim().length);
}

/**
 * Compile the session system prompt. Identity and the operating contract
 * render verbatim from disk fragments; safety renders a one-line directive
 * plus the safety fragment body; everything else renders inline from typed
 * SessionPromptInputs. Output is one string, one sha256, one token estimate,
 * and a flat section breakdown for the /context overlay.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompiledSessionPrompt {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const operatingContract = lookupFragment(table, inputs.operatingContract, "operating contract");
	const safety = lookupFragment(table, inputs.safety, "safety");
	const safetyLevel = safety.id.startsWith("safety.") ? safety.id.slice("safety.".length) : safety.id;
	const session = inputs.sessionInputs;

	const parts: string[] = [];
	const sections: PromptSection[] = [];
	const push = (id: string, body: string): void => {
		const trimmed = body.trim();
		if (trimmed.length === 0) return;
		parts.push(trimmed);
		sections.push({ id, tokenEstimate: estimatePromptTokens(trimmed) });
	};

	push("identity", identity.body);
	push("operating-contract", operatingContract.body);
	push("safety", renderSafetySection(safety, safetyLevel));
	push("runtime", renderRuntimeBlock(session));
	push("tool-contract", renderToolContractBlock(session));
	push("retrieval-hints", renderRetrievalHintsBlock(session));
	push("memory", renderMemoryBlock(session.memorySection));
	push("project-context", renderProjectBlock(session.contextFiles));
	for (const fragment of inputs.additionalFragments ?? []) {
		push(fragment.id, fragment.body);
	}

	const systemPrompt = parts.join("\n\n");
	const fragmentManifest: FragmentManifestEntry[] = [identity, operatingContract, safety].map((f) => ({
		id: f.id,
		relPath: f.relPath,
		contentHash: f.contentHash,
		dynamic: f.dynamic,
	}));
	for (const fragment of inputs.additionalFragments ?? []) {
		fragmentManifest.push({
			id: fragment.id,
			relPath: fragment.relPath,
			contentHash: fragment.contentHash,
			dynamic: fragment.dynamic,
		});
	}

	return {
		systemPrompt,
		systemPromptHash: sha256(systemPrompt),
		tokenEstimate: estimatePromptTokens(systemPrompt),
		sections,
		fragmentManifest,
	};
}

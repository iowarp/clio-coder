import type { ThinkingMechanism } from "../providers/types/local-model-quirks.js";
import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { sha256 } from "./hash.js";

export interface CompileInputs {
	identity: string;
	mode: string;
	safety: string;
	dynamicInputs: DynamicInputs;
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
}

export interface DynamicInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	thinkingBudget?: string | null;
	thinkingMechanism?: ThinkingMechanism | null;
	thinkingApplied?: "applied" | "ignored-on-off" | "always-on" | "unsupported" | null;
	thinkingNotice?: string | null;
	thinkingGuidance?: string | null;
	familyGuidance?: string | null;
	sessionNotes?: string;
	contextFiles?: string;
	memorySection?: string;
	turnCount?: number;
	clioVersion?: string;
	piMonoVersion?: string;
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

export interface CompileResult {
	text: string;
	renderedPromptHash: string;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
	dynamicInputs: Readonly<DynamicInputs>;
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

function renderRuntimeBlock(inputs: DynamicInputs): string {
	const lines: string[] = ["# Runtime"];
	const provider = inputs.provider ?? "";
	const model = inputs.model ?? "";
	if (provider.length > 0) lines.push(`Provider: ${provider}`);
	if (model.length > 0) lines.push(`Model: ${model}`);
	if (typeof inputs.contextWindow === "number" && inputs.contextWindow > 0) {
		lines.push(`Context window: ${inputs.contextWindow}`);
	}
	if (typeof inputs.thinkingBudget === "string" && inputs.thinkingBudget.length > 0) {
		lines.push(`Thinking level: ${inputs.thinkingBudget}`);
	}
	if (typeof inputs.thinkingMechanism === "string" && inputs.thinkingMechanism.length > 0) {
		lines.push(`Thinking mechanism: ${inputs.thinkingMechanism}`);
	}
	if (typeof inputs.thinkingApplied === "string" && inputs.thinkingApplied.length > 0) {
		lines.push(`Thinking applied: ${inputs.thinkingApplied}`);
	}
	if (typeof inputs.thinkingNotice === "string" && inputs.thinkingNotice.length > 0) {
		lines.push(`Note: ${inputs.thinkingNotice}`);
	}
	const guidance = inputs.thinkingGuidance?.trim();
	if (guidance && guidance.length > 0) {
		lines.push("");
		lines.push(guidance);
	}
	const familyGuidance = inputs.familyGuidance?.trim();
	if (familyGuidance && familyGuidance.length > 0) {
		lines.push("");
		lines.push(familyGuidance);
	}
	return lines.join("\n");
}

function renderProjectBlock(contextFiles: string | undefined): string {
	const trimmed = contextFiles?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Project\n\n${trimmed}`;
}

function renderMemoryBlock(memorySection: string | undefined): string {
	const trimmed = memorySection?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Memory\n\n${trimmed}`;
}

function renderSessionBlock(inputs: DynamicInputs): string {
	const sessionNotes = inputs.sessionNotes?.trim() ?? "";
	const turnCount = typeof inputs.turnCount === "number" ? inputs.turnCount : 0;
	if (sessionNotes.length === 0 && turnCount === 0) return "";
	const lines: string[] = ["# Session"];
	if (turnCount > 0) lines.push(`Turn count: ${turnCount}`);
	if (sessionNotes.length > 0) {
		if (turnCount > 0) lines.push("");
		lines.push(sessionNotes);
	}
	return lines.join("\n");
}

/**
 * Compile a Clio prompt from the supplied fragment table and inputs.
 *
 * Identity and the active mode render verbatim from disk fragments. Safety
 * renders a single one-line directive followed by the active mode's safety
 * fragment body. Everything else renders inline from typed DynamicInputs:
 * runtime metadata (provider, model, context window, thinking mechanism,
 * thinking applied/notice/guidance, family guidance), project context,
 * memory section, and session state.
 *
 * One reproducibility hash travels with the rendered text: `renderedPromptHash`
 * is sha256 over the final text. Receipts written by older builds remain
 * readable under the same field name.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompileResult {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const mode = lookupFragment(table, inputs.mode, "mode");
	const safety = lookupFragment(table, inputs.safety, "safety");

	const safetyLevel = safety.id.startsWith("safety.") ? safety.id.slice("safety.".length) : safety.id;
	const parts: string[] = [
		identity.body.trim(),
		mode.body.trim(),
		renderSafetySection(safety, safetyLevel),
		renderRuntimeBlock(inputs.dynamicInputs),
	];
	const project = renderProjectBlock(inputs.dynamicInputs.contextFiles);
	if (project.length > 0) parts.push(project);
	const memory = renderMemoryBlock(inputs.dynamicInputs.memorySection);
	if (memory.length > 0) parts.push(memory);
	const session = renderSessionBlock(inputs.dynamicInputs);
	if (session.length > 0) parts.push(session);
	for (const fragment of inputs.additionalFragments ?? []) {
		const body = fragment.body.trim();
		if (body.length > 0) parts.push(body);
	}

	const text = parts.join("\n\n");
	const renderedPromptHash = sha256(text);

	const manifestFragments: LoadedFragment[] = [identity, mode, safety];
	const fragmentManifest: FragmentManifestEntry[] = manifestFragments.map((f) => ({
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
		text,
		renderedPromptHash,
		fragmentManifest,
		dynamicInputs: { ...inputs.dynamicInputs },
	};
}

import type { PendingSkillRequest } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import { applyToolProfile, type ToolProfileName } from "./profiles.js";

/**
 * Capability-gated tool surface. The full deterministic policy bound
 * (registry ∩ profile ∩ worker admission) attaches every turn, in stable
 * sorted order, so local prefix-cache runtimes (llama.cpp, LM Studio) see an
 * identical tool region across turns and reuse the prompt prefix. Per-turn
 * intent guessing was removed on purpose: saving a few thousand schema tokens
 * by varying the surface invalidated the whole cached prefix, which costs far
 * more than it saved.
 *
 * The only narrowings left are deterministic and explicit:
 *  - the target has no tool channel,
 *  - the user asked for a tool-free answer,
 *  - a pending skill request constrains the turn to read_skill (+ ask_user)
 *    until the requested skill loads (then the host-wins merge widens it).
 */
export interface ResolveToolPaletteInput {
	providerSupportsTools: boolean;
	userText: string;
	availableTools?: ReadonlyArray<ToolName>;
	toolProfile?: ToolProfileName;
	workerAllowedTools?: ReadonlyArray<ToolName>;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
}

export interface ToolPaletteResult {
	/** Tools whose schemas attach this turn. Equals `availableTools` except on the explicit narrowings above. */
	activeTools: ReadonlyArray<ToolName>;
	/** Full session policy bound after profile and worker constraints. */
	availableTools: ReadonlyArray<ToolName>;
	/** Names of the deterministic gates that fired this turn, for diagnostics. */
	signals: ReadonlyArray<string>;
	/** True when the user explicitly asked for a tool-free answer. */
	toolsSuppressed: boolean;
	providerSupportsTools: boolean;
	posture: "operating";
	omittedToolCount: number;
}

const NO_TOOL_RE =
	/\b(?:do\s+not|don't)\s+use\s+(?:any\s+)?(?:tools?|tool\s+calls?)\b|\b(?:without|no)\s+(?:tools|tool\s+calls?)\b|\bno\s+tool\s+(?:use|calls?)\b|\bjust\s+(?:answer|explain|tell\s+me)\b.{0,40}\bno\s+tools?\b/i;

function uniqueSorted(tools: Iterable<ToolName>): ToolName[] {
	return [...new Set(tools)].sort((a, b) => a.localeCompare(b));
}

export function resolveToolPalette(input: ResolveToolPaletteInput): ToolPaletteResult {
	const modeTools = input.availableTools ?? [];
	const profileTools = applyToolProfile(modeTools, input.toolProfile);
	const constrained = input.workerAllowedTools
		? profileTools.filter((tool) => input.workerAllowedTools?.includes(tool))
		: profileTools;
	const candidates = uniqueSorted(constrained);
	if (!input.providerSupportsTools) {
		return {
			activeTools: [],
			availableTools: [],
			signals: [],
			toolsSuppressed: false,
			providerSupportsTools: false,
			posture: "operating",
			omittedToolCount: candidates.length,
		};
	}
	const noTools = NO_TOOL_RE.test(input.userText.trim());
	const hasPendingSkillRequest = (input.pendingSkillRequests?.length ?? 0) > 0;
	// A pending skill request wins over a no-tools phrase: the operator
	// explicitly asked to run a skill, which requires read_skill.
	if (hasPendingSkillRequest) {
		const activeTools = candidates.filter((tool) => tool === ToolNames.ReadSkill || tool === ToolNames.AskUser);
		return {
			activeTools,
			availableTools: candidates,
			signals: ["pendingSkillRequest"],
			toolsSuppressed: false,
			providerSupportsTools: true,
			posture: "operating",
			omittedToolCount: Math.max(0, candidates.length - activeTools.length),
		};
	}
	if (noTools) {
		return {
			activeTools: [],
			availableTools: candidates,
			signals: ["noTools"],
			toolsSuppressed: true,
			providerSupportsTools: true,
			posture: "operating",
			omittedToolCount: candidates.length,
		};
	}
	return {
		activeTools: candidates,
		availableTools: candidates,
		signals: [],
		toolsSuppressed: false,
		providerSupportsTools: true,
		posture: "operating",
		omittedToolCount: 0,
	};
}

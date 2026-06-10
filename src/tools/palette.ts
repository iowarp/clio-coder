import type { PendingSkillRequest } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import { applyToolProfile, type ToolProfileName } from "./profiles.js";

export type ToolPaletteGroup =
	| "orientation"
	| "locate"
	| "inspect"
	| "mutate"
	| "validate"
	| "delegate"
	| "external"
	| "skills"
	| "artifact"
	| "escape_hatch";

export type ToolPaletteIntent =
	| "small_talk"
	| "tool_meta"
	| "repo_inspection"
	| "coding"
	| "validation"
	| "delegation"
	| "external_research"
	| "skill_work";

export type ToolPalettePhase = "initial" | "inspection" | "editing" | "post_edit" | "validation";

export interface ResolveToolPaletteInput {
	providerSupportsTools: boolean;
	userText: string;
	availableTools?: ReadonlyArray<ToolName>;
	toolProfile?: ToolProfileName;
	workerAllowedTools?: ReadonlyArray<ToolName>;
	recentToolNames?: ReadonlyArray<ToolName>;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
}

export interface ToolPaletteResult {
	activeTools: ReadonlyArray<ToolName>;
	/**
	 * Every tool this target could call this session after profile and worker
	 * constraints, regardless of whether the current turn activated its schema.
	 * Drives the always-present Tool Catalog so the model stays aware of its
	 * full surface even when no schema is attached this turn.
	 */
	availableTools: ReadonlyArray<ToolName>;
	intent: ToolPaletteIntent;
	phase: ToolPalettePhase;
	groups: ReadonlyArray<ToolPaletteGroup>;
	/**
	 * Names of the classifier signals that fired on this turn, in a stable
	 * order. Surfaced in prompt diagnostics so palette decisions stay
	 * auditable: the active groups are a pure function of these signals.
	 */
	signals: ReadonlyArray<string>;
	/** True when the user explicitly asked for a tool-free answer. */
	toolsSuppressed: boolean;
	providerSupportsTools: boolean;
	posture: "operating";
	omittedToolCount: number;
}

export const TOOL_GROUPS: Readonly<Record<ToolPaletteGroup, ReadonlyArray<ToolName>>> = {
	orientation: [ToolNames.WorkspaceContext, ToolNames.GitStatus, ToolNames.EntryPoints],
	locate: [ToolNames.WhereIs, ToolNames.FindSymbol, ToolNames.Find, ToolNames.Glob],
	inspect: [ToolNames.Read, ToolNames.Grep, ToolNames.Ls, ToolNames.GitDiff, ToolNames.GitLog],
	mutate: [ToolNames.Edit, ToolNames.Write],
	validate: [
		ToolNames.RunTests,
		ToolNames.RunLint,
		ToolNames.RunBuild,
		ToolNames.PackageScript,
		ToolNames.ValidateFrontend,
	],
	delegate: [ToolNames.Dispatch, ToolNames.DispatchBatch],
	external: [ToolNames.WebFetch],
	skills: [ToolNames.ReadSkill, ToolNames.AskUser, ToolNames.CreateSkill],
	artifact: [ToolNames.WritePlan, ToolNames.WriteReview],
	escape_hatch: [ToolNames.Bash],
};

const GROUP_ORDER: ReadonlyArray<ToolPaletteGroup> = [
	"orientation",
	"locate",
	"inspect",
	"mutate",
	"validate",
	"delegate",
	"external",
	"skills",
	"artifact",
	"escape_hatch",
];

/** One-line purpose per group, rendered in the always-present Tool Catalog. */
const GROUP_PURPOSE: Readonly<Record<ToolPaletteGroup, string>> = {
	orientation: "workspace snapshot, git status, entry points",
	locate: "find files and symbols",
	inspect: "read, grep, list, git diff/log",
	mutate: "edit and write files",
	validate: "run tests, lint, build, package scripts",
	delegate: "dispatch bounded fleet sub-agents",
	external: "fetch web content",
	skills: "load or author SKILL.md playbooks; ask structured operator questions",
	artifact: "write PLAN.md / REVIEW.md artifacts",
	escape_hatch: "raw shell via bash",
};

const GREETING_RE = /^(?:hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|ping)[.!?\s]*$/i;
const EDIT_RE =
	/\b(?:implement|fix|edit|modify|change|update|add|remove|delete|refactor|rewrite|write|save|create|scaffold|patch|repair|wire|migrate|resolve|address|handle|improve|optimi[sz]e|rename|extract|bump|upgrade|downgrade|revert|apply|configure|correct)\b|\bclean\s*up\b|\bset\s+up\b|\bhook\s+up\b|\bmake\b.{0,40}\b(?:pass|work|compile|build|green)\b/i;
const INSPECT_RE =
	/\b(?:inspect|audit|review|explain|summari[sz]e|understand|find|where|locate|read|show|list|search|grep|status|diff|log|trace|map)\b/i;
/** Problem statements ("the build is broken") imply a debug-and-fix workflow. */
const PROBLEM_RE =
	/\b(?:bug|broken|crash(?:es|ing|ed)?|fail(?:s|ing|ure|ures|ed)?|error|exception|regression|flaky|leak(?:s|ing)?|hang(?:s|ing)?|stack\s*trace|segfault)\b/i;
/** Question-form prompts want diagnosis first, not immediate mutation. */
const QUESTION_RE = /^(?:why|what|how|when|where|who|which|is|are|does|do|can|could|should|did)\b|\?\s*$/i;
const VALIDATE_RE = /\b(?:test|tests|lint|typecheck|build|verify|validation|validate|ci|precommit)\b/i;
const DISPATCH_RE =
	/\b(?:subagents?|sub-agents?|delegate|worker|workers|dispatch|multi-agent|parallel agents?|fleet)\b/i;
const LITERATURE_AGENT_RE = /\bliterature\s+(?:shadow\s+)?agent\b/i;
const LITERATURE_RE =
	/\b(?:arxiv|arxiv\.org|alphaxiv|ar5iv|academic\s+literature|literature\s+(?:search|review|survey)|research\s+papers?|papers?\s+(?:on|about|for)|compare\s+(?:these\s+)?papers?|paper\s+(?:summary|summarization|comparison))\b/i;
const AVOID_DISPATCH_RE =
	/\b(?:(?:do\s+not|don't)\s+(?:use\s+)?|(?:without|no)\s+(?:using\s+)?)\b(?:dispatch|delegat(?:e|ion)|subagents?|sub-agents?|workers?|fleet|multi-agent|parallel agents?)\b/i;
const EXTERNAL_RE =
	/\bhttps?:\/\/|\b(?:web\s*search|search\s+the\s+web|browse|internet|online\s+docs?|external\s+research|webpage|web\s+page|url)\b|\bfetch\s+(?:the\s+)?(?:url|page|site|website|docs?|documentation)\b|\blatest\s+(?:version|release|docs?|documentation|news)\b|\bwhat'?s\s+new\s+in\b/i;
const CREATE_SKILL_RE =
	/\bcreate_skill\b|\b(?:create|write|scaffold)\s+(?:a\s+|new\s+)?skill\b|\badd\s+(?:a\s+)?(?:new\s+)?skill\s+(?:file|to\s+(?:the\s+)?(?:skill\s+store|skill\s+catalog|project|repo|repository))\b/i;
const ASK_USER_RE =
	/\bask[_-]?user\b|\bask\s+user\s+tool\b|\b(?:interview\s+me|ask\s+me\s+(?:about|which|what|how|to)|confirm\s+with\s+me)\b/i;
const SHELL_RE = /\b(?:bash|shell|terminal|command line|cli command|run command|execute command)\b/i;
/** Mentions of concrete CLI invocations that the curated tools do not cover. */
const COMMAND_MENTION_RE =
	/`[^`]+`|\b(?:npm|pnpm|yarn|npx|git|docker|make|cargo|pip|uv|kubectl)\s+(?:install|publish|push|pull|fetch|rebase|cherry-pick|stash|clone|compose|exec|run|apply)\b/i;
const AVOID_SHELL_RE =
	/\b(?:(?:do\s+not|don't)\s+(?:use\s+)?|(?:without|no)\s+(?:using\s+)?)\b(?:bash|shell|terminal|command line|cli command|run command|execute command)\b/i;
const TOOL_META_RE =
	/\b(?:what|which)\s+(?:tools?|tool\s+calls?)\b|\b(?:list|show|describe)\s+(?:all\s+)?(?:the\s+)?(?:tools?l?(?!-)|tool\s+calls?)\b|\btools?\s+(?:do|can)\s+you\s+(?:have|use|access)\b|\btool\s+(?:access|surface|palette)\b/i;
const NO_TOOL_RE =
	/\b(?:do\s+not|don't)\s+use\s+(?:any\s+)?(?:tools?|tool\s+calls?)\b|\b(?:without|no)\s+(?:tools|tool\s+calls?)\b|\bno\s+tool\s+(?:use|calls?)\b|\bjust\s+(?:answer|explain|tell\s+me)\b.{0,40}\bno\s+tools?\b/i;
const WORK_CONTEXT_RE =
	/\b(?:repo(?:sitory)?|workspace|project|code|source|files?|director(?:y|ies)|src\/|tests?\/|package\.json|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|rs|go|c|cpp|h|hpp|toml|ya?ml))\b/i;
const ARTIFACT_RE = /\b(?:plan|review|PLAN\.md|REVIEW\.md)\b/i;

/**
 * Every named classifier signal, computed once per turn. Both the primary
 * intent and the requested groups derive from this single struct, so the
 * decision is deterministic and each activation can be traced to the signal
 * that caused it.
 */
export interface IntentSignals {
	empty: boolean;
	greeting: boolean;
	noTools: boolean;
	noShell: boolean;
	toolMeta: boolean;
	dispatch: boolean;
	avoidDispatch: boolean;
	literature: boolean;
	skill: boolean;
	skillAuthoring: boolean;
	askUser: boolean;
	external: boolean;
	edit: boolean;
	problemReport: boolean;
	questionForm: boolean;
	validation: boolean;
	inspection: boolean;
	shell: boolean;
	commandMention: boolean;
	workContext: boolean;
	artifact: boolean;
}

export function detectIntentSignals(text: string): IntentSignals {
	const trimmed = text.trim();
	return {
		empty: trimmed.length === 0,
		greeting: GREETING_RE.test(trimmed),
		noTools: NO_TOOL_RE.test(trimmed),
		noShell: AVOID_SHELL_RE.test(trimmed),
		toolMeta: TOOL_META_RE.test(trimmed),
		avoidDispatch: AVOID_DISPATCH_RE.test(trimmed),
		literature: LITERATURE_AGENT_RE.test(trimmed) || LITERATURE_RE.test(trimmed),
		dispatch: (DISPATCH_RE.test(trimmed) || LITERATURE_AGENT_RE.test(trimmed)) && !AVOID_DISPATCH_RE.test(trimmed),
		skill: false,
		skillAuthoring: CREATE_SKILL_RE.test(trimmed),
		askUser: ASK_USER_RE.test(trimmed),
		external: EXTERNAL_RE.test(trimmed) || LITERATURE_RE.test(trimmed),
		edit: EDIT_RE.test(trimmed),
		problemReport: PROBLEM_RE.test(trimmed),
		questionForm: QUESTION_RE.test(trimmed),
		validation: VALIDATE_RE.test(trimmed),
		inspection: INSPECT_RE.test(trimmed),
		shell: SHELL_RE.test(trimmed),
		commandMention: COMMAND_MENTION_RE.test(trimmed),
		workContext: WORK_CONTEXT_RE.test(trimmed),
		artifact: ARTIFACT_RE.test(trimmed),
	};
}

function firedSignalNames(signals: IntentSignals): string[] {
	return (Object.keys(signals) as Array<keyof IntentSignals>).filter((key) => signals[key]);
}

function hasWorkIntent(signals: IntentSignals): boolean {
	return (
		signals.dispatch ||
		signals.skill ||
		signals.askUser ||
		signals.external ||
		signals.edit ||
		signals.problemReport ||
		signals.validation ||
		(signals.inspection && (!signals.toolMeta || signals.workContext))
	);
}

/**
 * Pick the single primary intent from the fired signals. Multi-intent prompts
 * keep all of their signals; group expansion unions over every signal, so the
 * primary label only decides phase defaults and prompt wording, never access.
 */
export function classifyIntent(signals: IntentSignals): ToolPaletteIntent {
	if (signals.empty || signals.greeting) return "small_talk";
	if (signals.toolMeta && !hasWorkIntent(signals)) return "tool_meta";
	if (signals.dispatch) return "delegation";
	if (signals.skill || signals.askUser) return "skill_work";
	if (signals.external) return "external_research";
	if (signals.edit) return "coding";
	// A problem statement implies a fix workflow, but question-form prompts
	// ("why does the build fail?") want diagnosis first.
	if (signals.problemReport && !signals.questionForm) return "coding";
	if (signals.validation) return "validation";
	return "repo_inspection";
}

function unique(tools: Iterable<ToolName>): ToolName[] {
	const seen = new Set<ToolName>();
	const out: ToolName[] = [];
	for (const tool of tools) {
		if (seen.has(tool)) continue;
		seen.add(tool);
		out.push(tool);
	}
	return out;
}

function hasRecentEdit(tools: ReadonlyArray<ToolName> | undefined): boolean {
	return tools?.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write) ?? false;
}

function resolvePhase(
	intent: ToolPaletteIntent,
	signals: IntentSignals,
	recentTools: ReadonlyArray<ToolName> | undefined,
): ToolPalettePhase {
	if (signals.validation) return "validation";
	if (hasRecentEdit(recentTools)) return "post_edit";
	if (intent === "coding" || intent === "skill_work") return "editing";
	if (intent === "small_talk" || intent === "tool_meta") return "initial";
	return "inspection";
}

function requestedGroups(
	intent: ToolPaletteIntent,
	phase: ToolPalettePhase,
	signals: IntentSignals,
): ToolPaletteGroup[] {
	if (intent === "small_talk" || intent === "tool_meta") return [];
	const groups: ToolPaletteGroup[] = ["orientation", "locate", "inspect"];
	if (intent === "coding" || signals.edit || signals.skillAuthoring) groups.push("mutate");
	if (
		signals.validation ||
		signals.problemReport ||
		phase === "post_edit" ||
		phase === "validation" ||
		intent === "validation"
	) {
		groups.push("validate");
	}
	if (signals.dispatch) groups.push("delegate");
	if (signals.external) groups.push("external");
	if (signals.skill || signals.askUser || signals.skillAuthoring) groups.push("skills");
	if (signals.artifact) groups.push("artifact");
	if ((signals.shell || signals.commandMention) && !signals.noShell) groups.push("escape_hatch");
	return uniqueGroups(groups);
}

function uniqueGroups(groups: Iterable<ToolPaletteGroup>): ToolPaletteGroup[] {
	const seen = new Set<ToolPaletteGroup>();
	const out: ToolPaletteGroup[] = [];
	for (const group of groups) {
		if (seen.has(group)) continue;
		seen.add(group);
		out.push(group);
	}
	return out.sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
}

function expandGroups(groups: ReadonlyArray<ToolPaletteGroup>, signals: IntentSignals): ToolName[] {
	const tools: ToolName[] = [];
	for (const group of groups) {
		for (const tool of TOOL_GROUPS[group]) {
			if (tool === ToolNames.ReadSkill) continue;
			if (tool === ToolNames.AskUser && !signals.askUser) continue;
			if (tool === ToolNames.CreateSkill && !signals.skillAuthoring) continue;
			tools.push(tool);
		}
	}
	return unique(tools);
}

/**
 * Render a compact, names-only catalog of the tools available this session,
 * grouped by purpose. This is cheap (one line per non-empty group) and stable
 * across turns, so it lives in the prefix-cacheable session shell and keeps the
 * model aware of its full surface even on turns where no tool schema is
 * attached. Schemas remain progressively disclosed via the active palette.
 */
export function renderToolCatalog(availableTools: ReadonlyArray<ToolName>): string {
	const available = new Set(availableTools);
	const lines: string[] = [];
	for (const group of GROUP_ORDER) {
		const tools = TOOL_GROUPS[group].filter((tool) => available.has(tool));
		if (tools.length === 0) continue;
		lines.push(`- ${group} (${GROUP_PURPOSE[group]}): ${tools.join(", ")}`);
	}
	return lines.join("\n");
}

export function resolveToolPalette(input: ResolveToolPaletteInput): ToolPaletteResult {
	const modeTools = input.availableTools ?? [];
	const profileTools = applyToolProfile(modeTools, input.toolProfile);
	const constrained = input.workerAllowedTools
		? profileTools.filter((tool) => input.workerAllowedTools?.includes(tool))
		: profileTools;
	const candidates = unique(constrained);
	const rawSignals = detectIntentSignals(input.userText);
	const hasPendingSkillRequest = (input.pendingSkillRequests?.length ?? 0) > 0;
	const signals: IntentSignals = hasPendingSkillRequest
		? { ...rawSignals, skill: true, askUser: true, noTools: false }
		: rawSignals;
	const intent = classifyIntent(signals);
	const phase = resolvePhase(intent, signals, input.recentToolNames);
	const signalNames = firedSignalNames(signals);
	if (!input.providerSupportsTools) {
		return {
			activeTools: [],
			availableTools: [],
			intent,
			phase,
			groups: [],
			signals: signalNames,
			toolsSuppressed: signals.noTools,
			providerSupportsTools: false,
			posture: "operating",
			omittedToolCount: candidates.length,
		};
	}
	// An explicit tool-free request suppresses every schema this turn while
	// keeping the truthful intent label; the Tool Catalog still tells the
	// model what it could use if the user changes their mind.
	if (hasPendingSkillRequest && !signals.noTools) {
		const activeTools = candidates.filter((tool) => tool === ToolNames.ReadSkill || tool === ToolNames.AskUser);
		return {
			activeTools,
			availableTools: candidates,
			intent: "skill_work",
			phase: "initial",
			groups: ["skills"],
			signals: signalNames.includes("pendingSkillRequest") ? signalNames : [...signalNames, "pendingSkillRequest"],
			toolsSuppressed: false,
			providerSupportsTools: true,
			posture: "operating",
			omittedToolCount: Math.max(0, candidates.length - activeTools.length),
		};
	}
	if (signals.askUser && !signals.noTools) {
		const activeTools = candidates.filter((tool) => tool === ToolNames.AskUser);
		return {
			activeTools,
			availableTools: candidates,
			intent: "skill_work",
			phase: "initial",
			groups: ["skills"],
			signals: signalNames,
			toolsSuppressed: false,
			providerSupportsTools: true,
			posture: "operating",
			omittedToolCount: Math.max(0, candidates.length - activeTools.length),
		};
	}
	const groups = signals.noTools ? [] : requestedGroups(intent, phase, signals);
	const requested = new Set(expandGroups(groups, signals));
	const activeTools = candidates.filter((tool) => requested.has(tool));
	return {
		activeTools,
		availableTools: candidates,
		intent,
		phase,
		groups,
		signals: signalNames,
		toolsSuppressed: signals.noTools,
		providerSupportsTools: true,
		posture: "operating",
		omittedToolCount: Math.max(0, candidates.length - activeTools.length),
	};
}

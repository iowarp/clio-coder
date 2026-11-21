import { settingsChangeKind } from "../domains/config/classify.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { findBuiltinRuntimeBootMetadata } from "../domains/providers/runtimes/boot-manifest.js";
import type { ClioSettings } from "./config.js";
import { SettingsValidationError, semanticUsable, validateSettings } from "./config.js";
import { DEFAULT_SETTINGS, THINKING_LEVELS } from "./defaults.js";
import { getAtPath, setAtPath } from "./session-routing.js";
import {
	SETTINGS_AREA_GROUPS,
	type SettingsAreaId,
	settingsAreaForPath,
	settingsPlacementForPath,
	settingsPlacementForRow,
} from "./settings-areas.js";

/** Accepted settings can still be inactive on the configured route (#432). */
export function settingInactiveNote(path: string, settings: Readonly<ClioSettings>): string | null {
	if (
		path === "context.semantic.enabled" &&
		settings.context.semantic.enabled &&
		!semanticUsable(settings.context.semantic)
	)
		return "Inactive until target, model and assetIdentity are pinned with clio-coder semantic configure.";
	if (path === "chat.prewarm" && settings.chat.prewarm) {
		const target = settings.targets.find((entry) => entry.id === settings.chat.target);
		const runtime = target
			? (getRuntimeRegistry().get(target.runtime) ?? findBuiltinRuntimeBootMetadata(target.runtime))
			: null;
		if (runtime?.tier !== "local-native" && !(target?.runtime === "litellm" && target.cache?.deployment))
			return "Inactive on this chat route; prompt pre-warm requires a local native runtime or a declared LiteLLM cache deployment.";
	}
	return null;
}

export const SETTINGS_LABELS_BY_ID = {
	"safety.autonomy": "Autonomy level",
	// A row id is its settings path; visible names are shared by every settings surface.
	"fleet.permissions.mode": "When a worker asks permission",
	"fleet.permissions.escalation.timeoutMs": "Time to answer a worker",
	"fleet.permissions.escalation.fallback": "If you do not answer",
	"integrations.externalAgents.defaults.toolGovernance": "External agent permissions",
	"integrations.projectResources.trustProjectImports": "Trust project imports",
	"integrations.git.commitAttribution": "Credit in Git commits",
	"integrations.git.commitAuthor": "Author of autonomous commits",
	safetyNet: "Safety net",
	"chat.thinkingLevel": "Thinking level",
	"chat.target": "Chat connection",
	"chat.model": "Chat model",
	"context.memory.target": "Memory connection",
	"context.memory.model": "Memory model",
	"context.memory.enabled": "Proactive memory",
	"context.memory.cadenceToolCalls": "Tools between memory updates",
	"context.memory.trajectorySteps": "Recent steps to remember",
	"context.memory.maxOutputTokens": "Memory note length",
	"context.memory.timeoutMs": "Memory response time",
	"chat.prewarm": "Prompt pre-warm",
	"fleet.default.target": "Default fleet connection",
	"fleet.default.model": "Default fleet model",
	"fleet.default.thinkingLevel": "Default thinking level",
	"fleet.profiles": "Add profile",
	"fleet.agentProfiles": "Bind agent",
	"fleet.retry.maxRetries": "Fleet retries",
	"fleet.staggerSharedPrefix": "Stagger shared-prefix workers",
	"fleet.retry.routeCooldownMs": "Wait after a route fails",
	"fleet.adaptiveRouting.roles": "Roles using automatic routing",
	"fleet.adaptiveRouting.postures": "Automatic routing priorities",
	"fleet.adaptiveRouting.agentRoles": "Agents using automatic routing",
	"interface.panes.notifications": "Pane notifications",
	"interface.panes.layout": "Startup layout",
	"interface.panes.workers.ratio": "Workers dock share",
	"fleet.history.journal": "Run event journal",
	"interface.panes.files.enabled": "Files pane",
	"interface.panes.files.mode": "Files pane mode",
	"interface.panes.files.profile": "Files pane profile",
	"interface.panes.files.followCwd": "Files follow chat folder",
	"interface.panes.files.ratio": "Files dock share",
	"chat.modelPicker.cycleSet": "Models in quick switch",
	"chat.modelPicker.recentLimit": "Recent models kept",
	"chat.modelPicker.favorites": "Pinned favorites",
	"safety.limits.sessionCostUsd": "Session cost limit",
	"chat.maxOutputTokens": "Maximum answer length",
	"context.toolResultMaxBytes": "Maximum tool result size",
	"fleet.concurrency": "Workers at once",
	"safety.limits.chatToolCallsPerTurn": "Tools per chat turn",
	"fleet.limits.toolCallsPerRun": "Tools per worker run",
	"fleet.history.maxRuns": "Past runs to keep",
	"safety.limits.readBytesPerCall": "Maximum file read size",
	"safety.limits.observationBytesPerTurn": "Tool output per turn",
	"fleet.limits.internalRunTimeoutMs": "Maximum internal run time",
	"context.compaction.auto": "Summarize automatically",
	"context.compaction.threshold": "When to summarize",
	"context.compaction.maxTokens": "Context token ceiling",
	"context.compaction.provider": "Provider compaction",
	"context.workingSet.enabled": "Clear old tool output",
	"context.workingSet.policy": "How old output is chosen",
	"context.workingSet.profile": "What to keep in context",
	"context.workingSet.target": "Context level after cleanup",
	"context.workingSet.protectLastTurns": "Recent turns to keep",
	"context.workingSet.protectLastSteps": "Recent steps to keep",
	"context.workingSet.minEvictableTokens": "Smallest output to clear",
	"context.workingSet.rearmFraction": "Wait before clearing again",
	"chat.retry.enabled": "Retry transient errors",
	"chat.retry.maxRetries": "Max retries",
	"chat.retry.baseDelayMs": "Wait before first retry",
	"chat.retry.maxDelayMs": "Longest retry wait",
	"chat.retry.streamStallMs": "Wait for a stalled reply",
	"chat.retry.firstTokenStallMs": "Wait for reply to start",
	"interface.terminalProgress": "Terminal progress indicator",
	"interface.outputDetail": "Output detail",
	"interface.mode": "Transcript layout",
	"interface.fullscreenScrollbar": "Fullscreen scrollbar",
	"interface.smoothStreaming": "Smooth streaming",
	"interface.desktopNotifications": "Desktop notifications",
	"safety.review.enabled": "Review changed work",
	"safety.review.target": "Review connection",
	"safety.review.cadenceToolCalls": "Tools between reviews",
	"integrations.runtimePlugins": "Startup plugins",
	"context.compaction.model": "Compaction model",
	"context.compaction.systemPrompt": "Compaction prompt",
	"integrations.externalAgents.defaults.connectTimeoutMs": "Time for agent to connect",
	"integrations.externalAgents.defaults.turnTimeoutMs": "Maximum agent turn time",
	"integrations.externalAgents.defaults.permissionTimeoutMs": "Time for agent permission",
	targets: "Configured connections",
	"interface.keybindings": "Keybinding overrides",
	"integrations.externalAgents.entries": "Available agents",
	"integrations.library.catalog": "Library catalog path",
	"integrations.library.remote": "Library remote",
	"integrations.library.confirmedRemote": "Confirmed library remote",
	"integrations.library.sync": "Library remote sync",
} as const;

export const SETTINGS_DESCRIPTIONS_BY_ID = {
	"safety.autonomy": "How freely CLIO Coder acts; the safety net always applies.",
	"fleet.permissions.mode":
		"Choose whether the safety judge reviews a worker's blocked tool, or the worker skips it, stops, or asks you to approve it.",
	"fleet.permissions.escalation.timeoutMs": "How long CLIO Coder waits for your answer when a worker asks permission.",
	"fleet.permissions.escalation.fallback": "What the worker does if you do not answer in time.",
	"integrations.externalAgents.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"integrations.projectResources.trustProjectImports": "Allow explicitly imported foreign skills and prompts to run.",
	"integrations.git.commitAttribution":
		"Add evidence-backed assistance, testing, review, and contributor trailers to commits created through CLIO Coder.",
	"integrations.git.commitAuthor":
		"Who authors commits CLIO Coder makes on its own: dispatched workers and their landing, headless runs, and scheduled jobs.",
	safetyNet: "Always-on rails; tuned in .clio-coder/safety.yaml.",
	"chat.thinkingLevel": "How much reasoning the chat model uses before answering.",
	"chat.target": "Connection that answers in chat.",
	"chat.model": "Chat model override; unset uses the connection default.",
	"context.memory.target":
		"Connection for task memory. With no memory connection or model set, memory uses the chat route.",
	"context.memory.model":
		"Dedicated task-memory model. With no memory connection or model set, memory uses the chat route.",
	"context.memory.enabled": "Allow CLIO Coder to update task memory as work progresses.",
	"context.memory.cadenceToolCalls": "Maximum number of tool uses between memory updates.",
	"context.memory.trajectorySteps": "How many recent steps CLIO Coder considers when updating memory.",
	"context.memory.maxOutputTokens": "Maximum length of one memory reminder, in tokens.",
	"context.memory.timeoutMs": "How long CLIO Coder waits for a memory model response.",
	"chat.prewarm": "Send the next turn's known prefix ahead of time so a local server has already prefilled it.",
	"fleet.default.target": "Default connection for delegated fleet work.",
	"fleet.default.model": "Default fleet model override; unset uses the connection default.",
	"fleet.default.thinkingLevel": "Reasoning budget for dispatched workers.",
	"fleet.profiles": "Saved connection, model, and reasoning choices for workers. Enter adds one.",
	"fleet.agentProfiles": "Choose which saved profile each CLIO Coder agent uses. Enter adds one.",
	"fleet.retry.maxRetries": "Automatic retries for a retryable worker outcome.",
	"fleet.staggerSharedPrefix":
		"On by default; workers that share a prompt prefix start after the leader streams (at most 15 s), so they reuse its cache.",
	"fleet.retry.routeCooldownMs":
		"How long a failing target, runtime, and model route is skipped before it is tried again.",
	"fleet.adaptiveRouting.roles": "Types of worker allowed to use an automatically selected model.",
	"fleet.adaptiveRouting.postures": "Priorities that automatic model selection may use for workers.",
	"fleet.adaptiveRouting.agentRoles": "Specific agents allowed to use automatic model selection.",
	"interface.panes.notifications": "Choose which worker updates show a pane notification.",
	"interface.panes.layout": "Choose which companion panes open when CLIO Coder starts.",
	"interface.panes.workers.ratio": "Share of the width the workers dock takes, at most half.",
	"fleet.history.journal": "Save worker activity so you can inspect finished runs later.",
	"interface.panes.files.enabled":
		"Whether `/files`, its key, and `/panes open files` may open the files pane or the one-shot pick.",
	"interface.panes.files.mode": "Keep the files pane beside the conversation, or close it after one selection.",
	"interface.panes.files.profile": "Use CLIO Coder's theme or your own file manager settings.",
	"interface.panes.files.followCwd": "Keep an open files pane on the same folder as the conversation.",
	"interface.panes.files.ratio": "Share of the height the files dock takes, at most half.",
	"chat.modelPicker.cycleSet": "Models the quick-switch key cycles through.",
	"chat.modelPicker.recentLimit": "How many recently used models /model remembers.",
	"chat.modelPicker.favorites": "Connections and models pinned in the model picker.",
	"safety.limits.sessionCostUsd": "Per-session cost cap.",
	"chat.maxOutputTokens": "Output tokens requested per turn, applied to every target.",
	"context.toolResultMaxBytes": "Maximum bytes returned from one tool result before the full text spills to scratch.",
	"fleet.concurrency": "Maximum number of workers running at the same time.",
	"safety.limits.chatToolCallsPerTurn": "Maximum tool uses CLIO Coder may make during one chat turn.",
	"fleet.limits.toolCallsPerRun": "Maximum tool uses one worker may make during its run.",
	"fleet.history.maxRuns": "How many finished worker runs remain in local history.",
	"safety.limits.readBytesPerCall": "Maximum text one file read may return to the model.",
	"safety.limits.observationBytesPerTurn": "Combined tool output CLIO Coder may read during one turn.",
	"fleet.limits.internalRunTimeoutMs": "Maximum time for one internal worker run.",
	"context.compaction.auto": "Summarize older context automatically before the conversation fills up.",
	"context.compaction.threshold": "How full the model's context can get before CLIO Coder summarizes older content.",
	"context.compaction.provider": "Use native Codex checkpoints when supported; off keeps portable CLIO Coder summaries.",
	"context.compaction.maxTokens":
		"Input token ceiling used to trigger context cleanup independently of the model's window.",
	"context.workingSet.enabled": "Free space by setting aside stale tool output before summarizing the conversation.",
	"context.workingSet.policy": "Choose how CLIO Coder finds old tool output to set aside.",
	"context.workingSet.profile": "Keep extra outputs that matter for the current kind of work.",
	"context.workingSet.target": "How full the context should be after CLIO Coder clears old output.",
	"context.workingSet.protectLastTurns": "Keep tool output from this many recent user turns.",
	"context.workingSet.protectLastSteps": "Keep tool output from this many recent assistant steps.",
	"context.workingSet.minEvictableTokens":
		"Results below this token estimate stay; the marker would cost more than it saves.",
	"context.workingSet.rearmFraction": "Wait for context use to grow by this much before clearing old output again.",
	"chat.retry.enabled": "Automatically retry a chat turn after a transient provider error.",
	"chat.retry.maxRetries": "Retry attempts after the initial failure.",
	"chat.retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"chat.retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"chat.retry.streamStallMs": "How long CLIO Coder waits when a model stops sending text mid-answer.",
	"chat.retry.firstTokenStallMs": "How long CLIO Coder waits for a model to start its answer.",
	"interface.terminalProgress": "Show running-task progress in terminals that support tab or taskbar badges.",
	"interface.outputDetail": "How much reasoning, tool input, and live tool output appears in the transcript.",
	"interface.mode": "Use regular terminal scrollback or a fullscreen transcript with a sticky composer and footer.",
	"interface.fullscreenScrollbar": "When the draggable transcript scrollbar is visible in fullscreen mode.",
	"interface.smoothStreaming": "Presentation-only pacing for streamed assistant text and thinking.",
	"interface.desktopNotifications":
		"Content-free desktop notification when a turn ends, a detached batch settles, or an approval parks.",
	"safety.review.enabled": "After CLIO Coder changes files, ask a read-only reviewer to check the work.",
	"safety.review.target": "Connection used for the review. Leave blank to use the chat connection.",
	"safety.review.cadenceToolCalls":
		"Also review during a long turn after this many tool uses; leave blank for an end-of-turn review only.",
	"integrations.runtimePlugins":
		"Additional runtime plugin packages loaded when CLIO Coder starts. Install and enable only packages you trust.",
	"context.compaction.model": "Model used to summarize older conversation. Leave blank to use the chat model.",
	"context.compaction.systemPrompt":
		"Optional file with custom summarizing instructions. Leave blank for CLIO Coder's built-in instructions.",
	"integrations.externalAgents.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"integrations.externalAgents.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"integrations.externalAgents.defaults.permissionTimeoutMs":
		"How long CLIO Coder waits for your answer to an external agent's permission request.",
	targets: "Inference targets available for chat and workers. Add one with `clio-coder targets add`.",
	"interface.keybindings": "Custom key overrides layered on the defaults.",
	"integrations.externalAgents.entries": "Other coding agents you can call through /run.",
	"integrations.library.catalog": "Path to the private resource catalog; blank uses the one in your config directory.",
	"integrations.library.remote": "Git remote the catalog syncs with; blank keeps the library entirely local.",
	"integrations.library.confirmedRemote":
		"The remote you approved. Syncing waits until it matches the current library remote.",
	"integrations.library.sync": "Whether `clio-coder library sync` and `push` may talk to the remote at all.",
} as const satisfies Record<keyof typeof SETTINGS_LABELS_BY_ID, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
export const SETTINGS_HELP_BY_ID: Partial<Record<string, string>> = {
	"safety.autonomy":
		"Default edits the workspace, dispatches routine work, and runs your shell commands without asking inside an OS sandbox where the host has one (workspace and scratch roots writable, credentials hidden). Commands that leave the sandbox, outward actions and former hard blocks are first reviewed by the safety judge against your requests, larger dispatch plans ask you, and destructive workspace operations run after a snapshot /rewind can undo. Yolo shows no approval cards: it keeps default's sandbox and safety judge, and a call that would need your approval is refused back to CLIO Coder instead. Both modes still ask you questions. Unconfined yolo (safety.yoloConfinement, accepted once) skips approvals and the sandbox; only the yolo floor and rules in an approved .clio-coder/safety.yaml block. Yolo's first activation asks you to accept it once, and it is refused as root outside a container.",
	"chat.maxOutputTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"context.toolResultMaxBytes":
		"At least 4 KB. The Tool output per turn limit still caps the whole turn, even if this per-result limit is higher.",
	"context.compaction.threshold":
		"Choose how full the model's context may get. A higher percentage keeps more history but leaves less room for the next answer.",
	"context.compaction.maxTokens":
		"Whole number of at least 1 · default: 400000 tokens. A lower ceiling limits input cost by triggering cleanup sooner, even when the model has a larger context window.",
	"context.workingSet.enabled":
		"Old tool output is set aside without changing chat history. When off, CLIO Coder waits until it needs to summarize the conversation.",
	"context.workingSet.policy":
		"Current structure also protects output the model returned to twice. Classic structure uses the older selection rule. Age only clears the oldest eligible output first.",
	"context.workingSet.profile":
		"Data analysis keeps recent numeric command output. Web design keeps recently read stylesheets and components. Default adds no special protection.",
	"context.workingSet.target":
		"Choose a percentage below the summarize threshold. CLIO Coder keeps clearing eligible output until context use falls to this level.",
	"context.workingSet.protectLastTurns": "Counted in user turns. Whole number of at least 1 · default: 6.",
	"context.workingSet.protectLastSteps":
		"Counted in assistant steps inside the turn window, so a long agentic turn stays evictable. Whole number of at least 1 · default: 8.",
	"context.workingSet.minEvictableTokens":
		"Smaller outputs stay in context because replacing them saves little space. Choose 0 to allow every size.",
	"context.workingSet.rearmFraction":
		"CLIO Coder waits for context use to grow by this percentage after clearing output. Choose 0 to allow another cleanup immediately.",
	"safety.limits.chatToolCallsPerTurn":
		"CLIO Coder stops using tools and summarizes the turn when it reaches this limit. Whole number of at least 1.",
	"fleet.limits.toolCallsPerRun":
		"Only tools that actually ran count. A worker's own smaller limit still applies. Whole number of at least 1.",
	"fleet.history.maxRuns":
		"When history fills, the oldest run and its event log are removed. Whole number of at least 1.",
	"safety.limits.readBytesPerCall":
		"Enter a number of bytes. CLIO Coder reads at least 1 KB even if you choose a smaller value.",
	"safety.limits.observationBytesPerTurn":
		"Shared by every tool in the turn. At the default, the pool grows with the model's context window above 128K tokens, up to 1 MB. Any other value applies exactly. Enter a whole number of bytes, at least 1.",
	"fleet.limits.internalRunTimeoutMs":
		"Ends an internal worker run that never finishes, including the wiki writer and first project Scout. Enter at least 1 millisecond.",
	"chat.retry.streamStallMs":
		"The timer resets whenever text arrives. If it expires, CLIO Coder can retry according to the retry settings above.",
	"chat.retry.firstTokenStallMs":
		"Time allowed before the first text arrives from a local or self-hosted endpoint, which may need to load a model first. Hosted services use the mid-stream wait. Choose 0 to wait indefinitely on every route.",
	"integrations.library.catalog":
		"Absolute path, or blank for the catalog in your config directory. The catalog is the index `clio-coder library` reads; installed resources land in the usual skill and resource roots either way. Default: blank.",
	"integrations.library.remote":
		"Enter a Git remote URL, or leave blank to keep the library local. Confirm the remote and turn on syncing before CLIO Coder uses it.",
	"integrations.library.confirmedRemote":
		"CLIO Coder records this after you confirm the library remote. It must match the selected remote before syncing is allowed.",
	"integrations.library.sync":
		"When off, library sync and push stop before contacting the remote, even if one is configured.",
	"fleet.concurrency":
		"Automatic chooses a limit from available CPU and memory, up to eight workers. Choose a number to set a fixed limit.",
	"integrations.projectResources.trustProjectImports":
		"Applies to foreign packages explicitly imported into CLIO Coder, at user or project scope. Loose skills/prompts in other agents' folders stay discovery-only; this setting never imports them.",
	"integrations.git.commitAttribution":
		"Role trailers are added only when CLIO Coder has trusted evidence for that role. Disabling leaves subsequent commit messages entirely unchanged.",
	"integrations.git.commitAuthor":
		"Automatic makes CLIO Coder the author of autonomous commits, with you as committer and a Co-authored-by trailer naming you. Interactive sessions always keep you as the author. Needs commit credit on and a configured user.name and user.email; an author you or the command chose always wins.",
	"fleet.permissions.mode":
		"Safety judge reviews the call against your own messages while CLIO Coder runs at default; it runs on an allow and is denied on a block or when the judge gives no verdict. Deny the tool lets the worker continue without it. Stop the worker ends the run. Ask me waits for your answer, then uses the fallback choice if time runs out.",
	"fleet.permissions.escalation.timeoutMs":
		"Used only when workers ask you. A key on the card holds it for up to 15 minutes. In sessions with nobody available to answer, the fallback applies. Enter at least 1 millisecond.",
	"fleet.permissions.escalation.fallback":
		"Deny the tool lets the worker continue without it. Stop the worker ends the run.",
	"fleet.retry.routeCooldownMs":
		"After repeated failures, CLIO Coder waits before trying the same connection and model again. A successful run clears the wait. Choose 0 to disable it.",
	"fleet.adaptiveRouting.roles":
		"Automatic model selection only takes effect when both the worker role and its priority are enabled. Otherwise CLIO Coder records its suggestion without using it. Choose researcher, verifier, reviewer, or judge.",
	"fleet.adaptiveRouting.postures":
		"Choose which priorities may select a model automatically: quality, balanced, speed, or lower cost. Manually chosen models stay fixed.",
	"fleet.adaptiveRouting.agentRoles":
		"Each entry names one agent and worker role. Edit these pairs in the settings file. The agent name auto is reserved.",
	"chat.prewarm":
		"For a supported local connection, prepare the next prompt when a session starts, resumes, or finishes summarizing. It does not run during an active turn.",
	"fleet.agentProfiles":
		"Bind base, custom, and shadow native agents such as scout, researcher, and provenance to profiles. ACP delegation agents cannot be bound.",
	"integrations.externalAgents.defaults.toolGovernance":
		"CLIO Coder permissions check external agent tools. Agent permissions let that agent decide. Deny all tools blocks every tool request.",
	"chat.modelPicker.cycleSet":
		"Choose connections or specific models. The model switch shortcut cycles through this list.",
	"integrations.runtimePlugins": "Comma-separated package names, loaded at startup. Restart CLIO Coder after changing.",
	"interface.desktopNotifications":
		"Supported terminals show a brief desktop alert. Alerts never include your prompt, file paths, or model output.",
	"safety.review.enabled":
		"The reviewer reads the files changed during the turn and reports blockers in the transcript. It runs in interactive sessions only.",
	"safety.review.target": "Choose a connection for the reviewer. Leave blank to use the current chat connection.",
	"safety.review.cadenceToolCalls":
		"Set a tool count to check work during a long turn. Leave blank to review only when the turn ends.",
	"interface.keybindings":
		"Alt+O cycles output detail: Minimal, Default, Detailed across terminal surfaces. Use /view for full reasoning and action details. Shift+Tab changes model thinking effort.",
};

/** Per-value meaning, surfaced for the current value of an enum knob. */
export const SETTINGS_VALUE_HELP_BY_ID: Partial<Record<string, Record<string, string>>> = {
	"safety.autonomy": {
		default:
			"workspace edits, reads anywhere outside secret paths, and shell commands inside the OS sandbox run (without a sandbox, only recognized commands); outward actions, commands that leave the sandbox and former hard blocks go to the safety judge; larger dispatch plans and project settings ask you",
		yolo:
			"everything runs without asking, unsandboxed by default; only the yolo floor and your approved safety.yaml rules block",
	},
	"fleet.permissions.mode": {
		deny: "the worker skips the blocked tool and continues",
		fail: "the worker stops and reports that permission was needed",
		escalate: "CLIO Coder asks you; if you do not answer in time, it uses the fallback choice below",
		judge:
			"the safety judge reviews the call against your own messages at autonomy default; a block or no verdict denies it, and with the judge off the call is denied",
	},
	"fleet.permissions.escalation.fallback": {
		deny: "the worker skips the blocked tool and continues",
		fail: "the worker stops and reports that permission was needed",
	},
	"chat.prewarm": {
		true: "prepare the next prompt on supported local connections",
		false: "wait until you send the next message before preparing it",
	},
	"context.workingSet.enabled": {
		true: "set old tool output aside before summarizing the conversation",
		false: "keep tool output until the conversation needs a summary",
	},
	"context.workingSet.policy": {
		"structural-v1": "choose output based on where it appears in the conversation",
		"structural-v2": "also keep output that the model returned to more than once",
		"age-horizon": "choose the oldest eligible output first",
	},
	"context.workingSet.profile": {
		default: "keep only CLIO Coder's essential context",
		"data-analysis": "also keep three recent command outputs with numbers",
		"web-design": "also keep recently read stylesheets and components",
	},
	"integrations.library.sync": {
		true: "allow `clio-coder library sync` and `push` to reach the confirmed remote",
		false: "refuse every library network operation",
	},
	"integrations.externalAgents.defaults.toolGovernance": {
		"clio-coder-policy": "CLIO Coder's safety policy gates the delegated agent's tools",
		"agent-managed": "the external agent governs its own tools",
		"deny-all": "block every tool the delegated agent requests",
	},
	"context.compaction.auto": {
		true: "compact automatically before a turn crosses the threshold",
		false: "context is only compacted when you run /context compact",
	},
	"chat.retry.enabled": {
		true: "retry transient provider errors automatically",
		false: "surface transient errors immediately without retrying",
	},
	"integrations.projectResources.trustProjectImports": {
		true: "allow explicitly imported foreign skills and prompts",
		false: "keep imported foreign skills and prompts inactive",
	},
	"integrations.git.commitAttribution": {
		enabled: "add only the CLIO Coder role trailers justified by trusted evidence",
		disabled: "leave every subsequent commit message byte-for-byte unchanged",
	},
	"integrations.git.commitAuthor": {
		auto: "CLIO Coder authors autonomous commits and credits you as co-author",
		human: "you author every commit; CLIO Coder is credited only by trailers",
	},
	"interface.terminalProgress": {
		true: "show progress in a supported terminal tab or taskbar",
		false: "no terminal progress badges",
	},
	"interface.outputDetail": {
		compact: "quiet action summaries, answers, and visible failures",
		standard: "short reasoning and change previews, clear action outcomes",
		detailed: "larger bounded previews; full content is available in /view",
	},
	"interface.mode": {
		regular: "preserve terminal scrollback and render the composer below the transcript",
		fullscreen: "use the alternate screen with an independently scrollable transcript and sticky composer/footer",
	},
	"interface.fullscreenScrollbar": {
		hidden: "never draw the fullscreen transcript scrollbar",
		auto: "show the scrollbar while scrolling or dragging",
		always: "reserve the rightmost column for the scrollbar",
	},
	"interface.desktopNotifications": {
		true: "post a content-free desktop notification on turn end, batch settlement, and a parked approval",
		false: "never post a desktop notification",
	},
	"safety.review.enabled": {
		true: "review every mutating turn with one read-only verifier run",
		false: "no verifier run; a turn ends without a second opinion",
	},
	"interface.smoothStreaming": {
		off: "show each chunk of text as soon as it is ready",
		auto: "smooth text when the terminal supports it",
		on: "smooth text as it appears, pausing if the terminal falls behind",
	},
};

/**
 * The settings path a Settings Center row edits. A guided row's id is its path; a raw row is `setting.<path>`, so it
 * never collides with the guided row for the same collection.
 */
export function settingsPathForRow(id: string): string {
	return id.startsWith("setting.") ? id.slice("setting.".length) : id;
}

export interface SettingControl {
	path: string;
	label: string;
	description: string;
	help?: string | undefined;
	choices?: readonly string[] | undefined;
	kind: "boolean" | "number" | "string" | "list" | "json";
	optional: boolean;
	readOnly: boolean;
	/** Has a `/settings` row (hand-written or generated). A leaf without it lives only in the file. */
	menu?: true;
}

/**
 * Leaves that earn a generated `/settings` row. Every other leaf without a
 * hand-written row stays valid in settings.yaml, `config inspect` and
 * `configure`, and is reached through "Edit settings file".
 */
const MENU_ROWS = new Set([
	"fleet.defaultNode",
	"fleet.default.node",
	"turnControl.workflows",
	"chat.cacheKeepalive",
	"chat.loopsUntilStopped",
	"chat.steering.triage.enabled",
	"fleet.worktrees.root",
	"context.memory.surfaces.observe",
	"context.memory.surfaces.delivery",
	"context.memory.surfaces.lessons",
	"context.memory.surfaces.correct",
	"context.memory.surfaces.bank",
	"context.memory.sideShare",
	"context.memory.surfaces.history",
	"context.memory.thinkingLevel",
	"context.semantic.enabled",
	"context.semantic.target",
	"context.semantic.model",
	"context.semantic.background",
	"safety.limits.workerResponseSeconds",
	"safety.limits.autonomousToolCalls",
	"safety.limits.autonomousMinutes",
	"safety.limits.autonomousTokens",
	"safety.limits.bashIdleSeconds",
	"safety.sandbox",
	"safety.sandboxNetwork",
	"safety.scratchRoots",
	"safety.sandboxCacheMaxGiB",
	"safety.snapshots",
	"safety.unattendedAfterSeconds",
	"safety.yoloConfinement",
	"safety.judge.enabled",
	"safety.judge.target",
	"safety.judge.model",
	"interface.exitSummary",
	"interface.demo",
	"interface.autoUpdate",
	"integrations.music.enabled",
	"telemetry.mode",
	"report.offers",
	"prompts.profile",
	"systemOne.use",
]);

/** Hand-written rows that left the menu; their leaves stay valid in the file. */
export const OFF_MENU_HAND_ROWS: ReadonlySet<string> = new Set([
	"interface.keybindings",
	"fleet.adaptiveRouting.agentRoles",
	"context.memory.trajectorySteps",
	"context.memory.maxOutputTokens",
	"context.memory.timeoutMs",
	"context.workingSet.policy",
	"context.workingSet.protectLastSteps",
	"context.workingSet.minEvictableTokens",
	"context.workingSet.rearmFraction",
	"fleet.retry.routeCooldownMs",
	"chat.modelPicker.favorites",
	"integrations.library.confirmedRemote",
]);

const CHOICES: Record<string, readonly string[]> = {
	"integrations.git.commitAuthor": ["auto", "human"],
	"interface.exitSummary": ["auto", "brief", "standard", "report", "off"],
	"telemetry.mode": ["standard", "research"],
	"report.offers": ["ask", "off"],
	"prompts.profile": ["v1", "v2"],
	"safety.autonomy": ["default", "yolo"],
	"safety.yoloConfinement": ["contained", "unconfined"],
	"safety.sandbox": ["auto", "required", "off"],
	"safety.sandboxUnixSockets": ["block", "owned", "allow"],
	"safety.snapshots": ["auto", "off"],
	"chat.thinkingLevel": THINKING_LEVELS,
	"fleet.default.thinkingLevel": THINKING_LEVELS,
	"chat.steering.triage.thinkingLevel": THINKING_LEVELS,
	"context.memory.thinkingLevel": THINKING_LEVELS,
	"context.memory.surfaces.observe": ["off", "on"],
	"context.memory.surfaces.delivery": ["off", "section", "decision", "broadcast"],
	"context.memory.surfaces.lessons": ["agent", "rules", "side", "off"],
	"context.memory.surfaces.correct": ["rules", "model"],
	"context.memory.surfaces.bank": ["rules", "model"],
	"context.memory.surfaces.history": ["off", "on"],
	"fleet.permissions.mode": ["judge", "deny", "escalate", "fail", "main"],
	"fleet.permissions.escalation.fallback": ["deny", "fail"],
	"interface.mode": ["regular", "fullscreen"],
	"interface.outputDetail": ["compact", "standard", "detailed"],
	"interface.fullscreenScrollbar": ["hidden", "auto", "always"],
	"interface.smoothStreaming": ["off", "auto", "on"],
	"interface.panes.layout": ["off", "workers", "cockpit"],
	"interface.panes.notifications": ["failures", "all", "off"],
	"interface.panes.files.mode": ["companion", "chooser"],
	"interface.panes.files.profile": ["managed", "user"],
	"context.compaction.provider": ["off", "native"],
	"context.workingSet.policy": ["structural-v1", "structural-v2", "age-horizon"],
	"context.workingSet.profile": ["default", "data-analysis", "web-design"],
	"integrations.externalAgents.defaults.toolGovernance": ["clio-coder-policy", "agent-managed", "deny-all"],
};
const STRUCTURED = new Set([
	"models",
	"context.semantic.inboxes",
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.nodes",
	"fleet.adaptiveRouting.agentRoles",
	"interface.keybindings",
	"integrations.externalAgents.entries",
]);
const OPTIONAL_NUMBERS = new Set(["safety.review.cadenceToolCalls"]);
const NULLABLE_NUMBERS = new Set<string>([
	"safety.limits.templateToolCallsPerTurnMax",
	"safety.limits.templateObservationBytesPerTurnMax",
]);
const OPTIONAL_STRINGS = new Set([
	"fleet.default.node",
	"safety.review.target",
	"context.compaction.model",
	"context.compaction.systemPrompt",
]);
const EXTRA_HELP: Record<string, [string, string]> = {
	"context.compaction.provider": [
		"Provider compaction",
		"Use private native checkpoints on compatible Codex routes. Off uses portable CLIO Coder summaries; switching routes generates a portable summary from the retained history.",
	],
	"safety.limits.workerResponseSeconds": [
		"Worker response time",
		"Seconds one native worker model response may run, including locked synthesis rounds.",
	],
	"safety.limits.templateToolCallsPerTurnMax": [
		"Template tool calls ceiling",
		"How many tool calls a prompt template's budget may give its turn when it asks for more than Tools per chat turn. Empty lets a template only lower that limit.",
	],
	"safety.limits.templateObservationBytesPerTurnMax": [
		"Template tool output ceiling",
		"How many bytes of tool output a prompt template's budget may give its turn when it asks for more than Tool output per turn. Empty lets a template only lower that limit.",
	],
	"safety.limits.autonomousToolCalls": [
		"Yolo stretch tool calls",
		"Tool calls one yolo stretch runs before it pauses for you to resume; 0 turns this cap off.",
	],
	"safety.limits.autonomousMinutes": [
		"Yolo stretch minutes",
		"Minutes of active turn time one yolo stretch runs before it pauses for you to resume; 0 turns this cap off.",
	],
	"safety.limits.autonomousTokens": [
		"Yolo stretch tokens",
		"Tokens one yolo stretch spends before it pauses for you to resume; 0 turns this cap off.",
	],
	"safety.limits.bashIdleSeconds": [
		"Bash idle timeout",
		"Seconds a foreground bash command may run with no output and no CPU use before it is stopped as idle; 0 turns this off.",
	],
	"context.semantic.enabled": [
		"Semantic search",
		"Make the optional project search index available to CLIO Coder after pinning a qualified embedding route.",
	],
	"context.semantic.target": ["Embedding connection", "Target id of the qualified embedding route."],
	"context.semantic.model": ["Embedding model", "Exact model id served by the embedding target."],
	"context.semantic.assetIdentity": ["Embedding asset identity", "GGUF SHA-256 or a visible unverified operator label."],
	"context.semantic.projectorIdentity": [
		"Embedding projector identity",
		"Projector SHA-256 or operator label when using image or audio inputs.",
	],
	"context.semantic.canaryFingerprint": [
		"Embedding canary fingerprint",
		"Fixed canary result from semantic configure --qualify; a changed fingerprint selects a new index space.",
	],
	"context.semantic.modalities": ["Indexed media types", "Select text, image, audio, or mixed after qualification."],
	"context.semantic.background": [
		"Refresh semantic index in background",
		"Schedule bounded refresh at session start and after code map changes.",
	],
	"context.semantic.inboxes": [
		"Artifact inboxes",
		"Registered source folders. Prefer semantic inbox preview/add/remove for guided changes.",
	],
	"context.memory.surfaces.observe": [
		"Continuity preparation",
		"Let the memory model condense older turns in the background so compaction can reuse that record instead of summarizing them again. Starts only near a compaction that would send history to a separate summary request. Needs proactive memory on; off by default.",
	],
	"context.memory.surfaces.delivery": [
		"Lesson delivery",
		"Where kept lessons reach the model: off, the Memory section only, the section plus reminders at decision points (a failed command, a verification gap, a touched file, the turn's task), or those plus the first-change broadcast. Decision by default; memory_recall works in every mode.",
	],
	"context.memory.surfaces.lessons": [
		"Note authorship",
		"Who writes notes for later sessions: agent (the main agent gets memory_note in sessions that start with it, and CLIO Coder binds its command or read as evidence), rules (CLIO Coder files a failed command and the option change that fixed it), side (adds the memory model's lesson pass, only after such a fix), or off. Agent by default as a policy choice, not a measured win.",
	],
	"context.memory.surfaces.correct": [
		"Correction tier",
		"Rules, the default, warns after a repeated failure with no model call. Model also asks the memory model after two tool errors in a row or a loop-guard block. Rules by default as a policy choice: the model tier was measured costing calls without producing reminders.",
	],
	"context.memory.surfaces.bank": [
		"Task bank tier",
		"Rules, the default, records failures and operator statements in the task bank with no model call. Model also asks the memory model to maintain the bank every cadence of tool calls. Rules by default as a policy choice: the model tier's product was rarely read.",
	],
	"context.memory.sideShare": [
		"Memory side share",
		"After three automatic memory calls, a session skips more while its memory output tokens (and premium units, where the route reports them) exceed this share of its main output. Calls you ask for, such as remember, are never skipped. 0 turns the governor off.",
	],
	"context.memory.surfaces.history": [
		"History mining",
		"Let the memory model read the repository's earlier sessions while this one is idle and file the lessons it finds. Off by default; clio-coder memory consolidate tidies the store without a model call either way.",
	],
	"context.memory.thinkingLevel": [
		"Memory thinking",
		"How much the memory model reasons before it writes a memory step. Off, the default, asks for no reasoning; reasoning spends the memory output budget, and a model that cannot use the chosen level gets its nearest supported one, as in chat.",
	],
	"integrations.music.enabled": [
		"Music pane",
		"Allow /music to open cliamp in a docked pane and play focus radio. Needs Herdr panes and cliamp; off by default.",
	],
	"integrations.music.station": [
		"Music station",
		"What /music on plays: a stream URL or a station name looked up in Radio Browser.",
	],
	"integrations.music.agentControl": [
		"CLIO Coder controls music",
		"Give CLIO Coder a music tool to start, stop or skip the station on its own. When it is off the tool is not registered and costs no prompt bytes.",
	],
	"interface.exitSummary": [
		"Session summary on exit",
		"Auto follows output style: compact gives a brief summary, standard gives activity and usage, detailed gives a one-page report. Choose brief, standard or report to override; off shows only how to resume.",
	],
	"safety.sandbox": [
		"Command sandbox",
		"Run shell commands in an OS sandbox. At autonomy default your session's commands may write the workspace, scratch roots and package caches, with the network on and credentials hidden, and run without asking; dispatched workers' commands write only the run's writable roots and a private /tmp. auto uses it when available, required refuses worker commands without it, off never sandboxes. Under required, scripts the yolo session runs are sandboxed too, or refused without a backend.",
	],
	"safety.sandboxNetwork": [
		"Worker sandbox network",
		"Let sandboxed worker commands reach the network. Workers that have web_fetch get network either way.",
	],
	"safety.snapshots": [
		"Workspace snapshots",
		"Before CLIO Coder first changes files in a turn, and before every destructive command, save the Git work tree as a private snapshot so /rewind can restore the files. Ignored files and untracked files over 16 MiB are left out. Your index, HEAD and branches are never touched. Off takes no snapshots.",
	],
	"safety.unattendedAfterSeconds": [
		"Unattended timeout",
		"Seconds a permission card or ask_user question waits for you before CLIO Coder resolves it and keeps working: the parked call is denied, each unanswered question takes its recommended option unless that option leaves the workspace, and the session summary counts both. Any key on the card or question holds it. 0 waits forever, except that a yolo question waits 300 s at most, and after one lapses with no key pressed since, later questions wait at most 30 s. User settings only.",
	],
	"safety.yoloAccepted": [
		"Yolo accepted",
		"Set when you accept the one-time card that turns yolo on. Turn it off to see the card again. User settings only.",
	],
	"safety.yoloConfinement": [
		"Yolo confinement",
		"contained keeps default's sandbox, snapshots and safety judge, and refuses back to the agent what would wait for you, so nothing stops. unconfined is the skip-permissions yolo: no sandbox unless safety.sandbox is required, only the yolo floor and your approved safety.yaml rules block, and it has its own one-time card. User settings only.",
	],
	"safety.yoloUnconfinedAccepted": [
		"Unconfined yolo accepted",
		"Set when you accept the separate card for unconfined yolo; unconfined takes effect only when this is on, headless runs included. Turn it off to see that card again. User settings only.",
	],
	"safety.judge.enabled": [
		"Safety judge",
		"At autonomy default, a model reviews each call that would need your approval against your own messages, then runs it or refuses it back to CLIO Coder with a reason. It asks you when it cannot decide, and after 3 refusals in a row or 20 in a session. User settings only.",
	],
	"safety.judge.target": [
		"Safety judge connection",
		"Connection the safety judge asks. Leave blank to use the chat connection. User settings only.",
	],
	"safety.judge.model": [
		"Safety judge model",
		"Model the safety judge asks. Leave blank to use the chat model, or the judge connection's default model. User settings only.",
	],
	"safety.judge.environment": [
		"Safety judge environment",
		"Facts about your environment the judge reads, such as 'shared HPC cluster; /scratch/$USER is mine'. User settings only.",
	],
	"safety.judge.allow": [
		"Safety judge allow rules",
		"Extra kinds of call the judge may run without your explicit request, added to its default rules. User settings only.",
	],
	"safety.judge.deny": [
		"Safety judge block rules",
		"Extra kinds of call the judge refuses unless you ask for that action, added to its default rules. User settings only.",
	],
	"safety.sandboxPassEnv": [
		"Sandbox environment pass-through",
		"Environment variables your sandboxed commands keep although they look like credentials. Every other token, key, password and URL with a password is removed before a sandboxed command starts, because it can reach the network without asking. User settings only.",
	],
	"safety.liveCheckTargets": [
		"Live-check login targets",
		"Target ids whose own login file your sandboxed commands may read, read-only, so a live check of a build can sign in (copilot-sdk targets: the official copilot login in $COPILOT_HOME/config.json). Dispatched workers keep it hidden. User settings only.",
	],
	"safety.sandboxUnixSockets": [
		"Sandbox unix sockets",
		"Block stops sandboxed commands from opening Unix sockets, because a socket they can reach (tmux, an X11 display, a daemon's control socket) can run commands outside the sandbox. Database sockets, Docker and other local IPC then fail inside it, and a command that needs one runs unsandboxed after review. Owned hides only the sockets you own (tmux, an X11 socket file, your agents) and leaves other users' reachable, such as the MUNGE and SSSD sockets cluster commands need; abstract sockets stay reachable. Allow leaves every socket reachable. User settings only.",
	],
	"safety.validationWrappers": [
		"Validation wrappers",
		"Wrapper scripts that run a check with the words after them, such as a test-slot or CI launcher: a path matches that script, a bare name its basename. A command starting with one counts as the check it runs, so a finish after it is not assessed as unvalidated; the run still counts as a change, since the wrapper may write. A file writer, a shell, an interpreter, echo, cat, xargs and similar words are refused.",
	],
	"fleet.keepPeerInstructionFiles": [
		"Peers that keep their own instruction files",
		"Runtime ids (codex-cli, pi-cli, opencode-cli) of delegated harnesses that read their own repository instruction files unchanged, with the rules CLIO Coder compiled for the run beside them. Others read the compiled rules in place of their files; claude-code always reads its own beside them.",
	],
	"safety.scratchRoots": [
		"Scratch roots",
		"Absolute directories your sandboxed commands and file edits may write at autonomy default without asking, and where deletes run as they do in the workspace. TMPDIR, /tmp and /var/tmp always count. User settings only.",
	],
	"safety.sandboxCacheMaxGiB": [
		"Sandbox cache cap (GiB)",
		"Size the sandbox's own tool cache (npm, pnpm, pip, uv and Playwright downloads of your sandboxed commands) may reach. Once a day at startup, and on clio-coder doctor --fix, the least recently used tool folders are removed until it fits, never while a running session may use them. 0 is no cap. User settings only.",
	],
	"interface.demo": [
		"Demo presentation and guidance",
		"Welcome presentation and optional learning tips, bounded by output detail. Minimal stays quiet; Default shows a compact launchpad; Detailed adds artwork and shortcut hints. Off starts with an identity header, skips welcome-only reads, and stops tips and the guidance profile. Immediate controls and warnings remain. Stream pacing, motion preferences and permissions are independent.",
	],
	"interface.guiTurnCapacity": [
		"Graphical app turns at once",
		"How many tasks in the graphical app may run a turn at the same time, from 1 to 16. Further requests are recorded in their task and start in order as running turns finish. Open tasks are not limited. A change made in the app applies to its next turn; a change made elsewhere applies when the app's server restarts.",
	],
	"interface.autoUpdate": [
		"Background updates",
		"A native install fetches and activates a newer release in the background; running sessions keep their version until restart, and upgrade --rollback undoes it. Off keeps the update notice and leaves the install to clio-coder upgrade. Package-manager installs only ever show their upgrade command.",
	],
	"integrations.externalAgents.entries": [
		"Custom agent definitions",
		"Add an external coding agent with its launch command and options as JSON. The command runs when you connect, so choose agents you trust. Use Available agents for guided setup.",
	],
	"fleet.default.node": [
		"Default worker location",
		"Where workers run unless their profile says otherwise. Enter local or a configured remote machine name; clear to let CLIO Coder choose.",
	],
	"fleet.profiles": [
		"Worker profiles",
		"Named target, model, thinking, and placement choices. Use Fleet's profile actions for guided edits, or edit this JSON object.",
	],
	models: [
		"Model tiers",
		'Map a model id to its tier (small, standard or frontier) for hooks and prompt template variants, as JSON such as {"qwen3-32b": {"tier": "small"}}. Unlisted models get a tier from their context window, size and catalog entry.',
	],
	"fleet.agentProfiles": [
		"Agent profile assignments",
		"Map native agent names to existing worker profile names. Use Fleet's binding actions or edit this JSON object.",
	],
	"chat.steering.triage.enabled": [
		"Steering triage",
		"Experimental. Once messages queued during a run settle, a side model reads them: an unrelated task waits for the end of the turn and a confident stop may interrupt the run. Off, every queued message lands where your key put it.",
	],
	"chat.steering.triage.target": [
		"Steering triage connection",
		"Connection the triage round uses. Empty uses the session's active connection.",
	],
	"chat.steering.triage.model": [
		"Steering triage model",
		"Model the triage round asks on that connection. Empty uses the connection's default model.",
	],
	"chat.steering.triage.thinkingLevel": [
		"Steering triage thinking",
		"How much the triage model reasons before it labels the queue. Off, the default, asks for no reasoning; a model that cannot use the chosen level gets its nearest supported one, as in chat.",
	],
	"chat.steering.triage.minQueued": [
		"Steering triage queue size",
		"Queued messages that start a triage round. Fewer are delivered as queued without a round.",
	],
	"chat.steering.triage.timeoutMs": [
		"Steering triage timeout",
		"Milliseconds a triage round may take before its answer is dropped and the queue stays as you left it.",
	],
	"chat.steering.triage.autoInterrupt": [
		"Steering triage may interrupt",
		"Let a confident stop reading cancel the run and deliver that message now. Off, it is only marked as urgent in the queue panel.",
	],
	"telemetry.mode": [
		"Telemetry mode",
		"Standard keeps call accounting and operational records without prompts, replies or other content. Research adds the capture switches below for this machine's sessions. Accountability records are kept in both modes. A project file can only lower it.",
	],
	"telemetry.research.content": [
		"Research: capture content",
		"In research mode, also keep content in the session's telemetry objects with secrets removed: the text of each distinct system prompt CLIO Coder compiles, the body of each provider request (only its first 1 MiB when larger), and the prompts, replies and facts of background memory and compaction steps. Takes effect only in a workspace you consented for with clio-coder telemetry consent.",
	],
	"telemetry.research.deltas": [
		"Research: token timing",
		"In research mode, record each provider call's streaming timing: how many deltas it produced, a histogram of the gaps between them, the longest gap and the first-to-last span. No streamed text is kept.",
	],
	"telemetry.research.providerHeaders": [
		"Research: provider headers",
		"In research mode, record each provider call's response status and its allow-listed response headers: rate-limit and quota windows, request ids and server timing, each value cut to 256 characters. Cookies, auth echoes and every other header are never kept.",
	],
	"telemetry.research.busTrace": [
		"Research: bus trace",
		"In research mode, journal the name of every live event the telemetry hub delivers as a bus.traced record.",
	],
	"prompts.profile": [
		"Prompt profile",
		"Main-agent system prompt text: v1 is the current text, v2 the D-02 rewrite under evaluation. Applies from the next turn, which rereads the whole prompt once.",
	],
	"report.offers": [
		"Suggest reports",
		"When CLIO Coder itself fails, such as an internal error or a crash, it may suggest /report: at most once a session and once a week, and never again for a problem you declined. Off never suggests. Nothing is sent without your keypress.",
	],
	"turnControl.workflows": [
		"Before CLIO Coder answers",
		"Choose whether CLIO Coder collects finished background runs before answering.",
	],
	"fleet.rosters": [
		"Fleet rosters",
		"Named teams of worker profiles used by council and fleet runs. Edit the JSON object; each roster names its members.",
	],
	"fleet.defaultNode": [
		"Standing worker node preference",
		"Unpinned work stays local until chosen. Explicit and profile pins take priority; leave blank to allow a session placement question.",
	],
	"fleet.nodes": [
		"Remote worker machines",
		"Machines where workers may run. Edit the JSON list of machine details; adding one does not change the default model.",
	],
	"fleet.worktrees.root": [
		"Where task copies live",
		"Choose disk for the normal location, memory for temporary RAM storage, automatic to prefer memory when available, or enter an absolute directory you control.",
	],
	"chat.cacheKeepalive": [
		"Keep prompt cache warm",
		"While a turn waits on its own tools, such as an attached dispatch, refresh a hosted provider's prompt cache shortly before it expires when that is expected to save more than it costs. Applies to Anthropic, OpenAI and Codex routes.",
	],
	"chat.loopsUntilStopped": [
		"Loops run until stopped",
		"A /loop or job created without --count or --for keeps running until you run /loop stop, or its --until condition matches. The cost ceiling and loop guard still apply.",
	],
	"systemOne.use": [
		"Decision engine",
		"Experimental opt-in. Off until chosen. Names what answers the consult tool, the judge screen and steering triage, one route or an ordered list: jev, memory, main, a declared engine or a target. Applies on the next start. A hosted route receives web and MCP result text at judge time.",
	],
	"fleet.retry.breakerThreshold": [
		"Failures before cooldown",
		"Consecutive route failures before CLIO Coder temporarily stops sending work to that route. A healthy request clears the failure count.",
	],
};

function collectControlPaths(value: unknown, prefix = ""): string[] {
	if (prefix && (STRUCTURED.has(prefix) || value === null || typeof value !== "object" || Array.isArray(value)))
		return [prefix];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
		collectControlPaths(child, prefix ? `${prefix}.${key}` : key),
	);
}

/** The shared UI catalog uses the existing settings schema; it creates no new persisted keys. */
export const SETTING_CONTROLS: readonly SettingControl[] = (() => {
	const metadata = new Map(
		Object.keys(SETTINGS_LABELS_BY_ID).map((id) => [settingsPathForRow(id), id as keyof typeof SETTINGS_LABELS_BY_ID]),
	);
	const paths = new Set([...collectControlPaths(DEFAULT_SETTINGS), ...OPTIONAL_NUMBERS, ...OPTIONAL_STRINGS]);
	return [...paths]
		.filter((path) => path !== "version" && path !== "targets")
		.map((path) => {
			const id = metadata.get(path);
			const raw = getAtPath(DEFAULT_SETTINGS, path);
			const extra = EXTRA_HELP[path];
			const kind: SettingControl["kind"] = STRUCTURED.has(path)
				? "json"
				: Array.isArray(raw)
					? "list"
					: OPTIONAL_NUMBERS.has(path) || NULLABLE_NUMBERS.has(path) || typeof raw === "number"
						? "number"
						: typeof raw === "boolean"
							? "boolean"
							: "string";
			return {
				path,
				label: extra?.[0] ?? (id ? SETTINGS_LABELS_BY_ID[id] : path),
				description:
					extra?.[1] ??
					(id
						? SETTINGS_DESCRIPTIONS_BY_ID[id]
						: `Configure ${path}. Changes are validated against CLIO Coder's settings schema.`),
				help: id ? SETTINGS_HELP_BY_ID[id] : undefined,
				choices: CHOICES[path],
				kind,
				optional: raw === null || OPTIONAL_STRINGS.has(path) || OPTIONAL_NUMBERS.has(path),
				readOnly: path === "integrations.library.confirmedRemote",
				...(MENU_ROWS.has(path) || (id !== undefined && !OFF_MENU_HAND_ROWS.has(path)) ? { menu: true as const } : {}),
			};
		});
})();

/** One area's complete control catalog, in its group order and then catalog order, as configure and the GUI list it. */
export function orderedAreaControls(area: SettingsAreaId): Array<{ group: string; control: SettingControl }> {
	return orderSettingsEntries(
		area,
		SETTING_CONTROLS.filter((control) => settingsAreaForPath(control.path) === area),
		(control) => control.path,
	).map((control) => ({ group: settingsPlacementForPath(control.path).group, control }));
}

/**
 * Interactive counterpart of `orderSettingsEntries`: rows are ordered by their
 * area's group sequence, then by the control catalog, so guided actions and live
 * entries (profiles, agent routes) stay beside the controls they represent.
 */
export function orderAreaEntries<T>(
	area: SettingsAreaId,
	entries: readonly T[],
	rowFor: (entry: T) => { id: string; path: string },
): T[] {
	const groups = SETTINGS_AREA_GROUPS[area];
	controlIndex ??= firstIndexByPath(SETTING_CONTROLS.map((control) => control.path));
	const catalog = controlIndex;
	return sortByRank(entries, (entry) => {
		const { id, path } = rowFor(entry);
		const group = groups.indexOf(settingsPlacementForRow(id, path).group);
		return [group < 0 ? groups.length : group, catalogRank(catalog, path, SETTING_CONTROLS.length)];
	});
}

/** Guided actions and live collection entries, keyed by setting path, stay beside the controls they represent. */
export function orderSettingsEntries<T>(
	area: SettingsAreaId,
	entries: readonly T[],
	pathFor: (entry: T) => string,
): T[] {
	const groups = SETTINGS_AREA_GROUPS[area];
	controlIndex ??= firstIndexByPath(SETTING_CONTROLS.map((control) => control.path));
	const catalog = controlIndex;
	return sortByRank(entries, (entry) => {
		const path = pathFor(entry);
		const group = path ? groups.indexOf(settingsPlacementForPath(path).group) : -1;
		return [group < 0 ? groups.length : group, catalogRank(catalog, path, SETTING_CONTROLS.length)];
	});
}

let controlIndex: ReadonlyMap<string, number> | undefined;

function firstIndexByPath(paths: readonly string[]): Map<string, number> {
	const index = new Map<string, number>();
	paths.forEach((path, at) => {
		if (!index.has(path)) index.set(path, at);
	});
	return index;
}

/** The first catalog control at the path or at any dotted ancestor of it; `missing` when none is listed. */
function catalogRank(index: ReadonlyMap<string, number>, path: string, missing: number): number {
	let rank = missing;
	for (let end = path.length; end > 0; end = path.lastIndexOf(".", end - 1)) {
		const at = index.get(path.slice(0, end));
		if (at !== undefined && at < rank) rank = at;
	}
	return rank;
}

/** A stable sort that ranks each entry once; a comparator that ranks per comparison cost /settings a frame. */
function sortByRank<T>(entries: readonly T[], rank: (entry: T) => readonly [number, number]): T[] {
	return entries
		.map((entry) => ({ entry, rank: rank(entry) }))
		.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
		.map(({ entry }) => entry);
}

export function settingControl(path: string): SettingControl | undefined {
	return SETTING_CONTROLS.find((control) => control.path === path);
}

export function formatControlValue(value: unknown): string {
	return value === undefined || value === null
		? "(automatic)"
		: typeof value === "object"
			? JSON.stringify(value)
			: String(value);
}

function parseControlValue(control: SettingControl, text: string): unknown {
	const input = text.trim();
	if (control.readOnly)
		throw new Error("This value is recorded by its dedicated confirmation flow; it cannot be edited here.");
	if (!input && control.optional)
		return OPTIONAL_STRINGS.has(control.path) || OPTIONAL_NUMBERS.has(control.path) ? undefined : null;
	if (control.choices && !control.choices.includes(input))
		throw new Error(`Choose one of: ${control.choices.join(", ")}.`);
	if (control.kind === "boolean") {
		if (input !== "true" && input !== "false") throw new Error("Choose true or false.");
		return input === "true";
	}
	if (control.kind === "number") {
		const value = input ? Number(input) : Number.NaN;
		if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
		return value;
	}
	if (control.path === "fleet.concurrency") {
		if (input === "auto") return "auto";
		const value = Number(input);
		if (!Number.isSafeInteger(value) || value < 1) throw new Error("Use auto or a positive whole number.");
		return value;
	}
	if (control.kind === "json") return JSON.parse(input);
	if (control.kind === "list")
		return input
			? input
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
			: [];
	return text;
}

/** Validate the whole proposed configuration so cross-field constraints are honored by both editors. */
export function applyControlValue(settings: ClioSettings, path: string, text: string): void {
	const control = settingControl(path);
	if (!control) throw new Error(`Unknown settings control: ${path}`);
	const candidate = structuredClone(settings);
	const value = parseControlValue(control, text);
	setAtPath(candidate, path, value);
	// Startup tolerates stale references. An editor must reject a typo rather than silently discard it.
	const routeRoots = ["chat", "fleet.default", "context.memory"];
	const routeRoot = routeRoots.find((root) => path === `${root}.target`);
	if (routeRoot) {
		if (value !== null && !candidate.targets.some((target) => target.id === value))
			throw new Error("Choose an existing connection id from Connections.");
		const target = candidate.targets.find((target) => target.id === value);
		const runtime = target ? getRuntimeRegistry().get(target.runtime) : null;
		if (routeRoot !== "fleet.default" && runtime && !isOrchestratorEligibleRuntime(runtime))
			throw new Error("Chat and memory need an HTTP/native connection; this connection is for workers only.");
		if (getAtPath(settings, path) !== value) setAtPath(candidate, `${routeRoot}.model`, null);
	}
	for (const root of routeRoots) {
		if (path === `${root}.model` && value && !getAtPath(candidate, `${root}.target`))
			throw new Error("Choose a connection for this role before setting a model override.");
	}
	if (
		path === "fleet.default.node" &&
		value !== undefined &&
		value !== "local" &&
		!candidate.fleet.nodes.some((node) => node.id === value)
	)
		throw new Error("Use local, a configured remote node id, or clear the field for automatic placement.");
	if (path === "fleet.profiles") {
		for (const [name, profile] of Object.entries(candidate.fleet.profiles ?? {})) {
			if (!candidate.targets.some((target) => target.id === profile?.target))
				throw new Error(`Profile ${name} must name an existing connection.`);
		}
	}
	if (path === "fleet.profiles" || path === "fleet.agentProfiles") {
		for (const [agent, profile] of Object.entries(candidate.fleet.agentProfiles ?? {})) {
			if (!Object.hasOwn(candidate.fleet.profiles, profile))
				throw new Error(`Agent ${agent} names missing profile ${profile}; remove or change its assignment first.`);
		}
	}
	const result = validateSettings(candidate);
	if (result.issues.length) throw new SettingsValidationError(result.issues);
	if (
		path === "chat.modelPicker.favorites" &&
		JSON.stringify(value) !== JSON.stringify(result.settings.chat.modelPicker.favorites)
	)
		throw new Error("Use target-id/model-id favorites from an existing connection.");
	setAtPath(settings, path, getAtPath(candidate, path));
	if (routeRoot) setAtPath(settings, `${routeRoot}.model`, getAtPath(candidate, `${routeRoot}.model`));
}

export function controlInstructions(control: SettingControl, surface: "configure" | "settings" = "configure"): string {
	const fractional =
		control.path === "context.compaction.threshold" ||
		control.path === "context.workingSet.target" ||
		control.path === "context.workingSet.rearmFraction" ||
		control.path.endsWith(".ratio");
	let entry = "";
	if (control.kind === "json") entry = "Enter JSON for this collection.";
	else if (control.kind === "list") entry = "Enter comma-separated values; clear the field for an empty list.";
	else if (control.path === "fleet.concurrency") entry = "Enter auto or a positive whole number.";
	else if (control.path === "fleet.worktrees.root")
		entry = "Enter disk, tmpfs for memory storage, auto, or an absolute directory.";
	else if (control.path.endsWith(".ratio")) entry = "Enter a fraction up to 0.5, such as 0.3 for 30%.";
	else if (fractional) entry = "Enter a fraction, such as 0.6 for 60%.";
	else if (control.path.endsWith("Ms")) entry = "Enter milliseconds; 1000 means one second.";
	else if (control.path.endsWith("Bytes")) entry = "Enter bytes; 1024 means one KB.";
	else if (control.kind === "number") entry = "Enter a number; invalid values leave the setting unchanged.";
	return [
		control.description,
		control.help,
		...Object.entries(
			SETTINGS_VALUE_HELP_BY_ID[
				Object.keys(SETTINGS_LABELS_BY_ID).find((id) => settingsPathForRow(id) === control.path) ?? ""
			] ?? {},
		).map(([value, help]) => `${value}: ${help}`),
		settingsChangeKind(control.path) === "restartRequired"
			? "Takes effect in the next session."
			: settingsChangeKind(control.path) === "hotReload"
				? "A running session can apply this immediately."
				: "Used by the next relevant request, dispatch, or explicit open.",
		entry,
		control.optional ? "Clear the field to use the automatic/default behavior." : "",
		surface === "configure" ? `Open /settings ${settingsAreaForPath(control.path)} to change this in chat.` : "",
	]
		.filter(Boolean)
		.join("\n");
}

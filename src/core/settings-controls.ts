import { settingsChangeKind } from "../domains/config/classify.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { findBuiltinRuntimeBootMetadata } from "../domains/providers/runtimes/boot-manifest.js";
import type { ClioSettings } from "./config.js";
import { SETTINGS_V1_PATH_MOVES, SettingsValidationError, semanticUsable, validateSettings } from "./config.js";
import { DEFAULT_SETTINGS, THINKING_LEVELS } from "./defaults.js";
import { getAtPath, setAtPath } from "./session-routing.js";
import {
	SETTINGS_AREA_GROUPS,
	type SettingsAreaId,
	settingsAreaForPath,
	settingsPlacementForRow,
} from "./settings-areas.js";
import { type SettingsSectionId, settingsGroupForPath, settingsSectionForPath } from "./settings-navigation.js";

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
	autonomy: "Autonomy level",
	// Legacy row ids stay internal; visible names are shared by every settings surface.
	"workers.onPermission": "When a worker asks permission",
	"workers.escalation.timeoutMs": "Time to answer a worker",
	"workers.escalation.fallback": "If you do not answer",
	"delegation.defaults.toolGovernance": "External agent permissions",
	"skills.trustProjectCompatRoots": "Trust project imports",
	"attribution.gitCommits": "Credit in Git commits",
	safetyNet: "Safety net",
	"orchestrator.thinkingLevel": "Thinking level",
	"orchestrator.target": "Chat connection",
	"orchestrator.model": "Chat model",
	"background.target": "Memory connection",
	"background.model": "Memory model",
	"memory.intervention.enabled": "Proactive memory",
	"memory.intervention.everyNTools": "Tools between memory updates",
	"memory.intervention.windowSteps": "Recent steps to remember",
	"memory.intervention.maxTokens": "Memory note length",
	"memory.intervention.timeoutMs": "Memory response time",
	"prewarm.enabled": "Prompt pre-warm",
	"workers.default.target": "Default fleet connection",
	"workers.default.model": "Default fleet model",
	"workers.default.thinkingLevel": "Default thinking level",
	"workers.profiles": "Add profile",
	"workers.agentBindings": "Bind agent",
	"workers.maxRetries": "Fleet retries",
	"workers.resilienceCooldownMs": "Wait after a route fails",
	"routing.activeRoles": "Roles using automatic routing",
	"routing.activePostures": "Automatic routing priorities",
	"routing.agentAutomation.activeAgentRoles": "Agents using automatic routing",
	"panes.enabled": "Open extra panes",
	"panes.notifications": "Pane notifications",
	"panes.layout": "Startup layout",
	"panes.workers.ratio": "Workers dock share",
	"panes.journal": "Run event journal",
	"panes.yazi.enabled": "Files pane",
	"panes.yazi.mode": "Files pane mode",
	"panes.yazi.profile": "Files pane profile",
	"panes.yazi.followCwd": "Files follow chat folder",
	"panes.yazi.ratio": "Files dock share",
	scope: "Models in quick switch",
	"modelSelector.recentLimit": "Recent models kept",
	"modelSelector.favorites": "Pinned favorites",
	"budget.sessionCeilingUsd": "Session cost limit",
	"defaults.maxTokens": "Maximum answer length",
	"context.toolResultMaxBytes": "Maximum tool result size",
	"budget.concurrency": "Workers at once",
	"guardrails.turnToolCallBudget": "Tools per chat turn",
	"guardrails.workerToolCallCap": "Tools per worker run",
	"guardrails.maxDispatchRuns": "Past runs to keep",
	"guardrails.readMaxBytes": "Maximum file read size",
	"guardrails.observationTurnBudgetBytes": "Tool output per turn",
	"guardrails.internalDispatchTimeoutMs": "Maximum internal run time",
	"compaction.auto": "Summarize automatically",
	"compaction.threshold": "When to summarize",
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
	"retry.enabled": "Retry transient errors",
	"retry.maxRetries": "Max retries",
	"retry.baseDelayMs": "Wait before first retry",
	"retry.maxDelayMs": "Longest retry wait",
	"retry.streamStallMs": "Wait for a stalled reply",
	"retry.firstTokenStallMs": "Wait for reply to start",
	"terminal.showTerminalProgress": "Terminal progress indicator",
	"terminal.outputVerbosity": "Output style",
	"terminal.tuiMode": "Transcript layout",
	"terminal.fullscreenScrollbar": "Fullscreen scrollbar",
	"terminal.smoothStreaming": "Smooth streaming",
	"terminal.notify": "Desktop notifications",
	"watchdog.enabled": "Review changed work",
	"watchdog.target": "Review connection",
	"watchdog.cadenceToolCalls": "Tools between reviews",
	runtimePlugins: "Startup plugins",
	"compaction.model": "Compaction model",
	"compaction.systemPrompt": "Compaction prompt",
	"delegation.defaults.connectTimeoutMs": "Time for agent to connect",
	"delegation.defaults.turnTimeoutMs": "Maximum agent turn time",
	"delegation.defaults.permissionTimeoutMs": "Time for agent permission",
	targets: "Configured connections",
	keybindings: "Keybinding overrides",
	"delegation.agents": "Available agents",
	"library.catalog": "Library catalog path",
	"library.remote": "Library remote",
	"library.confirmedRemote": "Confirmed library remote",
	"library.sync": "Library remote sync",
} as const;

export const SETTINGS_DESCRIPTIONS_BY_ID = {
	autonomy: "How freely Clio acts; the safety net always applies.",
	"workers.onPermission":
		"Choose whether the safety judge reviews a worker's blocked tool, or the worker skips it, stops, or asks you to approve it.",
	"workers.escalation.timeoutMs": "How long Clio waits for your answer when a worker asks permission.",
	"workers.escalation.fallback": "What the worker does if you do not answer in time.",
	"delegation.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"skills.trustProjectCompatRoots": "Allow explicitly imported foreign skills and prompts to run.",
	"attribution.gitCommits":
		"Add evidence-backed assistance, testing, review, and contributor trailers to commits created through Clio.",
	safetyNet: "Always-on rails; tuned in .clio-coder/safety.yaml.",
	"orchestrator.thinkingLevel": "How much reasoning the chat model uses before answering.",
	"orchestrator.target": "Connection that answers in chat.",
	"orchestrator.model": "Chat model override; unset uses the connection default.",
	"background.target": "Connection for task memory. With no memory connection or model set, memory uses the chat route.",
	"background.model":
		"Dedicated task-memory model. With no memory route set, memory uses chat because no memory model is set.",
	"memory.intervention.enabled": "Allow Clio to update task memory as work progresses.",
	"memory.intervention.everyNTools": "Maximum number of tool uses between memory updates.",
	"memory.intervention.windowSteps": "How many recent steps Clio considers when updating memory.",
	"memory.intervention.maxTokens": "Maximum length of one memory reminder, in tokens.",
	"memory.intervention.timeoutMs": "How long Clio waits for a memory model response.",
	"prewarm.enabled": "Send the next turn's known prefix ahead of time so a local server has already prefilled it.",
	"workers.default.target": "Default connection for delegated fleet work.",
	"workers.default.model": "Default fleet model override; unset uses the connection default.",
	"workers.default.thinkingLevel": "Reasoning budget for dispatched workers.",
	"workers.profiles": "Saved connection, model, and reasoning choices for workers. Enter adds one.",
	"workers.agentBindings": "Choose which saved profile each Clio agent uses. Enter adds one.",
	"workers.maxRetries": "Automatic retries for a retryable worker outcome.",
	"workers.resilienceCooldownMs":
		"How long a failing target, runtime, and model route is skipped before it is tried again.",
	"routing.activeRoles": "Types of worker allowed to use an automatically selected model.",
	"routing.activePostures": "Priorities that automatic model selection may use for workers.",
	"routing.agentAutomation.activeAgentRoles": "Specific agents allowed to use automatic model selection.",
	"panes.enabled": "Open Clio in a workspace with companion panes, powered by herdr. Takes effect on the next start.",
	"panes.notifications": "Choose which worker updates show a pane notification.",
	"panes.layout": "Choose which companion panes open when Clio starts.",
	"panes.workers.ratio": "Share of the width the workers dock takes, at most half.",
	"panes.journal": "Save worker activity so you can inspect finished runs later.",
	"panes.yazi.enabled":
		"Whether `/files`, its key, and `/panes open files` may open the files pane or the one-shot pick.",
	"panes.yazi.mode": "Keep the files pane beside the conversation, or close it after one selection.",
	"panes.yazi.profile": "Use Clio's theme or your own file manager settings.",
	"panes.yazi.followCwd": "Keep an open files pane on the same folder as the conversation.",
	"panes.yazi.ratio": "Share of the height the files dock takes, at most half.",
	scope: "Models the quick-switch key cycles through.",
	"modelSelector.recentLimit": "How many recently used models /model remembers.",
	"modelSelector.favorites": "Connections and models pinned in the model picker.",
	"budget.sessionCeilingUsd": "Per-session cost cap.",
	"defaults.maxTokens": "Output tokens requested per turn, applied to every target.",
	"context.toolResultMaxBytes": "Maximum bytes returned from one tool result before the full text spills to scratch.",
	"budget.concurrency": "Maximum number of workers running at the same time.",
	"guardrails.turnToolCallBudget": "Maximum tool uses Clio may make during one chat turn.",
	"guardrails.workerToolCallCap": "Maximum tool uses one worker may make during its run.",
	"guardrails.maxDispatchRuns": "How many finished worker runs remain in local history.",
	"guardrails.readMaxBytes": "Maximum text one file read may return to the model.",
	"guardrails.observationTurnBudgetBytes": "Combined tool output Clio may read during one turn.",
	"guardrails.internalDispatchTimeoutMs": "Maximum time for one internal worker run.",
	"compaction.auto": "Summarize older context automatically before the conversation fills up.",
	"compaction.threshold": "How full the model's context can get before Clio summarizes older content.",
	"context.compaction.provider": "Use native Codex checkpoints when supported; off keeps portable Clio summaries.",
	"context.compaction.maxTokens":
		"Input token ceiling used to trigger context cleanup independently of the model's window.",
	"context.workingSet.enabled": "Free space by setting aside stale tool output before summarizing the conversation.",
	"context.workingSet.policy": "Choose how Clio finds old tool output to set aside.",
	"context.workingSet.profile": "Keep extra outputs that matter for the current kind of work.",
	"context.workingSet.target": "How full the context should be after Clio clears old output.",
	"context.workingSet.protectLastTurns": "Keep tool output from this many recent user turns.",
	"context.workingSet.protectLastSteps": "Keep tool output from this many recent assistant steps.",
	"context.workingSet.minEvictableTokens":
		"Results below this token estimate stay; the marker would cost more than it saves.",
	"context.workingSet.rearmFraction": "Wait for context use to grow by this much before clearing old output again.",
	"retry.enabled": "Retry transient provider errors on the next submit.",
	"retry.maxRetries": "Retry attempts after the initial failure.",
	"retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"retry.streamStallMs": "How long Clio waits when a model stops sending text mid-answer.",
	"retry.firstTokenStallMs": "How long Clio waits for a model to start its answer.",
	"terminal.showTerminalProgress": "Show running-task progress in terminals that support tab or taskbar badges.",
	"terminal.outputVerbosity": "How much reasoning, tool input, and live tool output appears in the transcript.",
	"terminal.tuiMode": "Use regular terminal scrollback or a fullscreen transcript with a sticky composer and footer.",
	"terminal.fullscreenScrollbar": "When the draggable transcript scrollbar is visible in fullscreen mode.",
	"terminal.smoothStreaming": "Presentation-only pacing for streamed assistant text and thinking.",
	"terminal.notify":
		"Content-free desktop notification when a turn ends, a detached batch settles, or an approval parks.",
	"watchdog.enabled": "After Clio changes files, ask a read-only reviewer to check the work.",
	"watchdog.target": "Connection used for the review. Leave blank to use the chat connection.",
	"watchdog.cadenceToolCalls":
		"Also review during a long turn after this many tool uses; leave blank for an end-of-turn review only.",
	runtimePlugins:
		"Additional runtime plugin packages loaded when Clio starts. Install and enable only packages you trust.",
	"compaction.model": "Model used to summarize older conversation. Leave blank to use the chat model.",
	"compaction.systemPrompt":
		"Optional file with custom summarizing instructions. Leave blank for Clio's built-in instructions.",
	"delegation.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"delegation.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"delegation.defaults.permissionTimeoutMs":
		"How long Clio waits for your answer to an external agent's permission request.",
	targets: "Inference targets available for chat and workers. Add one with `clio-coder targets add`.",
	keybindings: "Custom key overrides layered on the defaults.",
	"delegation.agents": "Other coding agents you can call through /delegate.",
	"library.catalog": "Path to the private resource catalog; blank uses the one in your config directory.",
	"library.remote": "Git remote the catalog syncs with; blank keeps the library entirely local.",
	"library.confirmedRemote": "The remote you approved. Syncing waits until it matches the current library remote.",
	"library.sync": "Whether `clio-coder library sync` and `push` may talk to the remote at all.",
} as const satisfies Record<keyof typeof SETTINGS_LABELS_BY_ID, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
export const SETTINGS_HELP_BY_ID: Partial<Record<string, string>> = {
	autonomy:
		"Default edits the workspace, dispatches routine work, and runs your shell commands without asking inside an OS sandbox where the host has one (workspace and scratch roots writable, credentials hidden). Commands that leave the sandbox, outward actions and former hard blocks are first reviewed by the safety judge against your requests, larger dispatch plans ask you, and destructive workspace operations run after a snapshot /rewind can undo. Yolo never asks and runs unsandboxed unless safety.sandbox is required; only the yolo floor and rules in an approved .clio-coder/safety.yaml block. Its first activation asks you to accept it once, and it is refused as root outside a container.",
	"defaults.maxTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"context.toolResultMaxBytes":
		"At least 4 KB. Clio can read up to 192 KB of tool output across a whole turn, even if this per-result limit is higher.",
	"compaction.threshold":
		"Choose how full the model's context may get. A higher percentage keeps more history but leaves less room for the next answer.",
	"context.compaction.maxTokens":
		"Whole number of at least 1 · default: 200000 tokens. A lower ceiling limits input cost by triggering cleanup sooner, even when the model has a larger context window.",
	"context.workingSet.enabled":
		"Old tool output is set aside without changing chat history. When off, Clio waits until it needs to summarize the conversation.",
	"context.workingSet.policy":
		"Current structure also protects output the model returned to twice. Classic structure uses the older selection rule. Age only clears the oldest eligible output first.",
	"context.workingSet.profile":
		"Data analysis keeps recent numeric command output. Web design keeps recently read stylesheets and components. Default adds no special protection.",
	"context.workingSet.target":
		"Choose a percentage below the summarize threshold. Clio keeps clearing eligible output until context use falls to this level.",
	"context.workingSet.protectLastTurns": "Counted in user turns. Whole number of at least 1 · default: 6.",
	"context.workingSet.protectLastSteps":
		"Counted in assistant steps inside the turn window, so a long agentic turn stays evictable. Whole number of at least 1 · default: 8.",
	"context.workingSet.minEvictableTokens":
		"Smaller outputs stay in context because replacing them saves little space. Choose 0 to allow every size.",
	"context.workingSet.rearmFraction":
		"Clio waits for context use to grow by this percentage after clearing output. Choose 0 to allow another cleanup immediately.",
	"guardrails.turnToolCallBudget":
		"Clio stops using tools and summarizes the turn when it reaches this limit. Whole number of at least 1.",
	"guardrails.workerToolCallCap":
		"Only tools that actually ran count. A worker's own smaller limit still applies. Whole number of at least 1.",
	"guardrails.maxDispatchRuns":
		"When history fills, the oldest run and its event log are removed. Whole number of at least 1.",
	"guardrails.readMaxBytes": "Enter a number of bytes. Clio reads at least 1 KB even if you choose a smaller value.",
	"guardrails.observationTurnBudgetBytes":
		"Shared by every tool in the turn. At the default, the pool grows with the model's context window above 128K tokens, up to 1 MB. Any other value applies exactly. Enter a whole number of bytes, at least 1.",
	"guardrails.internalDispatchTimeoutMs":
		"Ends an internal worker run that never finishes, including the wiki writer and first project Scout. Enter at least 1 millisecond.",
	"retry.streamStallMs":
		"The timer resets whenever text arrives. If it expires, Clio can retry according to the retry settings above.",
	"retry.firstTokenStallMs":
		"Time allowed before the first text arrives. Choose 0 to wait indefinitely; useful for models that need to load first.",
	"library.catalog":
		"Absolute path, or blank for the catalog in your config directory. The catalog is the index `clio-coder library` reads; installed resources land in the usual skill and resource roots either way. Default: blank.",
	"library.remote":
		"Enter a Git remote URL, or leave blank to keep the library local. Confirm the remote and turn on syncing before Clio uses it.",
	"library.confirmedRemote":
		"Clio records this after you confirm the library remote. It must match the selected remote before syncing is allowed.",
	"library.sync": "When off, library sync and push stop before contacting the remote, even if one is configured.",
	"budget.concurrency":
		"Automatic chooses a limit from available CPU and memory, up to eight workers. Choose a number to set a fixed limit.",
	"skills.trustProjectCompatRoots":
		"Applies to foreign packages explicitly imported into Clio, at user or project scope. Loose skills/prompts in other agents' folders stay discovery-only; this setting never imports them.",
	"attribution.gitCommits":
		"Role trailers are added only when Clio has trusted evidence for that role. Disabling leaves subsequent commit messages entirely unchanged.",
	"workers.onPermission":
		"Safety judge reviews the call against your own messages while Clio runs at default; it runs on an allow and is denied on a block or when the judge gives no verdict. Deny the tool lets the worker continue without it. Stop the worker ends the run. Ask me waits for your answer, then uses the fallback choice if time runs out.",
	"workers.escalation.timeoutMs":
		"Used only when workers ask you. In sessions with nobody available to answer, the fallback applies. Enter at least 1 millisecond.",
	"workers.escalation.fallback": "Deny the tool lets the worker continue without it. Stop the worker ends the run.",
	"workers.resilienceCooldownMs":
		"After repeated failures, Clio waits before trying the same connection and model again. A successful run clears the wait. Choose 0 to disable it.",
	"routing.activeRoles":
		"Automatic model selection only takes effect when both the worker role and its priority are enabled. Otherwise Clio records its suggestion without using it. Choose researcher, verifier, reviewer, or judge.",
	"routing.activePostures":
		"Choose which priorities may select a model automatically: quality, balanced, speed, or lower cost. Manually chosen models stay fixed.",
	"routing.agentAutomation.activeAgentRoles":
		"Each entry names one agent and worker role. Edit these pairs in the settings file. The agent name auto is reserved.",
	"prewarm.enabled":
		"For a supported local connection, prepare the next prompt when a session starts, resumes, or finishes summarizing. It does not run during an active turn.",
	"workers.agentBindings":
		"Bind base, custom, and shadow native agents such as scout, researcher, and provenance to profiles. ACP delegation agents cannot be bound.",
	"delegation.defaults.toolGovernance":
		"Clio permissions check external agent tools. Agent permissions let that agent decide. Deny all tools blocks every tool request.",
	scope: "Choose connections or specific models. The model switch shortcut cycles through this list.",
	runtimePlugins: "Comma-separated package names, loaded at startup. Restart Clio after changing.",
	"terminal.notify":
		"Supported terminals show a brief desktop alert. Alerts never include your prompt, file paths, or model output.",
	"watchdog.enabled":
		"The reviewer reads the files changed during the turn and reports blockers in the transcript. It runs in interactive sessions only.",
	"watchdog.target": "Choose a connection for the reviewer. Leave blank to use the current chat connection.",
	"watchdog.cadenceToolCalls":
		"Set a tool count to check work during a long turn. Leave blank to review only when the turn ends.",
	keybindings:
		"Alt+O cycles Output style: Compact, Standard, Detailed. Use /view for full reasoning and action details. Shift+Tab changes model thinking effort.",
};

/** Per-value meaning, surfaced for the current value of an enum knob. */
export const SETTINGS_VALUE_HELP_BY_ID: Partial<Record<string, Record<string, string>>> = {
	autonomy: {
		default:
			"workspace edits, reads anywhere outside secret paths, and shell commands inside the OS sandbox run (without a sandbox, only recognized commands); outward actions, commands that leave the sandbox and former hard blocks go to the safety judge; larger dispatch plans and project settings ask you",
		yolo:
			"everything runs without asking, unsandboxed by default; only the yolo floor and your approved safety.yaml rules block",
	},
	"workers.onPermission": {
		deny: "the worker skips the blocked tool and continues",
		fail: "the worker stops and reports that permission was needed",
		escalate: "Clio asks you; if you do not answer in time, it uses the fallback choice below",
		judge:
			"the safety judge reviews the call against your own messages at autonomy default; a block or no verdict denies it, and with the judge off the call is denied",
	},
	"workers.escalation.fallback": {
		deny: "the worker skips the blocked tool and continues",
		fail: "the worker stops and reports that permission was needed",
	},
	"prewarm.enabled": {
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
		default: "keep only Clio's essential context",
		"data-analysis": "also keep three recent command outputs with numbers",
		"web-design": "also keep recently read stylesheets and components",
	},
	"library.sync": {
		true: "allow `clio-coder library sync` and `push` to reach the confirmed remote",
		false: "refuse every library network operation",
	},
	"delegation.defaults.toolGovernance": {
		"clio-coder-policy": "Clio's safety policy gates the delegated agent's tools",
		"agent-managed": "the external agent governs its own tools",
		"deny-all": "block every tool the delegated agent requests",
	},
	"compaction.auto": {
		true: "compact automatically before a turn crosses the threshold",
		false: "context is only compacted when you run /context compact",
	},
	"panes.enabled": {
		embedded: "open Clio in its own workspace with panes; inside an existing pane host, join it",
		auto: "join a pane host only when Clio is started inside one; never start one",
		off: "never detect or open a pane",
	},
	"retry.enabled": {
		true: "retry transient provider errors automatically",
		false: "surface transient errors immediately without retrying",
	},
	"skills.trustProjectCompatRoots": {
		true: "allow explicitly imported foreign skills and prompts",
		false: "keep imported foreign skills and prompts inactive",
	},
	"attribution.gitCommits": {
		enabled: "add only the Clio role trailers justified by trusted evidence",
		disabled: "leave every subsequent commit message byte-for-byte unchanged",
	},
	"terminal.showTerminalProgress": {
		true: "show progress in a supported terminal tab or taskbar",
		false: "no terminal progress badges",
	},
	"terminal.outputVerbosity": {
		compact: "quiet action summaries, answers, and visible failures",
		standard: "short reasoning and change previews, clear action outcomes",
		detailed: "larger bounded previews; full content is available in /view",
	},
	"terminal.tuiMode": {
		regular: "preserve terminal scrollback and render the composer below the transcript",
		fullscreen: "use the alternate screen with an independently scrollable transcript and sticky composer/footer",
	},
	"terminal.fullscreenScrollbar": {
		hidden: "never draw the fullscreen transcript scrollbar",
		auto: "show the scrollbar while scrolling or dragging",
		always: "reserve the rightmost column for the scrollbar",
	},
	"terminal.notify": {
		true: "post a content-free desktop notification on turn end, batch settlement, and a parked approval",
		false: "never post a desktop notification",
	},
	"watchdog.enabled": {
		true: "review every mutating turn with one read-only verifier run",
		false: "no verifier run; a turn ends without a second opinion",
	},
	"terminal.smoothStreaming": {
		off: "show each chunk of text as soon as it is ready",
		auto: "smooth text when the terminal supports it",
		on: "smooth text as it appears, pausing if the terminal falls behind",
	},
};

const SETTINGS_CENTER_V2_PATH_OVERRIDES: Readonly<Record<string, string>> = {
	"retry.firstTokenStallMs": "chat.retry.firstTokenStallMs",
	"workers.profiles": "fleet.profiles",
	"workers.agentBindings": "fleet.agentProfiles",
	"routing.agentAutomation.activeAgentRoles": "fleet.adaptiveRouting.agentRoles",
	"panes.enabled": "interface.panes.enabled",
	"panes.notifications": "interface.panes.notifications",
	"panes.journal": "fleet.history.journal",
	"panes.yazi.enabled": "interface.panes.files.enabled",
	"panes.yazi.mode": "interface.panes.files.mode",
	"panes.yazi.profile": "interface.panes.files.profile",
	"panes.yazi.followCwd": "interface.panes.files.followCwd",
	"panes.yazi.ratio": "interface.panes.files.ratio",
	"panes.layout": "interface.panes.layout",
	"panes.workers.ratio": "interface.panes.workers.ratio",
	"delegation.agents": "integrations.externalAgents.entries",
	keybindings: "interface.keybindings",
};

/** Keep the existing Center navigation while showing and persisting only canonical v2 paths. */
export function settingsV2PathForRow(id: string): string {
	if (id.startsWith("setting.")) return id.slice(8);
	if (id.startsWith("workers.profiles.")) return `fleet.profiles.${id.slice("workers.profiles.".length)}`;
	if (id.startsWith("workers.agentBindings.")) return `fleet.agentProfiles.${id.slice("workers.agentBindings.".length)}`;
	const override = SETTINGS_CENTER_V2_PATH_OVERRIDES[id];
	if (override !== undefined) return override;
	for (const [v1Path, v2Path] of SETTINGS_V1_PATH_MOVES) {
		if (v1Path === id) return v2Path;
		if (v1Path === `${id}[]` && v2Path.endsWith("[]")) return v2Path.slice(0, -2);
	}
	return id;
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
}

const CHOICES: Record<string, readonly string[]> = {
	"interface.exitSummary": ["auto", "brief", "standard", "report", "off"],
	"telemetry.mode": ["standard", "research"],
	"safety.autonomy": ["default", "yolo"],
	"safety.sandbox": ["auto", "required", "off"],
	"safety.sandboxUnixSockets": ["block", "allow"],
	"safety.snapshots": ["auto", "off"],
	"chat.thinkingLevel": THINKING_LEVELS,
	"fleet.default.thinkingLevel": THINKING_LEVELS,
	"fleet.permissions.mode": ["judge", "deny", "escalate", "fail", "main"],
	"fleet.permissions.escalation.fallback": ["deny", "fail"],
	"interface.mode": ["regular", "fullscreen"],
	"interface.outputDetail": ["compact", "standard", "detailed"],
	"interface.fullscreenScrollbar": ["hidden", "auto", "always"],
	"interface.smoothStreaming": ["off", "auto", "on"],
	"interface.panes.enabled": ["embedded", "auto", "off"],
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
const NULLABLE_NUMBERS = new Set(["turnControl.orientation.maxCostUsdPerTurn"]);
const OPTIONAL_STRINGS = new Set([
	"fleet.default.node",
	"safety.review.target",
	"context.compaction.model",
	"context.compaction.systemPrompt",
]);
const EXTRA_HELP: Record<string, [string, string]> = {
	"context.compaction.provider": [
		"Provider compaction",
		"Use private native checkpoints on compatible Codex routes. Off uses portable Clio summaries; switching routes generates a portable summary from the retained history.",
	],
	"safety.limits.workerResponseSeconds": [
		"Worker response time",
		"Seconds one native worker model response may run; locked synthesis rounds stop at 120.",
	],
	"context.semantic.enabled": [
		"Semantic search",
		"Make the optional project search index available to Clio after pinning a qualified embedding route.",
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
	"context.memory.observations.enabled": [
		"Continuity preparation",
		"Let the memory model condense older turns in the background so compaction can reuse that record instead of summarizing them again. Needs proactive memory on; off by default.",
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
		"Clio controls music",
		"Give Clio a music tool to start, stop or skip the station on its own. When it is off the tool is not registered and costs no prompt bytes.",
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
		"Before Clio first changes files in a turn, and before every destructive command, save the Git work tree as a private snapshot so /rewind can restore the files. Ignored files and untracked files over 16 MiB are left out. Your index, HEAD and branches are never touched. Off takes no snapshots.",
	],
	"safety.unattendedAfterSeconds": [
		"Unattended timeout",
		"Seconds a permission card or ask_user question waits for you before Clio resolves it and keeps working: the parked call is denied, each unanswered question takes its recommended option, and the session summary counts both. Any key on the card or question holds it. 0 waits forever. User settings only.",
	],
	"safety.yoloAccepted": [
		"Yolo accepted",
		"Set when you accept the one-time card that turns yolo on: no approval stops, no sandbox by default, only the yolo floor blocks. Turn it off to see the card again. User settings only.",
	],
	"safety.judge.enabled": [
		"Safety judge",
		"At autonomy default, a model reviews each call that would need your approval against your own messages, then runs it or refuses it back to Clio with a reason. It asks you when it cannot decide, and after 3 refusals in a row or 20 in a session. User settings only.",
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
	"safety.sandboxUnixSockets": [
		"Sandbox unix sockets",
		"Block stops sandboxed commands from opening Unix sockets, because a socket they can reach (tmux, an X11 display, a daemon's control socket) can run commands outside the sandbox. Database sockets, Docker and other local IPC then fail inside it, and a command that needs one runs unsandboxed after review. Allow leaves every socket reachable. User settings only.",
	],
	"safety.scratchRoots": [
		"Scratch roots",
		"Absolute directories your sandboxed commands and file edits may write at autonomy default without asking, and where deletes run as they do in the workspace. TMPDIR, /tmp and /var/tmp always count. User settings only.",
	],
	"interface.demo": [
		"Demo presentation and guidance",
		"The full welcome artwork, dashboard, and shortcut hints. Off starts with a compact identity header and skips welcome-only reads. Also controls a short tip after some turns, picked from what the turn did, plus idle footer tips and key hints. On by default before 1.0. Off stops every tip and the guidance profile. No automatic demonstrations or permission changes.",
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
		"Where workers run unless their profile says otherwise. Enter local or a configured remote machine name; clear to let Clio choose.",
	],
	"fleet.profiles": [
		"Worker profiles",
		"Named target, model, thinking, and placement choices. Use Fleet's profile actions for guided edits, or edit this JSON object.",
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
		"In research mode, also keep the text of each distinct system prompt Clio compiles for a session, and the prompts, replies and facts of its background memory and compaction steps, with secrets removed, in that session's telemetry objects. Takes effect only in a workspace you consented for with clio-coder telemetry consent. Request bodies are not captured.",
	],
	"telemetry.research.deltas": [
		"Research: token timing",
		"Reserved for per-call token timing in research mode. This build records nothing for it.",
	],
	"telemetry.research.providerHeaders": [
		"Research: provider headers",
		"Reserved for allow-listed provider response headers in research mode. This build records nothing for it.",
	],
	"telemetry.research.systemOneDataset": [
		"Research: decision dataset",
		"In research mode, keep the System One decision dataset. It holds redacted prompts and decision state, so it also needs Research: capture content and consent for the workspace.",
	],
	"telemetry.research.busTrace": [
		"Research: bus trace",
		"In research mode, journal the name of every live event the telemetry hub delivers as a bus.traced record.",
	],
	"turnControl.workflows": [
		"Before Clio answers",
		"Choose whether Clio may explore the project, check recent Git activity, recall earlier work, or collect finished background runs before answering. Project exploration and Git checks (orientation and direction) need a fitted System One turn site, which is experimental.",
	],
	"turnControl.orientation.maxSplit": [
		"Scouts per project tour",
		"Maximum number of read-only Scouts Clio may start to explore a project before answering.",
	],
	"turnControl.orientation.maxCostUsdPerTurn": [
		"Project tour cost limit",
		"Maximum cost in USD for Scouts started before one answer. Leave blank to use the worker cost limit.",
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
	"fleet.speculativeDispatch": [
		"Start predicted work early",
		"Experimental. System One's turn site is asked which recipe a dispatch would name first. Only a fitted build's answer starts a worker early, and the result is held. The agent still decides whether to use that work.",
	],
	"fleet.retry.breakerThreshold": [
		"Failures before cooldown",
		"Consecutive route failures before Clio temporarily stops sending work to that route. A healthy request clears the failure count.",
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
		Object.keys(SETTINGS_LABELS_BY_ID).map((id) => [settingsV2PathForRow(id), id as keyof typeof SETTINGS_LABELS_BY_ID]),
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
						: `Configure ${path}. Changes are validated against Clio's settings schema.`),
				help: id ? SETTINGS_HELP_BY_ID[id] : undefined,
				choices: CHOICES[path],
				kind,
				optional: raw === null || OPTIONAL_STRINGS.has(path) || OPTIONAL_NUMBERS.has(path),
				readOnly: path === "integrations.library.confirmedRemote",
			};
		});
})();

/**
 * Groups are ordered by where their first key sits in DEFAULT_SETTINGS, and `fleet` precedes `safety` there,
 * so the worker-approval controls would open Permissions & Limits ahead of the autonomy level it exists for.
 */
const LEADING_GROUPS: Partial<Record<SettingsSectionId, string>> = { safety: "Autonomy" };

/** Complete section catalog in the order used by configure and /settings. */
export function orderedSectionControls(section: SettingsSectionId): Array<{ group: string; control: SettingControl }> {
	const controls = SETTING_CONTROLS.filter((control) => settingsSectionForPath(control.path) === section);
	const leading = LEADING_GROUPS[section];
	const groups = [
		...new Set([...(leading ? [leading] : []), ...controls.map((control) => settingsGroupForPath(control.path))]),
	];
	return groups.flatMap((group) =>
		controls.filter((control) => settingsGroupForPath(control.path) === group).map((control) => ({ group, control })),
	);
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
	const rank = (entry: T): [number, number] => {
		const { id, path } = rowFor(entry);
		const group = groups.indexOf(settingsPlacementForRow(id, path).group);
		const control = SETTING_CONTROLS.findIndex(
			(candidate) => path === candidate.path || path.startsWith(`${candidate.path}.`),
		);
		return [group < 0 ? groups.length : group, control < 0 ? SETTING_CONTROLS.length : control];
	};
	return [...entries].sort((a, b) => {
		const left = rank(a);
		const right = rank(b);
		return left[0] - right[0] || left[1] - right[1];
	});
}

/** Guided actions and live collection entries stay beside the controls they represent. */
export function orderSettingsEntries<T>(
	section: SettingsSectionId,
	entries: readonly T[],
	pathFor: (entry: T) => string,
): T[] {
	const catalog = orderedSectionControls(section);
	const groups = [...new Set(catalog.map((entry) => entry.group))];
	const rank = (entry: T): [number, number] => {
		const path = pathFor(entry);
		const group = groups.indexOf(settingsGroupForPath(path));
		const control = catalog.findIndex(
			(entry) => path === entry.control.path || path.startsWith(`${entry.control.path}.`),
		);
		return [group < 0 ? groups.length : group, control < 0 ? catalog.length : control];
	};
	return [...entries].sort((a, b) => {
		const left = rank(a);
		const right = rank(b);
		return left[0] - right[0] || left[1] - right[1];
	});
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
				Object.keys(SETTINGS_LABELS_BY_ID).find((id) => settingsV2PathForRow(id) === control.path) ?? ""
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

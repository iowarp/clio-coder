import { settingsChangeKind } from "../domains/config/classify.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { type ClioSettings, SETTINGS_V1_PATH_MOVES, SettingsValidationError, validateSettings } from "./config.js";
import { DEFAULT_SETTINGS, THINKING_LEVELS } from "./defaults.js";
import { getAtPath, setAtPath } from "./session-routing.js";
import { settingsSectionForPath } from "./settings-navigation.js";

export const SETTINGS_LABELS_BY_ID = {
	autonomy: "Autonomy level",
	// Labels follow the CLI's post-rename vocabulary: the config surface is the
	// fleet, and `worker` is the runtime entity the descriptions still name. A
	// section headed Fleet whose rows read "Worker profiles" and "Worker
	// retries" made one setting look like two subsystems.
	"workers.onPermission": "Fleet approvals routing",
	"workers.escalation.timeoutMs": "Escalation timeout (ms)",
	"workers.escalation.fallback": "Escalation fallback",
	"delegation.defaults.toolGovernance": "Delegation governance",
	"skills.trustProjectCompatRoots": "Trust imported skills and prompts",
	"attribution.gitCommits": "Clio commit provenance",
	safetyNet: "Safety net",
	"orchestrator.thinkingLevel": "Thinking level",
	"orchestrator.target": "Target",
	"orchestrator.model": "Model",
	"background.target": "Memory target",
	"background.model": "Memory model",
	"memory.intervention.enabled": "Proactive memory",
	"memory.intervention.everyNTools": "Memory cadence (tools)",
	"memory.intervention.windowSteps": "Memory trajectory steps",
	"memory.intervention.maxTokens": "Memory reminder tokens",
	"memory.intervention.timeoutMs": "Memory timeout (ms)",
	"prewarm.enabled": "Prompt pre-warm",
	"workers.default.target": "Default target",
	"workers.default.model": "Default model",
	"workers.default.thinkingLevel": "Default thinking level",
	"workers.profiles": "Add profile",
	"workers.agentBindings": "Bind agent",
	"workers.maxRetries": "Fleet retries",
	"workers.resilienceCooldownMs": "Resilience cooldown (ms)",
	"routing.activeRoles": "Active routing roles",
	"routing.activePostures": "Active routing postures",
	"routing.agentAutomation.activeAgentRoles": "Active agent routes",
	"panes.enabled": "Panes",
	"panes.notifications": "Pane notifications",
	"panes.layout": "Boot layout",
	"panes.workers.ratio": "Workers dock share",
	"panes.journal": "Run event journal",
	"panes.yazi.enabled": "Files pane",
	"panes.yazi.mode": "Files pane mode",
	"panes.yazi.profile": "Files pane profile",
	"panes.yazi.followCwd": "Follow conversation cwd",
	"panes.yazi.ratio": "Files dock share",
	scope: "Model cycle set",
	"modelSelector.recentLimit": "Recent models kept",
	"modelSelector.favorites": "Pinned favorites",
	"budget.sessionCeilingUsd": "Session ceiling (USD)",
	"defaults.maxTokens": "Output budget (tokens)",
	"context.toolResultMaxBytes": "Tool result cap (bytes)",
	"budget.concurrency": "Fleet concurrency",
	"guardrails.turnToolCallBudget": "Turn tool-call budget",
	"guardrails.workerToolCallCap": "Worker tool-call cap",
	"guardrails.maxDispatchRuns": "Run ledger retention",
	"guardrails.readMaxBytes": "Read byte cap",
	"guardrails.observationTurnBudgetBytes": "Observation byte pool",
	"guardrails.internalDispatchTimeoutMs": "Internal dispatch timeout (ms)",
	"compaction.auto": "Auto-compact",
	"compaction.threshold": "Compaction threshold",
	"context.workingSet.enabled": "Working-set eviction",
	"context.workingSet.policy": "Eviction policy",
	"context.workingSet.target": "Eviction target pressure",
	"context.workingSet.protectLastTurns": "Turns protected from eviction",
	"context.workingSet.minEvictableTokens": "Minimum evictable tokens",
	"retry.enabled": "Retry transient errors",
	"retry.maxRetries": "Max retries",
	"retry.baseDelayMs": "Base delay (ms)",
	"retry.maxDelayMs": "Max delay (ms)",
	"retry.streamStallMs": "Stream stall timeout (ms)",
	"retry.firstTokenStallMs": "First token timeout (ms)",
	"terminal.showTerminalProgress": "Terminal progress badges",
	"terminal.outputVerbosity": "Output style",
	"terminal.tuiMode": "TUI mode",
	"terminal.fullscreenScrollbar": "Fullscreen scrollbar",
	"terminal.smoothStreaming": "Smooth streaming",
	"terminal.notify": "Desktop notifications",
	"watchdog.enabled": "Turn-end watchdog",
	"watchdog.target": "Watchdog target",
	"watchdog.cadenceToolCalls": "Watchdog cadence (tools)",
	runtimePlugins: "Runtime plugins",
	"compaction.model": "Compaction model",
	"compaction.systemPrompt": "Compaction prompt",
	"delegation.defaults.connectTimeoutMs": "Delegate connect (ms)",
	"delegation.defaults.turnTimeoutMs": "Delegate turn (ms)",
	"delegation.defaults.permissionTimeoutMs": "Delegate permission (ms)",
	targets: "Configured targets",
	keybindings: "Keybinding overrides",
	"delegation.agents": "Delegation agents",
	"library.catalog": "Library catalog path",
	"library.remote": "Library remote",
	"library.confirmedRemote": "Confirmed library remote",
	"library.sync": "Library sync",
} as const;

export const SETTINGS_DESCRIPTIONS_BY_ID = {
	autonomy: "How freely Clio acts; the safety net always applies.",
	"workers.onPermission":
		"How a worker resolves an approval ask: deny the call, fail the run, or escalate to this session.",
	"workers.escalation.timeoutMs": "How long an escalated worker approval waits for you before the fallback applies.",
	"workers.escalation.fallback": "What an escalated approval becomes when nobody answers inside the timeout.",
	"delegation.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"skills.trustProjectCompatRoots": "Allow explicitly imported foreign skills and prompts to run.",
	"attribution.gitCommits":
		"Add evidence-backed assistance, testing, review, and contributor trailers to commits created through Clio.",
	safetyNet: "Always-on rails; tuned in .clio-coder/safety.yaml.",
	"orchestrator.thinkingLevel": "Reasoning budget for the chat loop.",
	"orchestrator.target": "Active chat target id.",
	"orchestrator.model": "Active chat wire model id.",
	"background.target": "Optional target for LLM memory steps; unset keeps rules-only memory.",
	"background.model": "Small non-reasoning model used only for task memory steps.",
	"memory.intervention.enabled": "Master switch for rules-only and model-backed task memory.",
	"memory.intervention.everyNTools": "Maximum tool executions between prompted memory steps.",
	"memory.intervention.windowSteps": "Recent completed tool steps visible to the memory policy.",
	"memory.intervention.maxTokens": "Hard cap for one visible memory reminder.",
	"memory.intervention.timeoutMs": "Hard deadline for one background-model memory call.",
	"prewarm.enabled": "Send the next turn's known prefix ahead of time so a local server has already prefilled it.",
	"workers.default.target": "Default /run target id.",
	"workers.default.model": "Default /run wire model id.",
	"workers.default.thinkingLevel": "Reasoning budget for dispatched workers.",
	"workers.profiles": "Named target/model/thinking choices that native workers can use. Enter adds one.",
	"workers.agentBindings": "Pins native Clio agents, including shadow agents, to worker profiles. Enter adds one.",
	"workers.maxRetries": "Automatic retries for a retryable worker outcome.",
	"workers.resilienceCooldownMs":
		"How long a failing target, runtime, and model route is skipped before it is tried again.",
	"routing.activeRoles": "Execution roles whose joint route selection may act instead of only shadowing.",
	"routing.activePostures": "Route postures whose selection may act instead of only shadowing.",
	"routing.agentAutomation.activeAgentRoles": "Exact agent and execution-role pairs whose agent choice may act.",
	"panes.enabled": "Default panes activation for new sessions; `--with-panes` / `--no-panes` beat it.",
	"panes.notifications": "Which terminal run states raise a pane-host toast.",
	"panes.layout": "What composes itself at interactive boot: nothing, the workers dock, or workers plus files.",
	"panes.workers.ratio": "Share of the width the workers dock takes, at most half.",
	"panes.journal": "Whether every dispatched run's event tail is written to disk for `clio-coder fleet view`.",
	"panes.yazi.enabled":
		"Whether `/files`, its key, and `/panes open files` may open the files pane or the one-shot pick.",
	"panes.yazi.mode": "Keep the files pane beside the conversation, or close it after one selection.",
	"panes.yazi.profile": "Use Clio's managed, themed engine profile or the operator's own file-manager configuration.",
	"panes.yazi.followCwd": "Push the conversation directory into an already-open companion pane.",
	"panes.yazi.ratio": "Share of the height the files dock takes, at most half.",
	scope: "Configured model-cycle action set.",
	"modelSelector.recentLimit": "How many recently used models /model remembers.",
	"modelSelector.favorites": "Exact target/model refs pinned in /model.",
	"budget.sessionCeilingUsd": "Per-session cost cap.",
	"defaults.maxTokens": "Output tokens requested per turn, applied to every target.",
	"context.toolResultMaxBytes": "Maximum bytes returned from one tool result before the full text spills to scratch.",
	"budget.concurrency": "Parallel workers allowed during dispatch.",
	"guardrails.turnToolCallBudget": "Soft per-turn tool-call budget for this chat loop.",
	"guardrails.workerToolCallCap": "Lifetime ceiling on tool calls one dispatched worker may execute.",
	"guardrails.maxDispatchRuns": "How many finished runs the dispatch ledger keeps before the oldest are dropped.",
	"guardrails.readMaxBytes": "Per-call byte cap for the read tool.",
	"guardrails.observationTurnBudgetBytes": "Shared per-turn byte pool across every observation-producing tool.",
	"guardrails.internalDispatchTimeoutMs": "Wall-clock cap for one internal generator dispatch.",
	"compaction.auto": "Auto-compact before a turn when context crosses the threshold.",
	"compaction.threshold": "Pressure at which compaction masks stale observations, then summarizes.",
	"context.workingSet.enabled": "Non-destructive eviction of stale tool results before a summary is ever needed.",
	"context.workingSet.policy": "Which candidates the eviction pass selects.",
	"context.workingSet.target": "Context pressure an applied eviction batch brings the session down to.",
	"context.workingSet.protectLastTurns": "Recent user turns whose observations are never evicted.",
	"context.workingSet.minEvictableTokens":
		"Results below this token estimate stay; the marker would cost more than it saves.",
	"retry.enabled": "Retry transient provider errors on the next submit.",
	"retry.maxRetries": "Retry attempts after the initial failure.",
	"retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"retry.streamStallMs": "Silence on an in-flight stream past this long is treated as a wedged backend.",
	"retry.firstTokenStallMs": "Silence allowed before a call's first token, for backends that load the model on demand.",
	"terminal.showTerminalProgress": "Show running-task progress in terminals that support tab or taskbar badges.",
	"terminal.outputVerbosity": "How much reasoning, tool input, and live tool output appears in the transcript.",
	"terminal.tuiMode": "Use regular terminal scrollback or a fullscreen transcript with a sticky composer and footer.",
	"terminal.fullscreenScrollbar": "When the draggable transcript scrollbar is visible in fullscreen mode.",
	"terminal.smoothStreaming": "Presentation-only pacing for streamed assistant text and thinking.",
	"terminal.notify":
		"Content-free desktop notification when a turn ends, a detached batch settles, or an approval parks.",
	"watchdog.enabled": "When enabled, a turn that changed the tree is reviewed by one read-only verifier run.",
	"watchdog.target": "Set target to route the run at a cheap local model; blank uses the session's active target.",
	"watchdog.cadenceToolCalls": "Also fire every N tool calls inside a turn; blank fires at turn end only.",
	runtimePlugins:
		"Additional runtime plugin packages loaded when Clio starts. Install and enable only packages you trust.",
	"compaction.model": "Dedicated summarization model; blank uses the orchestrator.",
	"compaction.systemPrompt": "Path to a compaction prompt override; blank uses the built-in.",
	"delegation.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"delegation.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"delegation.defaults.permissionTimeoutMs": "How long a delegated permission ask may wait.",
	targets: "Inference targets available for chat and workers. Add one with `clio-coder targets add`.",
	keybindings: "Custom key overrides layered on the defaults.",
	"delegation.agents": "External ACP agents available to /delegate.",
	"library.catalog": "Path to the private resource catalog; blank uses the one in your config directory.",
	"library.remote": "Git remote the catalog syncs with; blank keeps the library entirely local.",
	"library.confirmedRemote": "The remote you confirmed. Sync refuses until it matches library.remote.",
	"library.sync": "Whether `clio-coder library sync` and `push` may talk to the remote at all.",
} as const satisfies Record<keyof typeof SETTINGS_LABELS_BY_ID, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
export const SETTINGS_HELP_BY_ID: Partial<Record<string, string>> = {
	autonomy:
		"read-only observes; suggest parks non-read calls; auto-edit edits, dispatches, and runs recognized commands; full-auto skips autonomy prompts. Safety rules can still block or require approval. A confirmation marked exposure=outward parks for you at suggest and auto-edit.",
	"defaults.maxTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"context.toolResultMaxBytes":
		"The 192KB per-turn observation pool remains authoritative. Three full 64KB results consume it, so a fourth finds it filled. Whole number of at least 4096 bytes · default: 65536 (64KB).",
	"compaction.threshold":
		"pressure = estimated tokens ÷ context window. Higher keeps more history but risks overflow before a summary runs.",
	"context.workingSet.enabled":
		"Eviction moves stale tool-result bodies and thinking blocks out of the model's working set and records a ledger entry; history is never rewritten. Off skips eviction and goes straight to summary compaction. Legal values: true, false · default: true.",
	"context.workingSet.policy":
		"structural-v1 selects by message structure; age-horizon is the older age-based rule. Legal values: structural-v1, age-horizon · default: structural-v1.",
	"context.workingSet.target":
		"An applied eviction batch keeps evicting until pressure reaches this ratio, so it sits below compaction.threshold. Greater than 0 and less than 1 · default: 0.6.",
	"context.workingSet.protectLastTurns": "Counted in user turns. Whole number of at least 1 · default: 6.",
	"context.workingSet.minEvictableTokens":
		"The floor sweep put marker break-even near 50 tokens; 200 is the churn guard. Whole number, 0 evicts anything · default: 200.",
	"guardrails.turnToolCallBudget":
		"Crossing it blocks further calls in the turn with a stop-and-summarize directive, and the hard interrupt ceiling sits a fixed margin above. A backstop against a model spraying unproductive calls, not a routine ceiling: a repo-wide audit legitimately runs dozens. Whole number of at least 1 · default: 60.",
	"guardrails.workerToolCallCap":
		"Bounds admitted calls, not attempts: a call the harness refuses never ran and never spends the cap. Dispatch takes the smaller of this and the agent recipe's own budget, so the recipe normally binds. Whole number of at least 1 · default: 150.",
	"guardrails.maxDispatchRuns":
		"Runs leaving the ring also lose their event journal directory. Whole number of at least 1 · default: 1000.",
	"guardrails.readMaxBytes":
		"Clamped up to a 1KB floor at use. Whole number of bytes, at least 1 · default: 51200 (50KB).",
	"guardrails.observationTurnBudgetBytes":
		"One pool shared by every observation-producing tool in a turn, so a single verbose tool cannot starve the rest. Whole number of bytes, at least 1 · default: 196608 (192KB).",
	"guardrails.internalDispatchTimeoutMs":
		"Covers the wiki documenter and the bootstrap scout. Continuous output satisfies the heartbeat watchdog and a run mid-generation spends no tool calls, so this is the only guard that ends a degenerate generator. Healthy runs finish in minutes. Whole milliseconds of at least 1 · default: 900000 (15 minutes).",
	"retry.streamStallMs":
		"Measured from the last token received, not from the request, so a slow-but-alive stream is never aborted. The retry then follows the same enabled/maxRetries/delay settings above. Whole milliseconds · default: 180000 (three minutes).",
	"retry.firstTokenStallMs":
		"Measured from the request until the first token. A local server that slept reloads the model and prefills cold first, so this window is longer than the stream stall timeout; the larger of the two applies. 0 never aborts a call that has not started streaming. Whole milliseconds · default: 600000 (ten minutes).",
	"library.catalog":
		"Absolute path, or blank for the catalog in your config directory. The catalog is the index `clio-coder library` reads; installed resources land in the usual skill and resource roots either way. Default: blank.",
	"library.remote":
		"A Git remote URL, or blank to keep the library local. Setting it is not enough to sync: the remote must also be confirmed, and library.sync must be true. Default: blank.",
	"library.confirmedRemote":
		"Written by the confirm flow, not by hand, because confirming a remote here would be the record confirming itself. Sync refuses with library_remote_unconfirmed until this equals library.remote. Default: blank.",
	"library.sync":
		"Off means `clio-coder library sync` and `push` refuse before touching the network, whatever the remote says. Legal values: true, false · default: false.",
	"budget.concurrency":
		"auto sizes local workers from usable CPUs and available memory, up to eight, and is the default. A fixed number caps how many workers run at once.",
	"skills.trustProjectCompatRoots":
		"Applies to foreign packages explicitly imported into Clio, at user or project scope. Loose skills/prompts in other agents' folders stay discovery-only; this setting never imports them.",
	"attribution.gitCommits":
		"Role trailers are added only when Clio has trusted evidence for that role. Disabling leaves subsequent commit messages entirely unchanged.",
	"workers.onPermission":
		"deny turns the ask into a tool denial and the run continues; fail stops the run as permission_required; escalate forwards the ask to you and falls back per fleet.permissions.escalation on timeout.",
	"workers.escalation.timeoutMs":
		"Only the escalate posture reads it, and it is what keeps that posture non-stall: a headless session has no operator to answer, so the fallback always governs there. Whole milliseconds of at least 1; default: 120000 (two minutes).",
	"workers.escalation.fallback":
		"deny turns the unanswered ask into a tool denial and the run continues; fail ends the run as permission_required. Legal values: deny, fail · default: deny.",
	"workers.resilienceCooldownMs":
		"Applied per target, runtime, and wire model after a failure class that trips the breaker; a clean run clears it immediately. Whole milliseconds, 0 disables the cooldown; default: 15000.",
	"routing.activeRoles":
		"Joint route selection stays shadow-only, recording what it would have picked, unless both the execution role and the requested posture are named as active. Legal values: researcher, verifier, reviewer, judge · default: none active.",
	"routing.activePostures":
		"Manual pins are exact rather than adaptive, so manual is never an activated posture. Legal values: quality, balanced, latency, economy · default: none active.",
	"routing.agentAutomation.activeAgentRoles":
		"Exact agentId and executionRole pairs, because independent agent and role lists would authorize their whole cross-product. Execution roles: builder, researcher, verifier, reviewer, judge; the agentId `auto` is reserved. Edit the pairs in settings.yaml; default: none active.",
	"prewarm.enabled":
		"Fires at session start, after a resume rebuilds the message array, and after a compaction settles, never while a turn or dispatch is running. Local-native targets and interactive sessions only, whatever this says. Legal values: true, false · default: false.",
	"workers.agentBindings":
		"Bind base, custom, and shadow native agents such as scout, researcher, and provenance to profiles. ACP delegation agents cannot be bound.",
	"delegation.defaults.toolGovernance":
		"clio-coder-policy gates the agent through Clio's safety net; agent-managed trusts the agent; deny-all blocks every tool.",
	scope:
		"Choose target-level or exact target/model refs. Explicit model-cycle bindings step the chat target through this list.",
	runtimePlugins: "Comma-separated package names, loaded at startup. Restart Clio after changing.",
	"terminal.notify":
		"OSC 777, or OSC 9 on iTerm2, Windows Terminal, and ConEmu. Interactive TTY runs only; the body never carries prompt text, file paths, or model output.",
	"watchdog.enabled":
		"The verifier run is briefed with the turn's coalesced diff and the task board's current scope; its blockers become one transcript notice and nothing else. Headless and ACP runs never fire it.",
	"watchdog.target":
		"A watchdog run costs a worker run per mutating turn, so routing it at a local target keeps the review cheap. Leave blank to reuse whatever the session is already talking to.",
	"watchdog.cadenceToolCalls":
		"Mid-turn firing is how scope drift becomes visible before the turn ends. Leave blank and the watchdog fires at turn end only.",
	keybindings:
		"Alt+O cycles Output style: Compact, Standard, Detailed. Use /view for full reasoning and action details. Shift+Tab changes model thinking effort.",
};

/** Per-value meaning, surfaced for the current value of an enum knob. */
export const SETTINGS_VALUE_HELP_BY_ID: Partial<Record<string, Record<string, string>>> = {
	autonomy: {
		"read-only": "observe and answer only; never edits files or runs commands",
		suggest:
			"propose every edit and command for your approval; confirmations marked exposure=outward (filing an issue or PR, pushing, releasing) park here as well",
		"auto-edit":
			"edits and dispatches run; recognized commands (tests, lint, build, .clio-coder/safety.yaml entries) run; other commands ask, as do confirmations marked exposure=outward (filing an issue or PR, pushing, releasing)",
		"full-auto":
			"skips autonomy prompts, including outward-facing confirmations; safety rules can still block or require approval",
	},
	"workers.onPermission": {
		deny: "a worker permission ask becomes a tool denial; the run continues",
		fail: "the run ends immediately as permission_required",
		escalate:
			"the ask is forwarded to this session's operator; on timeout it falls back to deny or fail per fleet.permissions.escalation",
	},
	"workers.escalation.fallback": {
		deny: "an unanswered escalation becomes a tool denial and the run continues",
		fail: "an unanswered escalation ends the run as permission_required",
	},
	"prewarm.enabled": {
		true: "prefill the next turn's known prefix on local-native targets",
		false: "never send a pre-warm request; the first turn pays the whole prefill",
	},
	"context.workingSet.enabled": {
		true: "evict stale observations non-destructively before summarizing",
		false: "skip eviction and go straight to summary compaction",
	},
	"context.workingSet.policy": {
		"structural-v1": "select eviction candidates by message structure",
		"age-horizon": "the older rule: select by age alone",
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
	// `embedded` is a declared rung with no implementation behind it yet; it
	// refuses until Clio can own a pane host, and the hint says so.
	"panes.enabled": {
		auto: "detect a herdr session and join it as a guest; no pane host, no panes",
		embedded: "not available; use auto with an existing pane host, or off",
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
		true: "emit OSC 9;4 taskbar/tab progress badges during turns",
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
		off: "preserve the current immediate 16ms-coalesced streaming behavior",
		auto: "pace only on a capable local TTY without accessibility or backpressure risk",
		on: "request grapheme-safe pacing; stdout backpressure still pauses presentation",
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
	"safety.autonomy": ["read-only", "suggest", "auto-edit", "full-auto"],
	"chat.thinkingLevel": THINKING_LEVELS,
	"fleet.default.thinkingLevel": THINKING_LEVELS,
	"fleet.permissions.mode": ["deny", "escalate", "fail"],
	"fleet.permissions.escalation.fallback": ["deny", "fail"],
	"interface.mode": ["regular", "fullscreen"],
	"interface.outputDetail": ["compact", "standard", "detailed"],
	"interface.fullscreenScrollbar": ["hidden", "auto", "always"],
	"interface.smoothStreaming": ["off", "auto", "on"],
	"interface.panes.enabled": ["off", "auto"],
	"interface.panes.layout": ["off", "workers", "cockpit"],
	"interface.panes.notifications": ["failures", "all", "off"],
	"interface.panes.files.mode": ["companion", "chooser"],
	"interface.panes.files.profile": ["managed", "user"],
	"context.workingSet.policy": ["structural-v1", "age-horizon"],
	"integrations.externalAgents.defaults.toolGovernance": ["clio-coder-policy", "agent-managed", "deny-all"],
};
const STRUCTURED = new Set([
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.nodes",
	"fleet.adaptiveRouting.agentRoles",
	"interface.keybindings",
	"integrations.externalAgents.entries",
]);
const OPTIONAL_NUMBERS = new Set(["safety.review.cadenceToolCalls"]);
const OPTIONAL_STRINGS = new Set([
	"fleet.default.node",
	"safety.review.target",
	"context.compaction.model",
	"context.compaction.systemPrompt",
]);
const EXTRA_HELP: Record<string, [string, string]> = {
	"interface.demo": [
		"Demo guidance",
		"Relevant capability suggestions during real project work and brief contextual footer tips. On by default. Tips update live; conversational guidance changes on the next turn. No automatic demonstrations or permission changes.",
	],
	"integrations.externalAgents.entries": [
		"External agent entries",
		"Configure custom ACP agents as a JSON array, including their command, arguments, and governance overrides. These commands execute when you connect; only configure agents you trust. Use the guided External agents action for known integrations.",
	],
	"fleet.default.node": [
		"Default worker node",
		"Placement for workers without an explicit node. Enter local or a configured remote node id; clear to let Clio choose placement.",
	],
	"fleet.profiles": [
		"Worker profiles",
		"Named target, model, thinking, and placement choices. Use Fleet's profile actions for guided edits, or edit this JSON object.",
	],
	"fleet.agentProfiles": [
		"Agent profile assignments",
		"Map native agent names to existing worker profile names. Use Fleet's binding actions or edit this JSON object.",
	],

	"fleet.rosters": [
		"Fleet rosters",
		"Named teams of worker profiles used by council and fleet runs. Edit the JSON object; each roster names its members.",
	],
	"fleet.nodes": [
		"Remote worker nodes",
		"Machines available for worker placement. Edit the JSON array of node records; adding a node does not change the default model.",
	],
	"fleet.worktrees.root": [
		"Task worktree storage",
		"Where isolated task worktrees are created. Use disk for the normal location, tmpfs for memory-backed storage, auto to prefer tmpfs when available, or an absolute directory you control.",
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
					: OPTIONAL_NUMBERS.has(path) || typeof raw === "number"
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

export function controlInstructions(control: SettingControl): string {
	const entry =
		control.kind === "json"
			? "Enter JSON for this collection."
			: control.kind === "list"
				? "Enter comma-separated values; clear the field for an empty list."
				: control.kind === "number"
					? "Enter a number; invalid values leave the setting unchanged."
					: "";
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
		`Open /settings ${settingsSectionForPath(control.path)} to change this in chat.`,
	]
		.filter(Boolean)
		.join("\n");
}

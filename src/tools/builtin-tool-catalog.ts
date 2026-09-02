import { BASH_HARD_CAP_BYTES } from "../core/bash-exec.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import { BASH_DEFAULT_RESULT_DISPOSITION } from "./bash.js";
import { OBSERVATION_POLICY_SLACK_BYTES, OBSERVE_SELF_CAPS } from "./observation.js";
import { toolPresentationPolicy } from "./presentation.js";
import { readMaxBytes } from "./read.js";
import {
	resolveToolPromptHint,
	type ToolMetadata,
	type ToolPromptHintRole,
	type ToolSourceInfo,
	type ToolSpec,
} from "./registry.js";

function withSourceInfo<T extends ToolSpec>(spec: T, sourceInfo: ToolSourceInfo): T {
	return { ...spec, sourceInfo };
}

function withMetadata<T extends ToolSpec>(spec: T, metadata: ToolMetadata): T {
	return { ...spec, metadata };
}

// Registry-backstop caps derive from the OBSERVE self-caps in
// src/tools/observation.ts: policy cap = self cap + slack, so a tool's own
// envelope notice (with its exact continuation call) survives shaping instead
// of being cut again and replaced by a generic hint. The 16KB summary
// policies are the explicit overrides for tools whose output is inherently
// aggregate (shell, verification runs, git, dispatch receipts, web pages).
const policyCap = (selfCapBytes: number): number => selfCapBytes + OBSERVATION_POLICY_SLACK_BYTES;

const observePolicy = (selfCapBytes: number, followUpHint: string) =>
	({ kind: "bounded", maxBytes: policyCap(selfCapBytes), followUpHint }) satisfies ToolMetadata["resultSizePolicy"];

const summaryPolicy = (followUpHint: string) =>
	({ kind: "summary", maxBytes: 16_384, followUpHint }) satisfies ToolMetadata["resultSizePolicy"];

const exactMutationPolicy = {
	kind: "exact",
	maxBytes: 8_192,
	followUpHint: "Inspect the changed file or git diff for exact follow-up context.",
} satisfies ToolMetadata["resultSizePolicy"];

// Per-tool metadata, organized by plane. OBSERVE tools share the observation
// envelope, the turn budget pool, and derived policy caps; every other plane
// declares its posture explicitly.
const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = {
	// OBSERVE: read-class, parallel, envelope + shared turn budget.
	[ToolNames.Read]: {
		objective: "Read exact UTF-8 file content with line and byte bounds.",
		uiLabel: "Read",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			readMaxBytes(),
			"Use offset/limit or a narrower locate/search tool call to inspect omitted content.",
		),
		costLatency: "local_fast",
	},
	[ToolNames.Grep]: {
		objective: "Search file contents and return line-referenced matches.",
		uiLabel: "Grep",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			OBSERVE_SELF_CAPS.grepContent,
			"Refine the pattern, path, glob, context, or limit, or use mode=files, to inspect omitted matches.",
		),
		costLatency: "local_medium",
	},
	[ToolNames.Find]: {
		objective: "Find paths by glob pattern with optional mtime ordering.",
		uiLabel: "Find",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			OBSERVE_SELF_CAPS.find,
			"Refine the pattern, path, or limit to inspect omitted paths.",
		),
		costLatency: "local_medium",
	},
	[ToolNames.Ls]: {
		objective: "List directory entries.",
		uiLabel: "List",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(OBSERVE_SELF_CAPS.ls, "Raise limit or list a narrower directory."),
		costLatency: "local_fast",
	},
	[ToolNames.CodeNav]: {
		objective: "Navigate the codewiki index by symbol, path, entry points, outline, imports, or importers.",
		uiLabel: "Nav",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(OBSERVE_SELF_CAPS.codeNav, "Raise limit or use a narrower mode/query."),
		costLatency: "local_fast",
		promptHint:
			"Use code_nav with source=workspace (default) for project code and source=clio for Clio's shipped code map; modes: symbol, path, entries, outline, deps, dependents, wiki (workspace only).",
	},
	[ToolNames.Context]: {
		objective: "Return workspace, bundled-docs, or skill context.",
		uiLabel: "Context",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			Math.max(OBSERVE_SELF_CAPS.contextDocs, OBSERVE_SELF_CAPS.contextSkills, OBSERVE_SELF_CAPS.contextWorkspace),
			"Use a narrower query or scope to inspect omitted content.",
		),
		costLatency: "local_fast",
		promptHint: {
			session:
				'On an explicit pending skill request, first load exactly that skill with context(scope="skills", name=<skill>). Follow a [Marketplace] reminder\'s exact ask_user options. Recall needed [evicted ...] content with context(scope="recall", ref=...).',
			worker:
				'This worker has no operator skill-activation channel; do not load or suggest skills. Recall needed [evicted ...] content with context(scope="recall", ref=...).',
			boundWorker:
				'Load only the harness-activated recipe-bound skills named in the persona, and only when they match the assigned task. This worker cannot install or suggest marketplace skills. Recall needed [evicted ...] content with context(scope="recall", ref=...).',
		},
	},
	[ToolNames.CredentialPresent]: {
		objective: "Check whether a credential key is present without returning its value.",
		uiLabel: "Credential",
		retrySafety: "idempotent",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 4_096,
			followUpHint: "Use the boolean result only; never ask to print the credential value.",
		},
		costLatency: "local_fast",
	},
	// MUTATE: write-class, sequential, file-mutation queue.
	[ToolNames.Write]: {
		objective: "Write a complete UTF-8 file.",
		uiLabel: "Write",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.Edit]: {
		objective: "Apply exact text replacements to one file.",
		uiLabel: "Edit",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	// EXECUTE: the safe-exec spine (canonical shaping offloads Bash overflow).
	[ToolNames.Bash]: {
		objective: "Execute an explicit shell command when narrower tools are insufficient.",
		uiLabel: "Shell",
		retrySafety: "unknown",
		resultSizePolicy: {
			...summaryPolicy("Use a narrower command or a dedicated verification/read/search tool to inspect omitted output."),
			offloadMaxBytes: BASH_HARD_CAP_BYTES,
		},
		resultDisposition: BASH_DEFAULT_RESULT_DISPOSITION,
		costLatency: "local_slow",
		promptHint:
			"bash output_policy: omit for a bounded tail; summary for noisy commands; metadata-only when only the outcome matters; full only when the output is known to fit.",
	},
	[ToolNames.Git]: {
		objective: "Read-only git inspection: status, diff, or log.",
		uiLabel: "Git",
		retrySafety: "idempotent",
		resultSizePolicy: summaryPolicy("Limit the diff/log to one path or fewer commits."),
		costLatency: "local_fast",
	},
	[ToolNames.Verify]: {
		objective: "Run declared verification checks (scripts or frontend artifacts).",
		uiLabel: "Verify",
		retrySafety: "retry_safe",
		resultSizePolicy: summaryPolicy(
			"Rerun the check with narrower args or inspect the named failing file/test directly.",
		),
		costLatency: "local_slow",
	},
	// ORCHESTRATE: agent-class, receipts as evidence.
	[ToolNames.Tasks]: {
		objective: "Declare and track the session task board with evidence-carrying completions.",
		uiLabel: "Tasks",
		// A repeated plan/start/done lands on the same board state; a repeated
		// add duplicates a task, so the surface as a whole is not retry safe.
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 8_192,
			followUpHint: 'Call tasks with action="list" to re-read the board.',
		},
		costLatency: "local_fast",
		promptHint:
			'For a request with three or more distinct steps, declare the board before the first edit: tasks(action="plan") with a title and the task list. ' +
			"start one task before working it, close it with done plus an evidence note, and block with a reason instead of stalling.",
	},
	[ToolNames.Ledger]: {
		objective: "Coordinate with the peer workers of this dispatch through typed claims, findings, and reviews.",
		uiLabel: "Ledger",
		// A repeated post lands a second entry and spends another of the run's
		// twenty posts, so the surface as a whole is not retry safe.
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 16_384,
			followUpHint: 'Call ledger with action="read" and a since sequence to re-read only what is new.',
		},
		costLatency: "local_fast",
	},
	[ToolNames.Dispatch]: {
		objective: "Dispatch bounded tasks to configured Clio workers.",
		uiLabel: "Dispatch",
		retrySafety: "not_retry_safe",
		resultSizePolicy: summaryPolicy(
			"Use the dispatch receipt paths or ask a narrower worker follow-up for omitted output.",
		),
		// No hint: the Tool Contract's inventory line already says when
		// dispatch(list:true) is the right answer, and the Fleet section says
		// everything else about routing.
		costLatency: "agent",
	},
	[ToolNames.Monitor]: {
		objective: "Inspect dispatched runs: state, recent events, receipts.",
		uiLabel: "Monitor",
		retrySafety: "idempotent",
		resultSizePolicy: summaryPolicy("Use monitor(mode=receipt) or read the receipt path for full details."),
		costLatency: "local_fast",
	},
	[ToolNames.Steer]: {
		objective: "Guide or cancel a running dispatched worker.",
		uiLabel: "Steer",
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 4_096,
			followUpHint: "Use monitor(mode=status) to confirm the run state after steering.",
		},
		costLatency: "local_fast",
	},
	[ToolNames.Panes]: {
		objective: "Focus, open, close, and inventory the terminal panes Clio owns beside this session.",
		uiLabel: "Panes",
		// show and list land on the same state twice; open starts a second pane
		// and close is a no-op the second time, so the surface as a whole is not.
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 8_192,
			followUpHint: 'Call panes with action="list" to re-read the pane inventory.',
		},
		costLatency: "local_fast",
		promptHint:
			'When the operator asks to see a dispatched agent ("show me the tester"), call panes(action="show", target=<agent id>).',
	},
	// RETRIEVE: network-class.
	[ToolNames.WebFetch]: {
		objective: "Fetch HTTP(S) text for explicit external research.",
		uiLabel: "Fetch",
		retrySafety: "retry_safe",
		resultSizePolicy: {
			kind: "bounded",
			maxBytes: 16_384,
			followUpHint: "Fetch a narrower URL or lower max_bytes to inspect a specific section.",
		},
		costLatency: "network",
	},
	// INTERACT: operator dialogue.
	[ToolNames.AskUser]: {
		objective: "Ask the operator structured questions.",
		uiLabel: "Ask",
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 20_000,
			followUpHint: "Proceed with stated assumptions if the operator cancels or no UI is available.",
		},
		costLatency: "local_slow",
		promptHint:
			'Use ask_user only when blocked on a decision the request does not answer, never about something the operator already stated: one question per round in interviews, up to four related questions otherwise, recommended option first, then action="complete" with the decisions before final prose.',
	},
	// ARTIFACT: terminal writers.
	[ToolNames.Artifact]: {
		objective: "Write terminal plan/review/report documents that complete the turn.",
		uiLabel: "Artifact",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
};

/** Canonical, role-aware prompt hints for an already-admitted tool set. */
export function toolPromptHintsForNames(
	names: ReadonlyArray<ToolName>,
	role: ToolPromptHintRole = "session",
): ReadonlyArray<{ tool: string; hint: string }> {
	const seenTools = new Set<string>();
	const seenHints = new Set<string>();
	const hints: Array<{ tool: string; hint: string }> = [];
	for (const name of [...names].sort()) {
		if (seenTools.has(name)) continue;
		seenTools.add(name);
		const hint = resolveToolPromptHint(TOOL_METADATA[name]?.promptHint, role);
		if (!hint || seenHints.has(hint)) continue;
		seenHints.add(hint);
		hints.push({ tool: name, hint });
	}
	return hints;
}

// Every builtin carries its transcript presentation on its metadata, resolved
// from the one declaration table in presentation.ts, so the registry and the
// live panel (which has no registry) answer the fold question identically.
function withBuiltinMetadata<T extends ToolSpec>(spec: T): T {
	const metadata = TOOL_METADATA[spec.name];
	if (!metadata) return spec;
	// The read cap is a guardrail (`safety.limits.readBytesPerCall`) installed
	// from settings after this module loads, so the table's import-time value
	// is the default, not the operator's. Recompute the policy cap when the tool
	// is registered; the drift check in policy.ts compares against the live cap
	// and a settings file raising the read cap used to fail boot.
	const resultSizePolicy =
		spec.name === ToolNames.Read
			? observePolicy(readMaxBytes(), metadata.resultSizePolicy?.followUpHint ?? "")
			: metadata.resultSizePolicy;
	return withMetadata(spec, {
		...metadata,
		...(resultSizePolicy ? { resultSizePolicy } : {}),
		presentation: toolPresentationPolicy(spec.name, undefined),
	});
}

export function builtin<T extends ToolSpec>(spec: T, sourceInfo: ToolSourceInfo): T {
	return withBuiltinMetadata(withSourceInfo(spec, sourceInfo));
}

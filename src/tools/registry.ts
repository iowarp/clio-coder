import type { TSchema } from "typebox";
import type { ToolName } from "../core/tool-names.js";
import type { ModesContract } from "../domains/modes/contract.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";

/**
 * Tool registry. Admission point for every tool call. Filters visible tools
 * by current mode, delegates classification + hard-block decisions to the
 * safety domain, then enforces the per-mode action-class policy gate before
 * running the tool body. Never throws on safety rejections; the caller (agent
 * loop in Phase 4) surfaces the rejection message back to the model.
 */

/**
 * Per-tool execution mode override forwarded to pi-agent-core's
 * `AgentTool.executionMode`. Parallel tools may run concurrently with other
 * parallel tool calls; sequential tools run one at a time and prevent any
 * other tool in the batch from running in parallel with them. Leaving this
 * undefined defers to the agent loop's global `toolExecution` setting.
 */
export type ToolExecutionMode = "sequential" | "parallel";

export interface ToolSpec {
	name: ToolName;
	description: string;
	/**
	 * TypeBox schema advertised to the model so it knows which named
	 * parameters the tool accepts. Must be a Type.Object(...). Runtime
	 * validation still happens inside `run()` — the schema is advisory
	 * to the model, not an enforcement boundary.
	 */
	parameters: TSchema;
	/** Base action class for this tool when arguments are trivial. */
	baseActionClass: ActionClass;
	/**
	 * Modes in which this tool is admissible. When undefined, every mode is
	 * allowed (the mode matrix remains authoritative for visibility). When set,
	 * `invoke` rejects with `not_visible` for any mode outside this list.
	 */
	allowedModes?: ReadonlyArray<ModeName>;
	/**
	 * Per-tool execution mode. Read-only tools set `"parallel"` so the model
	 * can batch scans; mutating or filesystem-racing tools set `"sequential"`
	 * so two `bash` or `edit` calls in the same batch never run concurrently.
	 */
	executionMode?: ToolExecutionMode;
	/** Execute the tool. Only called after admission. */
	run(args: Record<string, unknown>): Promise<ToolResult>;
}

export type ToolResult =
	| {
			kind: "ok";
			output: string;
			/**
			 * Early-termination hint propagated to pi-agent-core's
			 * `AgentToolResult.terminate`. When every finalized tool result in
			 * the current batch sets this to true, the agent loop stops without
			 * a follow-up LLM call. Used by terminal advise-mode writers
			 * (write_plan, write_review) where writing the artifact is the
			 * whole turn.
			 */
			terminate?: boolean;
	  }
	| { kind: "error"; message: string };

export interface RegistryDeps {
	safety: SafetyContract;
	modes: ModesContract;
}

export interface ToolRegistry {
	register(spec: ToolSpec): void;
	/** Tools visible to the current mode. Models only see these. */
	listVisible(): ReadonlyArray<ToolSpec>;
	/** Tools registered overall, regardless of mode. For /audit, /doctor. */
	listAll(): ReadonlyArray<ToolSpec>;
	/** Lookup by tool id. */
	get(name: ToolName): ToolSpec | undefined;
	/**
	 * Tool names admissible in `mode`. A tool qualifies when its `allowedModes`
	 * list includes `mode`, or when `allowedModes` is undefined (meaning every
	 * mode). This is the mode-filter primitive workers use to resolve the
	 * per-run tool set without pulling in the live ModesContract; the mode
	 * matrix remains authoritative for interactive visibility.
	 */
	listForMode(mode: ModeName): ReadonlyArray<ToolName>;
	/**
	 * Admission point. Classifies, evaluates safety, and either runs or
	 * returns a rejection. Never throws on safety rejections.
	 */
	invoke(call: ClassifierCall): Promise<RegistryVerdict>;
}

export type RegistryVerdict =
	| { kind: "ok"; result: ToolResult; decision: SafetyDecision }
	| { kind: "blocked"; reason: string; decision: SafetyDecision }
	| { kind: "not_visible"; reason: string };

export function createRegistry(deps: RegistryDeps): ToolRegistry {
	const tools = new Map<ToolName, ToolSpec>();

	return {
		register(spec) {
			tools.set(spec.name, spec);
		},
		listAll: () => Array.from(tools.values()),
		get: (name) => tools.get(name),
		listForMode: (mode) =>
			Array.from(tools.values())
				.filter((t) => !t.allowedModes || t.allowedModes.includes(mode))
				.map((t) => t.name),
		listVisible: () => {
			const visible = deps.modes.visibleTools();
			return Array.from(tools.values()).filter((t) => visible.has(t.name));
		},
		async invoke(call) {
			const spec = tools.get(call.tool as ToolName);
			if (!spec) {
				return { kind: "not_visible", reason: `tool not registered: ${call.tool}` };
			}
			const visible = deps.modes.visibleTools();
			if (!visible.has(spec.name)) {
				return { kind: "not_visible", reason: `tool ${spec.name} not in current mode's allowlist` };
			}
			const currentMode = deps.modes.current();
			if (spec.allowedModes && !spec.allowedModes.includes(currentMode)) {
				return {
					kind: "not_visible",
					reason: `tool ${spec.name} not allowed in mode ${currentMode}`,
				};
			}
			const decision = deps.safety.evaluate(call, currentMode);
			if (decision.kind === "block") {
				return { kind: "blocked", reason: decision.rejection.short, decision };
			}
			if (!deps.modes.isActionAllowed(decision.classification.actionClass)) {
				return {
					kind: "blocked",
					reason: `action ${decision.classification.actionClass} not allowed in mode ${currentMode}`,
					decision,
				};
			}
			try {
				const result = await spec.run(call.args ?? {});
				return { kind: "ok", result, decision };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { kind: "ok", result: { kind: "error", message }, decision };
			}
		},
	};
}

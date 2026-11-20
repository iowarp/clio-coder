/**
 * `clio-coder run --dry-run` (SPEC 6.4, CLI-L4): what the main run would do, resolved from its flags and settings
 * and printed without a session, a model call or a `--verify` command. Loaded only when the flag is given.
 */

import type { ClioSettings } from "../core/config.js";
import { sandboxAvailability } from "../core/sandbox/availability.js";
import { ALL_TOOL_NAMES } from "../core/tool-names.js";
import { type TurnConstraints, turnAllowsTool, turnDelegatesTool } from "../core/turn-constraints.js";
import type { RunCliArgs } from "./args.js";
import { noteRunPlan } from "./run-failure.js";

export interface RunPlan {
	route: { target: string | null; model: string | null; thinking: string };
	autonomy: string;
	readOnly: boolean;
	/** Builtin tools the task scope admits; extension and MCP tools are found at boot under the same scope. */
	tools: string[];
	/** Builtin tools a dispatched worker may hold; empty under `--no-delegate`. */
	delegatedTools: string[];
	sandbox: { mode: string; available: boolean; backend: string | null; reason: string | null };
	limits: {
		timeoutSeconds: number | null;
		maxCostUsd: number | null;
		maxRequests: number | null;
		maxToolCalls: number | null;
		maxContextTokens: number | null;
		verifyTimeoutSeconds: number | null;
	};
	/** `--verify` commands run by the host after the turn, outside the agent's permissions and sandbox (SPEC 6.3). */
	verify: Array<{ command: string; authority: "host" }>;
}

export function buildRunPlan(
	parsed: RunCliArgs,
	settings: Readonly<ClioSettings>,
	verifyTimeoutSeconds: number,
): RunPlan {
	const constraints: TurnConstraints | undefined = parsed.constraints;
	const forbidden = constraints?.delegation === "forbidden";
	const sandbox = sandboxAvailability();
	return {
		route: {
			target: parsed.target ?? settings.chat.target ?? null,
			model: parsed.model ?? (parsed.target === undefined ? (settings.chat.model ?? null) : null),
			thinking: parsed.thinking ?? settings.chat.thinkingLevel,
		},
		autonomy: parsed.autonomy ?? settings.safety.autonomy,
		readOnly: parsed.readOnly,
		tools: ALL_TOOL_NAMES.filter((name) => turnAllowsTool(constraints, name)),
		delegatedTools: forbidden ? [] : ALL_TOOL_NAMES.filter((name) => turnDelegatesTool(constraints, name)),
		sandbox: {
			mode: settings.safety.sandbox,
			available: sandbox.available,
			backend: sandbox.backend,
			reason: sandbox.reason,
		},
		limits: {
			timeoutSeconds: parsed.timeoutSeconds ?? null,
			maxCostUsd: parsed.maxCostUsd ?? null,
			maxRequests: parsed.maxRequests ?? null,
			maxToolCalls: parsed.maxToolCalls ?? null,
			maxContextTokens: parsed.maxContextTokens ?? null,
			verifyTimeoutSeconds: parsed.verify.length > 0 ? verifyTimeoutSeconds : null,
		},
		verify: parsed.verify.map((command) => ({ command, authority: "host" as const })),
	};
}

/** Prints the plan: under `--output-format` the v2 envelope carries it as `plan`, else it is JSON on stdout. */
export function writeRunPlan(parsed: RunCliArgs, plan: RunPlan): number {
	if (parsed.outputFormat !== undefined) noteRunPlan(plan);
	else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
	return 0;
}

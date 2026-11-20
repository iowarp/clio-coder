/**
 * `clio-coder run --dry-run` (SPEC 6.4, CLI-L4): what the main run would do, resolved from its flags and settings
 * and printed without a session, a model call or a `--verify` command. Loaded only when the flag is given.
 */

import type { ClioSettings } from "../core/config.js";
import { sandboxAvailability } from "../core/sandbox/availability.js";
import { ALL_TOOL_NAMES } from "../core/tool-names.js";
import { type TurnConstraints, turnAllowsTool, turnDelegatesTool } from "../core/turn-constraints.js";
import { type RunCliArgs, requestedRunLimits } from "./args.js";
import type { RunLimitsV2 } from "./modes/run-json-schema-v2.js";
import { noteRunPlan, type RunRefusal, runLimitsV2 } from "./run-failure.js";

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
		/** SPEC 6.9: what was requested and which of it this route enforces, as the v2 envelope lists it. */
		requested: RunLimitsV2["requested"];
		enforced: string[];
		cost?: RunLimitsV2["cost"];
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
	const requested = requestedRunLimits(parsed);
	const limits = runLimitsV2(requested);
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
			mode: parsed.sandboxRequired === true ? "required" : settings.safety.sandbox,
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
			requested,
			enforced: limits?.enforced ?? [],
			...(limits?.cost !== undefined ? { cost: limits.cost } : {}),
		},
		verify: parsed.verify.map((command) => ({ command, authority: "host" as const })),
	};
}

/**
 * `--require-priced` under `--dry-run` (CLI-P16): the refusal the real run's preflight would write, or undefined.
 * Same reach as `runHeadlessMainAgent`: the main routes under `--no-delegate`, else the worker routes too. Declaring
 * the route's pricing is the fix, so it is C17 `not_configured` (SPEC 6.9).
 */
export async function dryRunPricingRefusal(
	parsed: RunCliArgs,
	settings: Readonly<ClioSettings>,
): Promise<RunRefusal | undefined> {
	if (parsed.requirePriced !== true) return undefined;
	const [{ loadDomains }, { ConfigDomainModule }, { ProvidersDomainModule }, { unpricedRunRoutes }] = await Promise.all([
		import("../core/domain-loader.js"),
		import("../domains/config/index.js"),
		import("../domains/providers/index.js"),
		import("../domains/providers/unpriced-routes.js"),
	]);
	const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
	try {
		const delegating = parsed.constraints?.delegation !== "forbidden";
		const unpriced = unpricedRunRoutes(settings, loaded.getContract("providers"), delegating ? "delegating" : "main");
		if (unpriced.length === 0) return undefined;
		return {
			slug: "not_configured",
			message: `clio-coder run: --require-priced: routes this run can reach have no known pricing: ${unpriced.join(", ")}; declare targets[].pricing for them${delegating ? " or add --no-delegate if only worker routes are listed" : ""}\n`,
		};
	} finally {
		await loaded.stop();
	}
}

/** SPEC 6.6 v2 row: an absent value is an absent key, so v2 never sends `null` for an optional field (CLI-P15). */
function withoutNulls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutNulls);
	if (value === null || typeof value !== "object") return value;
	const kept: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(value)) if (field !== null) kept[key] = withoutNulls(field);
	return kept;
}

/**
 * Prints the plan: under `--output-format` the v2 envelope carries it as `plan` with absent values left out, else it
 * is JSON on stdout as before.
 */
export function writeRunPlan(parsed: RunCliArgs, plan: RunPlan): number {
	if (parsed.outputFormat !== undefined) noteRunPlan(withoutNulls(plan) as object);
	else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
	return 0;
}

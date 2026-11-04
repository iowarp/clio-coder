/**
 * What an engine kind is. Resolution, status and the runner read this table and
 * never a kind's or a vendor's name, so a new kind is one row here and one module
 * under `engines/`.
 *
 * A model Clio ships would add a `bundled` row: `create` loads it in process and
 * returns a `null` destination, because no byte leaves; `problem` reports a missing
 * asset; its profile row in `profiles.ts` declares what it reads. Nothing is bundled
 * today.
 */

import type { SystemOneEngineSettings } from "../../core/defaults.js";
import type { OneShotPort } from "../providers/one-shot.js";
import type { RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { createLlmEngine, llmEngineProblem } from "./engines/llm.js";
import type { EngineHost } from "./engines/shared.js";
import { createSystemOneEngine } from "./engines/systemone.js";
import type { DecisionEngine, EngineKind } from "./types.js";

export interface EngineKindInput {
	readonly name: string;
	readonly cfg: SystemOneEngineSettings;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly host: EngineHost;
	readonly oneShot?: OneShotPort | undefined;
}

export interface EngineKindDefinition {
	/** How long one request on this kind may take. Unmeasured: a bound, not a fit to any recorded latency. The point's total caps it. */
	readonly routeTimeoutMs: number;
	/** Why this configuration cannot answer, or null when it can. Reads no credential beyond what `missingKey` was given. */
	problem(
		input: Omit<EngineKindInput, "host">,
		missingKey: (runtime: RuntimeDescriptor) => string | null,
	): string | null;
	create(input: EngineKindInput): DecisionEngine;
}

export const ENGINE_KINDS: Readonly<Record<EngineKind, EngineKindDefinition>> = {
	systemone: {
		routeTimeoutMs: 5_000,
		problem: ({ runtime }, missingKey) =>
			// Declaring the capability and implementing the verb are separate claims,
			// and a target bound here by mistake is likelier an ordinary chat model.
			runtime.decide ? missingKey(runtime) : `runtime '${runtime.id}' does not answer typed decisions`,
		create: ({ name, cfg, target, runtime, host }) =>
			createSystemOneEngine({ name, target, runtime, model: cfg.model ?? null, host, profile: cfg.profile }),
	},
	llm: {
		routeTimeoutMs: 30_000,
		problem: ({ cfg, target, runtime, oneShot }) =>
			llmEngineProblem({ target, runtime, model: cfg.model ?? null, oneShot: oneShot !== undefined }),
		create: ({ name, cfg, target, runtime, host, oneShot }) =>
			createLlmEngine({ name, target, runtime, model: cfg.model ?? null, host, oneShot }),
	},
};

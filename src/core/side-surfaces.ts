import type { AgentRole } from "./telemetry/enums.js";

/**
 * Every model call made beside the main agent names the surface that made it. The id rides `call.started` as
 * `purpose`, so a fold can split a side role by what its calls were for (memory design 4.1). Types and ids only: no
 * behaviour reads this table except attribution.
 */
export const SURFACE_IDS = [
	"memory.observe",
	"memory.reflect",
	"memory.bank",
	"memory.correct",
	"memory.lesson",
	"memory.retain",
	"memory.history",
	"memory.consolidate",
	"memory.classify",
	"compaction.history",
	"compaction.split",
	"compaction.live",
	"compaction.native",
	"judge",
	"judge.screen",
	"triage",
	"prewarm",
	"keepalive",
	"vision",
	"btw",
	"draft",
	"handoff",
] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];
export type MemorySurfaceId = Extract<SurfaceId, `memory.${string}`>;

export interface SideSurface {
	id: SurfaceId;
	/** The journal role its calls are made under. */
	role: AgentRole;
	/** Who reads the output, in words. */
	consumer: string;
	/**
	 * The route runtimes that can exercise it; absent means any route can. On any other route the surface is
	 * `unsupported`, which is not the same as a surface that could have fired and did not.
	 */
	runtimes?: readonly string[];
}

export const SIDE_SURFACES: readonly SideSurface[] = [
	{ id: "memory.observe", role: "memory", consumer: "the compaction that substitutes prepared observations" },
	{ id: "memory.reflect", role: "memory", consumer: "the observation journal once its ready batches exceed its budget" },
	{ id: "memory.bank", role: "memory", consumer: "restoration after a committed context fold" },
	{ id: "memory.correct", role: "memory", consumer: "the session's next request, after a repeated failure" },
	{ id: "memory.lesson", role: "memory", consumer: "later sessions, from a live turn-end or idle lesson pass" },
	{ id: "memory.retain", role: "memory", consumer: "later sessions, from a completed task" },
	{ id: "memory.history", role: "memory", consumer: "later sessions, from earlier sessions of the repository" },
	{ id: "memory.consolidate", role: "memory", consumer: "the durable lesson store" },
	{ id: "memory.classify", role: "memory", consumer: "the scope and kind of an operator statement" },
	{ id: "compaction.history", role: "compaction", consumer: "the first request after the fold" },
	{ id: "compaction.split", role: "compaction", consumer: "the first request after the fold, for a split turn" },
	{ id: "compaction.live", role: "compaction", consumer: "the first request after the fold, inside the live prefix" },
	{
		id: "compaction.native",
		role: "compaction",
		consumer: "the first request after the provider's own fold",
		// The provider's own compaction exists only on the Codex Responses route (`settings.context.compaction.provider`).
		runtimes: ["openai-codex"],
	},
	{ id: "judge", role: "safety-judge", consumer: "the admission of the call that would have parked" },
	{ id: "judge.screen", role: "system-one", consumer: "the safety judge's review of the same call" },
	{ id: "triage", role: "helper", consumer: "the operator's queued steering messages" },
	{ id: "prewarm", role: "prewarm", consumer: "the first request on the warmed route" },
	{ id: "keepalive", role: "prewarm", consumer: "the cache read of the session's next request" },
	{ id: "vision", role: "helper", consumer: "the main request that carries the image description" },
	{ id: "btw", role: "btw", consumer: "the operator's side question" },
	{ id: "draft", role: "helper", consumer: "the operator's draft candidates" },
	{ id: "handoff", role: "handoff", consumer: "the handoff document" },
];

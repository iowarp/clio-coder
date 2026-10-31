import type { Static } from "typebox";
import { Type } from "typebox";
import { Id, PageCursor } from "./common.js";
import type { CallFilter } from "./wire.js";
import { FactRefSchema, TELEMETRY_DTO_SCHEMAS } from "./wire.js";

/**
 * The telemetry read model over HTTP (#434 §11.3). Responses are the read-model DTOs unchanged, so a number the GUI
 * shows is the one `clio-coder telemetry … --json` prints: every quantity is `{ fact, display, ref }`, the client
 * renders `display` and resolves `ref` through the explain route. These reads are cold: they fold the journals on
 * disk, so they answer for closed sessions and never touch the live ACP session.
 */

const closed = { additionalProperties: false };
const utc = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const commaList = (item: string, maxLength: number) =>
	Type.Optional(Type.String({ maxLength, pattern: `^${item}(?:,${item})*$` }));

export const TelemetrySession = TELEMETRY_DTO_SCHEMAS.session;
export const TelemetryCalls = TELEMETRY_DTO_SCHEMAS.calls;
export const TelemetryCost = TELEMETRY_DTO_SCHEMAS.cost;
export const TelemetryCache = TELEMETRY_DTO_SCHEMAS.cache;
export const TelemetryTimeline = TELEMETRY_DTO_SCHEMAS.timeline;
export const TelemetryWhyStopped = TELEMETRY_DTO_SCHEMAS.whyStopped;
export const TelemetryExplanation = TELEMETRY_DTO_SCHEMAS.explanation;
export const TelemetryQuota = TELEMETRY_DTO_SCHEMAS.quota;
export const TelemetryUpdate = TELEMETRY_DTO_SCHEMAS.update;
/** A run's sealed receipt through its integrity check: the facts the seal vouches for, never the raw document. */
export const TelemetryRunEvidence = TELEMETRY_DTO_SCHEMAS.runEvidence;

/** Query strings are flat, so list filters arrive comma-separated; the service rebuilds and checks the CallFilter. */
export const TelemetryCallsQuery = Type.Object(
	{
		roles: commaList("[a-z-]{1,32}", 256),
		dispositions: commaList("[a-z_]{1,32}", 256),
		turnIds: commaList("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", 4096),
		runId: Type.Optional(Id),
		from: Type.Optional(utc),
		to: Type.Optional(utc),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
	},
	closed,
);
export type TelemetryCallsQuery = Static<typeof TelemetryCallsQuery>;
export const TelemetryCostQuery = Type.Object(
	{ by: Type.Optional(Type.Union([Type.Literal("role"), Type.Literal("model"), Type.Literal("turn")])) },
	closed,
);
export const TelemetryRangeQuery = Type.Object({ from: Type.Optional(utc), to: Type.Optional(utc) }, closed);
export const TelemetryExplainQuery = Type.Object({ ref: FactRefSchema }, closed);

interface SessionRead {
	sessionId: string;
	/**
	 * The host holds this session, so a missing journal is unknown coverage and answers a DTO that says so (R9);
	 * only an id the host has never seen is a missing resource.
	 */
	knownSession?: boolean;
}
export type TelemetryRequest =
	| ({ kind: "session" | "cache" | "why-stopped" } & SessionRead)
	| ({ kind: "calls"; filter: CallFilter } & SessionRead)
	| ({ kind: "cost"; by: "role" | "model" | "turn" } & SessionRead)
	| ({ kind: "timeline"; range: { from: string; to: string } | null } & SessionRead)
	| { kind: "runs"; limit: number; cursor?: string }
	| { kind: "run"; runId: string }
	| { kind: "run-timeline"; runId: string }
	| { kind: "run-cost"; runId: string }
	| { kind: "explain"; ref: string };

export const TelemetryRun = TELEMETRY_DTO_SCHEMAS.run;
export const TelemetryRunTimeline = TELEMETRY_DTO_SCHEMAS.runTimeline;
export const TelemetryRunRow = TELEMETRY_DTO_SCHEMAS.runs.items;
/** Run journals newest write first; a run directory with no journal lists last with unknown coverage (R9). */
export const TelemetryRuns = Type.Object(
	{ runs: TELEMETRY_DTO_SCHEMAS.runs, nextCursor: Type.Union([PageCursor, Type.Null()]) },
	closed,
);
export const TelemetryRunsQuery = Type.Object(
	{ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cursor: Type.Optional(PageCursor) },
	closed,
);
export const TELEMETRY_RUNS_PAGE = 50;

/** `_meta["clio-coder/telemetry"]` on initialize: the read methods and the coalesced update notification (#434). */
export const TelemetryCapability = Type.Object(
	{
		version: Type.Literal(1),
		methods: Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 128 })),
		update: Type.String({ maxLength: 128 }),
	},
	closed,
);
export type TelemetryCapability = Static<typeof TelemetryCapability>;

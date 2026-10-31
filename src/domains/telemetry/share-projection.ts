import type { EVENTS, JournalEventName, JournalPayload } from "../../core/telemetry/events.js";

/**
 * What a share below the research profile keeps of each record and structural object (#434). Removing known-bad
 * fields one at a time kept missing the next one, so this is an allowlist: every field of every shareable event's
 * payload is classified here, a field or nested key the table does not name is dropped, free text of any kind is
 * withheld, and identities and paths become anonymous ids keyed by the source installation. A shared record or object
 * must be a fixed point of its projection, which is what `telemetry verify` and `telemetry import` check.
 */

/** Identities a share replaces with an anonymous id: stable for one installation, unrecoverable without its key. */
export type AnonKind = "host" | "user" | "path" | "endpoint" | "config";
/**
 * `keep`: the subtree is structural (ids, vocabularies, numbers, hashes, facts). `withhold`: every string in it is
 * free text and becomes {@link WITHHELD}. `drop`: the optional field is left out. An {@link AnonKind}: every string in
 * it becomes an anonymous id. `json-schema`: a tool's parameter schema keeps its structural keywords. An object
 * applies field by field, and to each element of an array.
 */
export type FieldProjection =
	| "keep"
	| "withhold"
	| "drop"
	| "json-schema"
	| AnonKind
	| { readonly [field: string]: FieldProjection };

export const WITHHELD = "[withheld]";
export const ANONYMOUS_ID = /^anon_[0-9a-f]{16}$/u;

type AllKeys<T> = T extends unknown ? keyof T : never;
type PayloadProjection<T> = { readonly [K in AllKeys<T>]-?: FieldProjection };
/** Research-tier events never leave below the research profile, which admits a record before it is projected. */
export type ShareableEventName = {
	[N in JournalEventName]: (typeof EVENTS)[N]["tier"] extends "research" ? never : N;
}[JournalEventName];

function keep<const K extends string>(...fields: K[]): Record<K, "keep"> {
	return Object.fromEntries(fields.map((field) => [field, "keep"])) as Record<K, "keep">;
}

const CALL_FIELDS = ["objects", "callId", "attemptId", "attempt", "target", "roundKind", "toolChoice"] as const;
const SEAL = keep("head", "records", "segments", "objects");
const LIBRARY = keep(
	"operationId",
	"kind",
	"id",
	"version",
	"contentDigest",
	"envelopeDigest",
	"scope",
	"sourceId",
	"actor",
);

/** Every shareable event's payload, field by field; the type requires each field to be classified. */
export const SHARE_EVENT_PROJECTIONS: { readonly [N in ShareableEventName]: PayloadProjection<JournalPayload<N>> } = {
	"call.started": keep(...CALL_FIELDS),
	"call.settled": {
		...keep(
			...CALL_FIELDS,
			"disposition",
			"usage",
			"pricing",
			"stages",
			"transport",
			"cache",
			"quota",
			"responseId",
			"interruptedEstimate",
		),
		stop: { reason: "keep", failure: "keep", detail: "withhold" },
	},
	"call.linked": keep("runId", "callId"),
	"compaction.settled": keep("callIds", "outcome", "checkpointTurnId"),
	"journal.gap": keep("sink", "reason", "count"),
	"session.opened": {},
	"session.resumed": keep("via"),
	"session.forked": keep("parentSessionId", "parentCwdHash", "parentTurnId", "parentTurnAt"),
	"session.closed": keep("reason"),
	"journal.segment_closed": keep("reason"),
	"turn.settled": keep("stopReason", "terminal"),
	"run.settled": {
		...keep(
			"version",
			"agentId",
			"executionRole",
			"requestOrigin",
			"route",
			"node",
			"routeDecision",
			"attempt",
			"phaseTiming",
			"routingIntent",
			"startedAt",
			"endedAt",
			"outcome",
			"outcomeCode",
			"exitCode",
			"terminalReason",
			"callIds",
			"processExitCode",
			"boundKind",
			"repairRounds",
			"frameType",
			"usage",
			"totalTokens",
			"apiCalls",
			"pricing",
			"toolCalls",
			"tools",
			"skills",
			"toolActivity",
			"capabilityMismatch",
			"context",
			"blockedAttempts",
			"escalations",
			"toolGovernance",
			"verification",
			"findings",
			"worktree",
			"hostVerification",
			"contextProvenance",
			"hashes",
			"result",
		),
		identity: { host: "host", user: "user" },
		// What a run said about itself, its budget wording and its validation claims are the worker's own prose.
		outcomeDetail: "withhold",
		failureMessage: "withhold",
		budget: "withhold",
		upstream: { responseModelIds: "keep", gatewayRoutes: "withhold" },
		flowRestrictions: {
			version: "keep",
			restrictions: { ruleId: "keep", policyHash: "keep", sourceRef: "path", recipients: "keep" },
			advisory: "withhold",
		},
		quality: {
			typedValidations: { sourceId: "path", validatorDigest: "keep", passed: "keep" },
			responseSchema: { sourceId: "path", schemaDigest: "keep", runtimeEnforceable: "keep", enforcementPassed: "keep" },
			resultContract: { sourceId: "path", validatorDigest: "keep", conformance: "keep", quality: "keep" },
		},
		validationGrounding: { claimed: "keep", grounded: "keep", ungrounded: "withhold", basis: "keep" },
	},
	"run.feed_appended": keep("seq", "body"),
	"run.usage_reported": keep(
		"source",
		"scope",
		"partId",
		"revision",
		"coverage",
		"pricingCoverage",
		"callCountCoverage",
		"target",
		"usage",
		"totalTokens",
		"apiCalls",
		"missingTokenCalls",
		"pricing",
	),
	"run.linked": keep("runId"),
	"run.enqueued": keep(
		"runId",
		"agentId",
		"requestOrigin",
		"targetId",
		"wireModelId",
		"runtimeId",
		"runtimeKind",
		"node",
		"endpointLimit",
		"gate",
		"rerouteCount",
	),
	"run.started": keep("pid", "assignmentId", "attempt"),
	"route.decided": keep(
		"policyVersion",
		"mode",
		"posture",
		"decisionHash",
		"decisionDurationMs",
		"confidence",
		"selected",
		"executed",
		"fallbacks",
		"recommendedAgentId",
		"candidates",
		"reasons",
		"verdict",
	),
	"gate.decided": keep(
		"decisionId",
		"group",
		"topology",
		"cycle",
		"outcome",
		"subjects",
		"decider",
		"winner",
		"confirms",
		"digest",
	),
	"code_step.settled": keep(
		"runId",
		"stepId",
		"commandId",
		"startedAt",
		"durationMs",
		"timeoutMs",
		"exitCode",
		"signal",
		"timedOut",
		"commands",
		"outputBytes",
		"outputTruncated",
		"outputDigest",
		"reportDigest",
	),
	"process.started": {},
	"process.exited": keep("exitCode"),
	"process.booted": keep("surface", "node", "platform", "totalMs", "phases", "interactivity"),
	"prewarm.decided": keep("round", "trigger", "targetId", "model", "ran", "reason", "detail", "durationMs"),
	"prewarm.settled": keep(
		"round",
		"targetId",
		"model",
		"trigger",
		"ttftMs",
		"apiMs",
		"promptTokens",
		"aborted",
		"detached",
		"failed",
	),
	// Trust axes, finding tags and verdicts are vocabularies and ids; the finding prose is the referenced object (#434).
	"evidence.assessed": keep(
		"version",
		"attempt",
		"firstPassSuccess",
		"failureCause",
		"trust",
		"findings",
		"verdicts",
		"provenance",
		"text",
	),
	"old_telemetry.removed": keep("files", "directories", "rewritten", "skipped", "failed"),
	"run.sealed": SEAL,
	"session.sealed": SEAL,
	"process.sealed": SEAL,
	"share.sealed": { ...SEAL, profile: "keep" },
	"quota.read": {
		...keep(
			"provider",
			"targetId",
			"source",
			"observedAt",
			"windows",
			"displayName",
			"status",
			"plan",
			"credits",
			"retryAfterSeconds",
			"stale",
			"limitReached",
		),
		message: "withhold",
	},
	"budget.crossed": keep("level", "spendUsd", "projectedUsd", "ceilingUsd", "contextTokens"),
	"budget.held": keep(
		"level",
		"spendUsd",
		"projectedUsd",
		"ceilingUsd",
		"contextTokens",
		"outcome",
		"waitedMs",
		"raisedToUsd",
		"raisedBy",
	),
	"config.snapshotted": keep("settings", "settingsFingerprint"),
	// Changed settings are named by their key paths, which are structure; the values live in the config objects.
	"config.changed": keep("source", "scope", "paths", "before", "after", "settingsFingerprint"),
	"health.sampled": keep("windowMs", "loopLag", "rssBytes", "writer"),
	"tool.settled": keep("tool", "outcome", "durationMs", "parkedMs", "resultBytes", "images", "terminate", "blocked"),
	"tool.decided": keep(
		"tool",
		"actionClass",
		"decision",
		"exposure",
		"posture",
		"requestId",
		"ruleId",
		"reasonCode",
		"policySource",
		"policyHash",
	),
	"approval.requested": keep(
		"tool",
		"actionClass",
		"requestId",
		"origin",
		"requestedBy",
		"agentId",
		"axis",
		"posture",
		"ruleId",
		"reasonCode",
		"policySource",
		"timeoutMs",
		"fallback",
		"escalation",
		"approvalAuthority",
		"forwardedByMain",
	),
	"approval.resolved": keep(
		"status",
		"requestId",
		"origin",
		"decidedBy",
		"tool",
		"actionClass",
		"requestedBy",
		"fallback",
		"grant",
	),
	"run.aborted": keep("source", "runId", "startedAt", "elapsedMs"),
	"turn.aborted": keep("source"),
	"agent.status_changed": keep(
		"phase",
		"prevPhase",
		"elapsedFromStart",
		"watchdogTier",
		"toolName",
		"attempt",
		"agentName",
		"stopReason",
	),
	"completion.evaluated": keep(
		"decision",
		"reason",
		"rigor",
		"mutatedPaths",
		"evidenceKinds",
		"quality",
		"verification",
	),
	"safety.judged": keep(
		"tool",
		"actionClass",
		"verdict",
		"latencyMs",
		"workerRunId",
		"askRule",
		"rule",
		"target",
		"model",
		"noVerdict",
		"operatorMessages",
	),
	"prompt.compiled": keep(
		"structure",
		"layoutVersion",
		"tokenEstimate",
		"sections",
		"thinkingLevel",
		"contextWindow",
		"contextWindowSource",
	),
	"context.snapshotted": keep(
		"snapshotId",
		"providerId",
		"runtimeId",
		"modelId",
		"promptSegments",
		"splits",
		"promptHash",
		"toolSignature",
		"messageRange",
		"divergenceRatio",
		"categories",
		"window",
		"source",
		"estimatedTokens",
		"reconciledTokens",
	),
	"auth.refreshed": keep(
		"provider",
		"trigger",
		"attempted",
		"outcome",
		"writerPid",
		"updatedAtBefore",
		"updatedAtAfter",
		"durationMs",
	),
	"middleware.fired": keep("hook", "phase", "ruleId", "effects", "severity", "evidence", "tool"),
	"system_one.decided": keep("site", "moment", "outcome", "latencyMs", "deadlineMs", "fitted", "routes", "callIds"),
	"worker.channel_failed": keep("lane", "frameType", "errno", "afterExit", "failure"),
	"hook.ran": keep(
		"hookId",
		"origin",
		"sourceId",
		"hash",
		"hook",
		"kind",
		"outcome",
		"effectKinds",
		"durationMs",
		"exitCode",
		"outputChars",
		"tool",
		"extension",
	),
	"library.installed": LIBRARY,
	"library.updated": LIBRARY,
	"library.enabled": LIBRARY,
	"library.disabled": LIBRARY,
	"library.removed": LIBRARY,
	"library.registered": LIBRARY,
	"library.imported": LIBRARY,
	"library.share_imported": LIBRARY,
	"session.parked": keep("reason"),
	"domain.loaded": keep("name"),
	"domain.failed": keep("name"),
	"config.reload_failed": keep("state"),
	"middleware.hook_failed": keep(
		"kind",
		"registrationId",
		"hook",
		"elapsedMs",
		"budgetMs",
		"steadyStateWarn",
		"p50Ms",
		"p95Ms",
		"overCount",
		"windowSamples",
	),
	"plugin.reloaded": keep("generation", "previousGeneration", "changed", "digest"),
	"extension.load_failed": {},
	"context.warning_raised": keep("state"),
	"context.pruned": keep(
		"stage",
		"tokensBefore",
		"tokensAfter",
		"trigger",
		"snapshotIdBefore",
		"snapshotIdAfter",
		"at",
		"pressure",
		"maskedObservations",
		"maskedThinkingBlocks",
		"maskedThinkingChars",
		"policyId",
		"evictedItems",
	),
	"context.recalled": keep("ref", "trigger", "tokensReadmitted", "at"),
	// An endpoint key is the provider URL, which can name a private host.
	"memory.step_completed": { endpointKey: "endpoint", targetId: "keep" },
	"memory.step_decided": keep(
		"triggerReasons",
		"tier",
		"bankDelta",
		"decision",
		"reason",
		"bankOperations",
		"droppedOperations",
		"citedEntries",
		"inputTokens",
		"outputTokens",
		"latencyMs",
		"missingTokenCalls",
		"calls",
		"route",
		"resumeAt",
	),
	"memory.observation_recorded": {
		event: "keep",
		facts: {
			...keep(
				"revision",
				"priorObservationRevision",
				"batchId",
				"digest",
				"sourceDigest",
				"sourceSessionId",
				"commitId",
				"phase",
				"id",
				"by",
				"filing",
				"final",
				"answered",
				"unavailable",
				"split",
				"ids",
				"retainedIds",
				"count",
				"grounded",
				"ungrounded",
				"rejected",
				"offered",
				"offerable",
				"units",
				"incompleteUnits",
				"attempts",
				"timeoutMs",
				"operations",
				"dropped",
				"extracted",
				"candidates",
				"accepted",
				"entries",
				"splitEntries",
				"sourceTokens",
				"noteTokens",
				"originalInputTokens",
				"substitutedInputTokens",
				"proposed",
				"raw",
				"durationMs",
				"route",
				"outcomes",
				"offerId",
				"batchIds",
				"inputIds",
				"offerIds",
				"usage",
				"call",
				"decision",
				"proven",
				"window",
			),
			reason: "withhold",
		},
	},
	"memory.guardian_changed": keep("state"),
	"shutdown.requested": keep("phase"),
	"shutdown.drained": {},
	"shutdown.terminated": {},
	"shutdown.persisted": {},
};

/**
 * The structural objects a `structural` share carries, field by field. A project preload names the handbook files it
 * read by absolute path, and a fragment by its path, so both become anonymous ids; a preload's label and a tool's
 * description are prose. Settings hold whatever an operator typed (paths, hosts, URLs, names), so every string in
 * them becomes an anonymous id and only their shape, switches and numbers stay readable.
 */
export const SHARE_OBJECT_PROJECTIONS: Readonly<Record<string, FieldProjection>> = {
	"prompt-structure": {
		sections: keep("id", "tokenEstimate", "contentHash"),
		fragments: { ...keep("id", "contentHash", "dynamic"), relPath: "path" },
		compile: {
			...keep(
				"version",
				"at",
				"previousHash",
				"systemPromptHash",
				"tokenEstimate",
				"thinkingLevel",
				"contextWindow",
				"contextWindowSource",
			),
			projectPreload: {
				...keep(
					"mode",
					"chars",
					"lines",
					"reason",
					"nearLimit",
					"includedChars",
					"includedLines",
					"omittedSupportFragments",
					"providerSupportsTools",
				),
				label: "withhold",
				sources: {
					...keep(
						"contentHash",
						"availableChars",
						"availableLines",
						"includedChars",
						"includedLines",
						"includedRange",
						"omittedRange",
						"omissionReason",
					),
					path: "path",
				},
			},
		},
	},
	"tool-schemas": { name: "keep", description: "drop", parameters: "json-schema" },
	config: "config",
};

export type Anonymize = (kind: AnonKind, value: string) => string;

/** Verification has no key: an anonymous id conforms by its shape, anything else does not. */
export const conformingAnonymous: Anonymize = (_kind, value) => (ANONYMOUS_ID.test(value) ? value : "[nonconforming]");

const DROP = Symbol("drop");

function mapStrings(value: unknown, map: (text: string) => string): unknown {
	if (typeof value === "string") return map(value);
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]));
	return value;
}

/** Keywords that say what shape a tool's arguments take; descriptions, titles, examples and defaults are prose. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
	"type",
	"enum",
	"const",
	"format",
	"pattern",
	"required",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
]);
const SCHEMA_CHILDREN: ReadonlySet<string> = new Set(["items", "additionalProperties", "not", "contains"]);
const SCHEMA_LISTS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

function projectJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(projectJsonSchema);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (SCHEMA_KEYWORDS.has(key) || SCHEMA_CHILDREN.has(key) || SCHEMA_LISTS.has(key))
			out[key] = SCHEMA_KEYWORDS.has(key) ? item : projectJsonSchema(item);
		else if (key === "properties" && item !== null && typeof item === "object" && !Array.isArray(item))
			out[key] = Object.fromEntries(Object.entries(item).map(([name, child]) => [name, projectJsonSchema(child)]));
	}
	return out;
}

function projectField(value: unknown, projection: FieldProjection, anonymize: Anonymize): unknown {
	if (projection === "keep") return value;
	if (projection === "drop") return DROP;
	if (projection === "withhold") return mapStrings(value, () => WITHHELD);
	if (projection === "json-schema") return projectJsonSchema(value);
	if (typeof projection === "string") return mapStrings(value, (text) => anonymize(projection, text));
	if (Array.isArray(value)) return value.map((item) => projectField(item, projection, anonymize));
	if (typeof value === "string") return WITHHELD;
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!Object.hasOwn(projection, key)) continue;
		const projected = projectField(item, projection[key] as FieldProjection, anonymize);
		if (projected !== DROP) out[key] = projected;
	}
	return out;
}

/** A shareable record's payload as a share below research carries it; null for an event the table does not admit. */
export function projectSharedPayload(kind: string, data: unknown, anonymize: Anonymize): unknown | null {
	if (!Object.hasOwn(SHARE_EVENT_PROJECTIONS, kind)) return null;
	return projectField(data, SHARE_EVENT_PROJECTIONS[kind as ShareableEventName], anonymize);
}

/** A structural object as a share below research carries it; null for a subject the table does not admit. */
export function projectSharedObject(subject: string, value: unknown, anonymize: Anonymize): unknown | null {
	if (!Object.hasOwn(SHARE_OBJECT_PROJECTIONS, subject)) return null;
	return projectField(value, SHARE_OBJECT_PROJECTIONS[subject] as FieldProjection, anonymize);
}

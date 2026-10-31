import { SETTINGS_FIELD_NAMES } from "../../core/settings-fields.js";
import type { EVENTS, JournalEventName, JournalPayload } from "../../core/telemetry/events.js";

/**
 * What a share below the research profile keeps of each record and structural object (#434). Removing known-bad
 * fields one at a time kept missing the next one, so this is an allowlist: every field of every shareable event's
 * payload is classified here, a field or nested key the table does not name is dropped, free text of any kind is
 * withheld, and identities and paths become anonymous ids keyed by the source installation. A shared record or object
 * must be a fixed point of its projection, which is what `telemetry verify` and `telemetry import` check.
 */

/** Identities a share replaces with an anonymous id: stable for one installation, unrecoverable without its key. */
export type AnonKind = "host" | "user" | "path" | "endpoint" | "config" | "model" | "literal";
/**
 * `keep`: the subtree is structural (ids, vocabularies, numbers, hashes, facts). `withhold`: every string in it is
 * free text and becomes {@link WITHHELD}. `drop`: the optional field is left out. An {@link AnonKind}: every string in
 * it becomes an anonymous id. `model-id`: a model or target identity stays readable unless it carries a path
 * ({@link carriesPath}), which becomes a `model` anonymous id. `json-schema`: a tool's parameter schema keeps its
 * structural keywords and anonymizes its literals. `settings`: a settings document keeps its fixed field names and
 * anonymizes every string value and dictionary key. `settings-path`: a dotted settings key path does the same per
 * segment. An object applies field by field, and to each element of an array.
 */
export type FieldProjection =
	| "keep"
	| "withhold"
	| "drop"
	| "model-id"
	| "json-schema"
	| "settings"
	| "settings-path"
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

/**
 * Model and target identities, wherever a record names them: a local server can report a model file's path as its id
 * and discovery accepts provider-returned ids verbatim, so these go through `model-id` rather than `keep`, and one
 * path anonymizes to the same id in a call's target, a settled route and a route decision (#434).
 */
const TARGET = {
	targetId: "model-id",
	runtimeId: "keep",
	api: "keep",
	requestedModel: "model-id",
	reportedModel: "model-id",
} as const satisfies FieldProjection;
const ROUTE_TUPLE = {
	...keep("agentId", "executionRole", "runtimeId", "nodeId"),
	targetId: "model-id",
	modelId: "model-id",
} as const satisfies FieldProjection;
const MEMORY_ROUTE = { targetId: "model-id", modelId: "model-id" } as const satisfies FieldProjection;
const CALL = { ...keep("objects", "callId", "attemptId", "attempt", "roundKind", "toolChoice"), target: TARGET };
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
	"call.started": CALL,
	"call.settled": {
		...CALL,
		...keep(
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
			"node",
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
		route: { ...keep("runtimeId", "runtimeKind"), targetId: "model-id", wireModelId: "model-id" },
		routeDecision: {
			...keep("decisionHash", "mode", "durationMs", "constraintsValid"),
			executed: {
				...keep(
					"agentId",
					"specFingerprint",
					"executionRole",
					"runtimeId",
					"nodeId",
					"thinkingLevel",
					"toolSignature",
					"promptCompositionHash",
					"endpointIdentityHash",
					"settingsFingerprint",
				),
				targetId: "model-id",
				modelId: "model-id",
			},
		},
		// What a run said about itself, its budget wording and its validation claims are the worker's own prose.
		outcomeDetail: "withhold",
		failureMessage: "withhold",
		budget: "withhold",
		upstream: { responseModelIds: "model-id", gatewayRoutes: "withhold" },
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
	"run.usage_reported": {
		...keep(
			"source",
			"scope",
			"partId",
			"revision",
			"coverage",
			"pricingCoverage",
			"callCountCoverage",
			"usage",
			"totalTokens",
			"apiCalls",
			"missingTokenCalls",
			"pricing",
		),
		target: TARGET,
	},
	"run.linked": keep("runId"),
	"run.enqueued": {
		...keep(
			"runId",
			"agentId",
			"requestOrigin",
			"runtimeId",
			"runtimeKind",
			"node",
			"endpointLimit",
			"gate",
			"rerouteCount",
		),
		targetId: "model-id",
		wireModelId: "model-id",
	},
	"run.started": keep("pid", "assignmentId", "attempt"),
	"route.decided": {
		...keep(
			"policyVersion",
			"mode",
			"posture",
			"decisionHash",
			"decisionDurationMs",
			"confidence",
			"recommendedAgentId",
			"reasons",
			"verdict",
		),
		selected: ROUTE_TUPLE,
		executed: ROUTE_TUPLE,
		fallbacks: ROUTE_TUPLE,
		candidates: { ...keep("rejection", "score", "dominated", "samples", "ready"), route: ROUTE_TUPLE },
	},
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
	"prewarm.decided": {
		...keep("round", "trigger", "ran", "reason", "detail", "durationMs"),
		targetId: "model-id",
		model: "model-id",
	},
	"prewarm.settled": {
		...keep("round", "trigger", "ttftMs", "apiMs", "promptTokens", "aborted", "detached", "failed"),
		targetId: "model-id",
		model: "model-id",
	},
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
		targetId: "model-id",
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
	// A path's dictionary segments, such as a model id under targets[].lmstudio.models, are the operator's own keys.
	"config.changed": {
		...keep("source", "scope", "before", "after", "settingsFingerprint"),
		paths: "settings-path",
	},
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
	"safety.judged": {
		...keep(
			"tool",
			"actionClass",
			"verdict",
			"latencyMs",
			"workerRunId",
			"askRule",
			"rule",
			"noVerdict",
			"operatorMessages",
		),
		target: "model-id",
		model: "model-id",
	},
	"prompt.compiled": keep(
		"structure",
		"layoutVersion",
		"tokenEstimate",
		"sections",
		"thinkingLevel",
		"contextWindow",
		"contextWindowSource",
	),
	"context.snapshotted": {
		...keep(
			"snapshotId",
			"providerId",
			"runtimeId",
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
		modelId: "model-id",
	},
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
	"memory.step_completed": { endpointKey: "endpoint", targetId: "model-id" },
	"memory.step_decided": {
		...keep(
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
			"resumeAt",
		),
		route: MEMORY_ROUTE,
	},
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
			route: MEMORY_ROUTE,
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
 * them becomes an anonymous id, and so does every dictionary key they hold, such as a model id under
 * `targets[].lmstudio.models`; only their fixed field names, switches and numbers stay readable.
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
	config: "settings",
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

/** Like {@link mapStrings}, and an object's keys are mapped too unless `fixedKey` names them. */
function mapStringsAndKeys(value: unknown, map: (text: string) => string, fixedKey: (key: string) => boolean): unknown {
	if (typeof value === "string") return map(value);
	if (Array.isArray(value)) return value.map((item) => mapStringsAndKeys(item, map, fixedKey));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [fixedKey(key) ? key : map(key), mapStringsAndKeys(item, map, fixedKey)]),
		);
	return value;
}

const MODEL_FILE =
	/\.(?:gguf|ggml|bin|safetensors|pt|pth|ckpt|onnx|tflite|mlmodel|mlpackage|llamafile|h5|npz|pkl|engine)$/iu;
const HOME_ROOTS: ReadonlySet<string> = new Set(["home", "Users"]);

/**
 * Whether a model or target identity names a location rather than a provider's model: an absolute, home-relative,
 * drive or backslash path, any URL, a path that starts after a separator such as `lmstudio:/home/...`, a `.`, `..`,
 * `~` or empty segment, a home directory root before another segment, or a separator before a model file's name.
 * `qwen/qwen3-coder`, `openrouter/anthropic/x` and `qwen3:8b` stay readable; `org/repo/model-q4.gguf` does not.
 */
function carriesPath(value: string): boolean {
	if (/^(?:[\\/~]|[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/\/|file:)/iu.test(value)) return true;
	if (value.includes("\\") || /[^A-Za-z0-9._-][\\/]/u.test(value)) return true;
	const segments = value.split("/");
	if (segments.length < 2) return false;
	if (
		segments.some(
			(segment, index) =>
				["", ".", "..", "~"].includes(segment) || (HOME_ROOTS.has(segment) && index < segments.length - 1),
		)
	)
		return true;
	return MODEL_FILE.test(segments[segments.length - 1] ?? "");
}

const SETTINGS_FIELDS: ReadonlySet<string> = new Set(SETTINGS_FIELD_NAMES);
const isSettingsField = (key: string) => SETTINGS_FIELDS.has(key);

/** A dotted settings key path, as config.changed names a change: fixed names and list indices stay. */
function projectSettingsPath(path: string, anonymize: Anonymize): string {
	if (path === "(root)") return path;
	return path
		.split(".")
		.map((segment) => (isSettingsField(segment) || /^\d+$/u.test(segment) ? segment : anonymize("config", segment)))
		.join(".");
}

/**
 * A tool schema's literal values (enum members, const values, patterns, formats, bounds) are whatever its author wrote,
 * paths and prose included: numbers, booleans and null stay, every string and every key of a literal object becomes a
 * `literal` anonymous id. Only keywords whose values are schema structure keep them (#434).
 */
const SCHEMA_LITERALS: ReadonlySet<string> = new Set([
	"enum",
	"const",
	"format",
	"pattern",
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
const JSON_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const SCHEMA_CHILDREN: ReadonlySet<string> = new Set(["items", "additionalProperties", "not", "contains"]);
const SCHEMA_LISTS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/**
 * A tool's parameter schema keeps its shape: `type` in the JSON type vocabulary, child schemas, property names and
 * the `required` entries that name one of them. Descriptions, titles, examples and defaults are dropped and every
 * other literal is anonymized.
 */
function projectJsonSchema(value: unknown, anonymize: Anonymize): unknown {
	if (Array.isArray(value)) return value.map((item) => projectJsonSchema(item, anonymize));
	if (value === null || typeof value !== "object") return value;
	const literal = (text: string) => anonymize("literal", text);
	const schema = value as Record<string, unknown>;
	const properties =
		schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: undefined;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(schema)) {
		if (key === "type")
			out[key] = mapStringsAndKeys(
				item,
				(text) => (JSON_TYPES.has(text) ? text : literal(text)),
				() => false,
			);
		else if (SCHEMA_LITERALS.has(key)) out[key] = mapStringsAndKeys(item, literal, () => false);
		else if (SCHEMA_CHILDREN.has(key) || SCHEMA_LISTS.has(key)) out[key] = projectJsonSchema(item, anonymize);
		else if (key === "properties" && properties)
			out[key] = Object.fromEntries(
				Object.entries(properties).map(([name, child]) => [name, projectJsonSchema(child, anonymize)]),
			);
		else if (key === "required" && Array.isArray(item))
			out[key] = item.filter(
				(name) => typeof name === "string" && properties !== undefined && Object.hasOwn(properties, name),
			);
	}
	return out;
}

function projectField(value: unknown, projection: FieldProjection, anonymize: Anonymize): unknown {
	if (projection === "keep") return value;
	if (projection === "drop") return DROP;
	if (projection === "withhold") return mapStrings(value, () => WITHHELD);
	if (projection === "model-id")
		return mapStrings(value, (text) => (carriesPath(text) ? anonymize("model", text) : text));
	if (projection === "json-schema") return projectJsonSchema(value, anonymize);
	if (projection === "settings") return mapStringsAndKeys(value, (text) => anonymize("config", text), isSettingsField);
	if (projection === "settings-path") return mapStrings(value, (text) => projectSettingsPath(text, anonymize));
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

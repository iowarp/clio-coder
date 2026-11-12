import { SETTINGS_FIELD_NAMES } from "../../core/settings-fields.js";
import type { EVENTS, JournalEventName, JournalPayload } from "../../core/telemetry/events.js";
import { ToolNames } from "../../core/tool-names.js";
import { BUILTIN_RUNTIME_BOOT_MANIFEST } from "../providers/runtimes/boot-manifest.js";

/**
 * What a share below the research profile keeps of each record and structural object (#434). Removing known-bad
 * fields one at a time kept missing the next one, so this is an allowlist: every field of every shareable event's
 * payload is classified here, a field or nested key the table does not name is dropped, free text of any kind is
 * withheld, and identities and paths become anonymous ids keyed by the source installation. A shared record or object
 * must be a fixed point of its projection, which is what `telemetry verify` and `telemetry import` check. `keep` is
 * sound only over a closed schema: share-soundness.ts walks every journal schema against this table and the boundary
 * check fails on any string under `keep` that is not a vocabulary, a literal or a pattern-constrained id.
 */

/** Identities a share replaces with an anonymous id: stable for one installation, unrecoverable without its key. */
export type AnonKind = "host" | "user" | "path" | "endpoint" | "config" | "model" | "literal" | "id" | "name";
/**
 * `keep`: the subtree is structural (ids, vocabularies, numbers, hashes, facts). `withhold`: every string in it is
 * free text and becomes {@link WITHHELD}. `drop`: the optional field is left out. An {@link AnonKind}: every string in
 * it becomes an anonymous id. `model-id`: a model or target identity stays readable unless it carries a path
 * ({@link carriesPath}), which becomes a `model` anonymous id. `json-schema`: a tool's parameter schema keeps its
 * structural keywords and anonymizes its literals. `settings`: a settings document keeps its fixed field names and
 * anonymizes every string value and dictionary key. `settings-path`: a dotted settings key path does the same per
 * segment. An object applies field by field, and to each element of an array.
 *
 * Where a schema admits any string, the projection decides what leaves (#434). `id`: an id or digest the harness
 * mints keeps its shape ({@link MINTED_ID}), anything else becomes an `id` anonymous id. `token`: a harness vocabulary
 * the schema leaves open stays when it is identifier shaped ({@link TOKEN}), anything else becomes a `name` anonymous
 * id. `tool` and `runtime`: a built-in tool or runtime stays, an operator's own (an MCP tool, a plugin runtime) becomes
 * a `name` anonymous id. `name`: an identity an operator chooses (an agent, a rule, a hook, a flow recipient) is always
 * anonymous. `token-keys`: a dictionary whose keys are `token`s and whose values are closed. `evidence`: a
 * `matcher:subject@scope` match description that a built-in rule records stays; another keeps a built-in matcher and
 * scope around an anonymous subject, so it still matches the field's pattern, and anything else is dropped.
 */
export type FieldProjection =
	| "keep"
	| "withhold"
	| "drop"
	| "model-id"
	| "json-schema"
	| "settings"
	| "settings-path"
	| "id"
	| "token"
	| "tool"
	| "runtime"
	| "token-keys"
	| "evidence"
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
	runtimeId: "runtime",
	api: "token",
	requestedModel: "model-id",
	reportedModel: { ...keep("kind", "source", "method", "reason"), value: "model-id" },
} as const satisfies FieldProjection;
const ROUTE_TUPLE = {
	executionRole: "keep",
	agentId: "name",
	runtimeId: "runtime",
	nodeId: "host",
	targetId: "model-id",
	modelId: "model-id",
} as const satisfies FieldProjection;
const MEMORY_ROUTE = { targetId: "model-id", modelId: "model-id" } as const satisfies FieldProjection;
/** A fact keeps its kind and provenance; its value is projected as `value` says. */
const fact = (value: FieldProjection) => ({ ...keep("kind", "source", "method", "reason"), value }) as const;
// A tool choice is a mode or a tool's name: `tool` keeps the modes with the built-in tools.
const CALL = {
	...keep("objects", "attempt", "roundKind"),
	callId: "id",
	attemptId: "id",
	toolChoice: "tool",
	target: TARGET,
} as const satisfies FieldProjection;
const QUOTA_WINDOW = {
	...keep("usedPct", "resetsAt"),
	key: "token",
	scope: "token",
	label: "withhold",
} as const satisfies FieldProjection;
const SEAL = keep("head", "records", "segments", "objects");
const LIBRARY = {
	...keep("sourceId", "actor"),
	operationId: "id",
	kind: "token",
	id: "name",
	version: "token",
	contentDigest: "id",
	envelopeDigest: "id",
	scope: "token",
} as const satisfies FieldProjection;
/** One trust axis: who attested it is an identity; the run, seal and artifacts it names are ids. */
const TRUST_AXIS = {
	...keep("state", "reason"),
	source: { kind: "keep", id: "id" },
	authority: { kind: "keep", id: "name" },
	artifacts: { kind: "keep", id: "id", digest: "keep" },
} as const satisfies FieldProjection;

/** Every shareable event's payload, field by field; the type requires each field to be classified. */
export const SHARE_EVENT_PROJECTIONS: { readonly [N in ShareableEventName]: PayloadProjection<JournalPayload<N>> } = {
	"call.started": CALL,
	"call.settled": {
		...CALL,
		...keep("disposition", "usage", "pricing", "stages", "transport", "interruptedEstimate", "billing"),
		responseId: "id",
		cache: {
			...keep("expectedColdReasons", "rePrefilledTokens", "uncachedPrefillTokens", "verdict", "bill"),
			// Digests of the request's text: a short message could be guessed from its digest.
			structure: "drop",
			firstDivergentSection: fact("token"),
		},
		quota: { ...keep("source"), provider: "runtime", windows: QUOTA_WINDOW },
		stop: { reason: "keep", failure: "keep", detail: "withhold" },
	},
	"call.linked": { runId: "id", callId: "id" },
	"compaction.settled": { ...keep("outcome"), callIds: "id", checkpointTurnId: "id" },
	"journal.gap": { ...keep("reason", "count"), sink: "token" },
	"session.opened": {},
	"session.resumed": keep("via"),
	"session.forked": { parentSessionId: "id", parentCwdHash: "id", parentTurnId: "id", parentTurnAt: "id" },
	"session.closed": keep("reason"),
	"journal.segment_closed": keep("reason"),
	"turn.settled": keep("stopReason", "terminal"),
	"run.settled": {
		...keep(
			"version",
			"executionRole",
			"requestOrigin",
			"attempt",
			"phaseTiming",
			"startedAt",
			"endedAt",
			"outcome",
			"outcomeCode",
			"exitCode",
			"terminalReason",
			"processExitCode",
			"boundKind",
			"repairRounds",
			"usage",
			"totalTokens",
			"apiCalls",
			"pricing",
			"toolCalls",
			"toolActivity",
			"escalations",
			"toolGovernance",
			"verification",
			"worktree",
			"hostVerification",
			"contextProvenance",
			"result",
		),
		agentId: "name",
		callIds: "id",
		frameType: "token",
		identity: { host: "host", user: "user" },
		node: { id: "host", kind: "keep" },
		route: { runtimeKind: "keep", runtimeId: "runtime", targetId: "model-id", wireModelId: "model-id" },
		routeDecision: {
			...keep("mode", "durationMs", "constraintsValid"),
			decisionHash: "id",
			executed: {
				...ROUTE_TUPLE,
				specFingerprint: "id",
				thinkingLevel: "token",
				toolSignature: "id",
				promptCompositionHash: "id",
				endpointIdentityHash: "id",
				settingsFingerprint: "id",
			},
		},
		routingIntent: {
			...keep("posture", "maxCostUsd", "deadlineMs", "minimumQuality", "locality", "failover"),
			requiredCapabilities: "token",
		},
		tools: { ...keep("calls", "ok", "errors", "blocked"), tool: "tool" },
		skills: { requestSource: "keep", name: "name" },
		capabilityMismatch: { agentId: "name", suggestedAgentId: "name", capabilityClass: "token", taskType: "token" },
		context: { ...keep("briefingBytes", "worker"), project: { ...keep("tier", "chars"), sections: "token" } },
		blockedAttempts: { tool: "tool", actionClass: "token", ruleId: "name", reasonCode: "token" },
		hashes: { ...keep("label", "function", "canonicalization", "subject", "store"), field: "token", hash: "id" },
		// What a run said about itself, its budget wording and its validation claims are the worker's own prose.
		outcomeDetail: "withhold",
		failureMessage: "withhold",
		budget: "withhold",
		upstream: { responseModelIds: "model-id", gatewayRoutes: "withhold" },
		// A recipient is an expanded identity: an endpoint URL, or an MCP server's command, arguments, working
		// directory and environment. Each one is anonymized whole, so restrictions still compare without them (#434).
		flowRestrictions: {
			version: "keep",
			restrictions: { ruleId: "name", policyHash: "id", sourceRef: "path", recipients: "name" },
			advisory: "withhold",
		},
		quality: {
			typedValidations: { sourceId: "path", validatorDigest: "id", passed: "keep" },
			responseSchema: { sourceId: "path", schemaDigest: "id", runtimeEnforceable: "keep", enforcementPassed: "keep" },
			resultContract: { sourceId: "path", validatorDigest: "id", conformance: "keep", quality: "keep" },
		},
		validationGrounding: { claimed: "keep", grounded: "keep", ungrounded: "withhold", basis: "keep" },
	},
	"run.feed_appended": {
		seq: "keep",
		body: {
			...keep("kind", "type", "outcome", "durationMs", "reason", "droppedFromSeq", "exitCode"),
			runId: "id",
			agentId: "name",
			tool: "tool",
			callId: "id",
			attemptRunId: "id",
		},
	},
	"run.usage_reported": {
		...keep("source", "scope", "revision", "coverage", "usage", "totalTokens", "apiCalls", "unmeteredCalls", "pricing"),
		partId: "id",
		target: TARGET,
	},
	"run.linked": { runId: "id" },
	"run.enqueued": {
		...keep("requestOrigin", "runtimeKind", "endpointLimit", "rerouteCount"),
		runId: "id",
		agentId: "name",
		runtimeId: "runtime",
		node: "host",
		gate: { role: "token", cycle: "keep" },
		targetId: "model-id",
		wireModelId: "model-id",
	},
	"run.started": { ...keep("pid", "attempt"), assignmentId: "id" },
	"route.decided": {
		...keep("mode", "posture", "decisionDurationMs", "confidence", "reasons", "verdict"),
		policyVersion: "token",
		decisionHash: "id",
		recommendedAgentId: "name",
		selected: ROUTE_TUPLE,
		executed: ROUTE_TUPLE,
		fallbacks: ROUTE_TUPLE,
		candidates: { ...keep("rejection", "score", "dominated", "samples", "ready"), route: ROUTE_TUPLE },
	},
	"gate.decided": {
		...keep("topology", "cycle", "outcome", "independent", "digest"),
		decisionId: "id",
		group: "id",
		confirms: "id",
		subjects: { runId: "id", digest: "keep" },
		decider: { runId: "id", digest: "keep" },
		winner: { index: "keep", runId: "id" },
	},
	"code_step.settled": {
		...keep(
			"startedAt",
			"durationMs",
			"timeoutMs",
			"exitCode",
			"timedOut",
			"commands",
			"outputBytes",
			"outputTruncated",
			"outputDigest",
			"reportDigest",
		),
		runId: "id",
		stepId: "token",
		commandId: "token",
		signal: "token",
	},
	"process.started": {},
	"process.exited": keep("exitCode"),
	"process.booted": {
		...keep("surface", "totalMs", "interactivity"),
		node: "token",
		platform: "token",
		phases: { name: "token", atMs: "keep" },
	},
	"prewarm.decided": {
		...keep("round", "ran", "durationMs"),
		trigger: "token",
		reason: "token",
		detail: "withhold",
		targetId: "model-id",
		model: "model-id",
	},
	"prewarm.settled": {
		...keep("round", "ttftMs", "apiMs", "promptTokens", "aborted", "detached", "failed"),
		trigger: "token",
		targetId: "model-id",
		model: "model-id",
	},
	// Trust axes, finding tags and verdicts are vocabularies and ids; the finding prose is the referenced object (#434).
	"evidence.assessed": {
		...keep("version", "attempt", "firstPassSuccess", "failureCause", "findings", "text"),
		trust: {
			version: "keep",
			artifactIntegrity: TRUST_AXIS,
			validationGrounding: TRUST_AXIS,
			independentReview: TRUST_AXIS,
			contextProvenance: TRUST_AXIS,
			completionEvidence: TRUST_AXIS,
		},
		verdicts: { ...keep("digest", "review"), decisionId: "id", outcome: "token" },
		provenance: {
			decisionRefs: { ref: "id", resolved: "keep" },
			pipeline: { ...keep("position", "inputBytes", "inputTruncated"), fromRunId: "id" },
			personaOverride: { promptHash: "id" },
		},
	},
	"old_telemetry.removed": keep("files", "directories", "rewritten", "skipped", "failed"),
	"run.sealed": SEAL,
	"session.sealed": SEAL,
	"process.sealed": SEAL,
	"share.sealed": { ...SEAL, profile: "keep" },
	"quota.read": {
		...keep("source", "observedAt", "status", "retryAfterSeconds", "stale", "limitReached"),
		provider: "runtime",
		windows: QUOTA_WINDOW,
		displayName: "withhold",
		plan: "token",
		credits: { display: "withhold", usedPct: "keep" },
		targetId: "model-id",
		message: "withhold",
		// Already an opaque digest whose pattern an anonymous id cannot satisfy; the field is optional, so it goes.
		account: "drop",
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
	"tool.settled": {
		...keep("outcome", "durationMs", "parkedMs", "resultBytes", "images", "terminate", "blocked", "fileExt", "checkKind"),
		tool: "tool",
		skill: "name",
		capabilities: "tool",
	},
	// A rule and the policy source it came from are the operator's own names.
	"tool.decided": {
		...keep("decision", "exposure"),
		tool: "tool",
		actionClass: "token",
		posture: "token",
		requestId: "id",
		ruleId: "name",
		reasonCode: "token",
		policySource: "name",
		policyHash: "id",
		confirmationRuleId: "name",
	},
	"approval.requested": {
		...keep("timeoutMs", "fallback", "escalation", "approvalAuthority", "forwardedByMain", "reviewer"),
		tool: "tool",
		actionClass: "token",
		requestId: "id",
		origin: "token",
		requestedBy: "name",
		agentId: "name",
		axis: "token",
		posture: "token",
		ruleId: "name",
		reasonCode: "token",
		policySource: "name",
	},
	"approval.resolved": {
		...keep("status", "fallback"),
		requestId: "id",
		origin: "token",
		decidedBy: "token",
		tool: "tool",
		actionClass: "token",
		requestedBy: "name",
		grant: { ...keep("attempt", "authority", "issuer", "execution"), state: "token" },
	},
	"run.aborted": { ...keep("source", "elapsedMs"), runId: "id", startedAt: "id" },
	"turn.aborted": keep("source"),
	// The open decision's command is live only; a judge rule or ask rule id is the harness's or the operator's name.
	"autonomy.entered": keep("confinement", "capToolCalls", "capMinutes", "capTokens"),
	"autonomy.open_decision": { ...keep("kind", "seq"), tool: "tool", rule: "name" },
	"autonomy.cap_reached": keep("kind", "limit", "toolCalls", "activeMs", "tokens", "openDecisions"),
	"autonomy.resumed": keep("cleared"),
	"autonomy.ended": keep("reason", "toolCalls", "activeMs", "tokens", "openDecisions"),
	"job.clock_resumed": { ...keep("boundMs"), jobId: "id" },
	"turn.continued": { ...keep("cause", "attempt", "cap"), jobId: "id" },
	"agent.status_changed": {
		...keep("phase", "prevPhase", "elapsedFromStart", "watchdogTier", "attempt"),
		toolName: "tool",
		agentName: "name",
		stopReason: "token",
	},
	// A check is named by whoever configured verification; the rules and evidence kinds are the harness's.
	"completion.evaluated": {
		...keep("decision", "reason", "rigor", "mutatedPaths"),
		evidenceKinds: "token",
		quality: { rule: "token", check: "name", state: "keep" },
		verification: { passedChecks: "name", acceptance: { check: "name", state: "keep" } },
	},
	"safety.judged": {
		...keep("verdict", "latencyMs", "operatorMessages", "toolDescriptionChars", "screened", "unnamedEscape"),
		tool: "tool",
		actionClass: "token",
		workerRunId: "id",
		askRule: "name",
		rule: "name",
		noVerdict: "token",
		target: "model-id",
		model: "model-id",
	},
	"prompt.compiled": {
		...keep("structure", "layoutVersion", "tokenEstimate", "sections", "contextWindow"),
		thinkingLevel: "token",
		contextWindowSource: "token",
	},
	"context.snapshotted": {
		...keep(
			"messageRange",
			"divergenceRatio",
			"categories",
			"source",
			"estimatedTokens",
			"reconciledTokens",
			"promptHash",
		),
		snapshotId: "id",
		providerId: "runtime",
		runtimeId: "runtime",
		promptSegments: { id: "token", tokenEstimate: "keep" },
		splits: "token-keys",
		toolSignature: "id",
		window: { ...keep("desired", "effective"), source: "token" },
		modelId: "model-id",
	},
	"auth.refreshed": {
		...keep("trigger", "attempted", "outcome", "writerPid", "updatedAtBefore", "updatedAtAfter", "durationMs"),
		provider: "runtime",
	},
	"message.stepped": {
		...keep("step", "submittedAt", "by", "chars", "lane", "changedBy", "why", "slot", "reason", "attempt"),
		messageId: "id",
		callId: "id",
		attemptId: "id",
	},
	"middleware.fired": {
		...keep("hook", "phase", "effects", "severity"),
		ruleId: "name",
		evidence: "evidence",
		tool: "tool",
	},
	"system_one.decided": {
		...keep("outcome", "latencyMs", "deadlineMs", "asked", "abstained", "callIds"),
		point: "token",
		set: "token",
		ref: "id",
		askId: "id",
		engineKind: "token",
		profile: "token",
		build: "token",
		readout: "token",
		tokens: keep("input", "output"),
		routes: { ...keep("outcome", "roundTripMs", "breaker"), engine: "token", kind: "token", profile: "token" },
	},
	"worker.channel_failed": { ...keep("lane", "errno", "afterExit", "failure"), frameType: "token" },
	"hook.ran": {
		...keep("origin", "sourceId", "hook", "kind", "outcome", "durationMs", "exitCode", "outputChars"),
		hookId: "name",
		hash: "id",
		effectKinds: "token",
		tool: "tool",
		extension: { id: "name", version: "token", scope: "token", contentDigest: "id", generation: "keep" },
	},
	"library.installed": LIBRARY,
	"library.updated": LIBRARY,
	"library.enabled": LIBRARY,
	"library.disabled": LIBRARY,
	"library.removed": LIBRARY,
	"library.registered": LIBRARY,
	"library.imported": LIBRARY,
	"library.share_imported": LIBRARY,
	"session.parked": keep("reason"),
	"domain.loaded": { name: "token" },
	"domain.failed": { name: "token" },
	"config.reload_failed": keep("state"),
	"middleware.hook_failed": {
		...keep("kind", "hook", "elapsedMs", "budgetMs", "steadyStateWarn", "p50Ms", "p95Ms", "overCount", "windowSamples"),
		registrationId: "name",
	},
	"plugin.reloaded": { ...keep("generation", "previousGeneration", "changed"), digest: "id" },
	"extension.load_failed": {},
	"context.warning_raised": keep("state"),
	"context.pruned": {
		...keep(
			"stage",
			"tokensBefore",
			"tokensAfter",
			"trigger",
			"at",
			"pressure",
			"maskedObservations",
			"maskedThinkingBlocks",
			"maskedThinkingChars",
			"evictedItems",
		),
		snapshotIdBefore: "id",
		snapshotIdAfter: "id",
		policyId: "token",
	},
	"context.recalled": { ...keep("trigger", "tokensReadmitted", "at"), ref: "id" },
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
			"unmeteredCalls",
			"calls",
			"resumeAt",
		),
		route: MEMORY_ROUTE,
	},
	"memory.observation_recorded": {
		event: "keep",
		facts: {
			...keep(
				"final",
				"answered",
				"unavailable",
				"split",
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
				"usage",
				"call",
				"decision",
				"proven",
				"window",
			),
			revision: "id",
			priorObservationRevision: "id",
			batchId: "id",
			digest: "id",
			sourceDigest: "id",
			sourceSessionId: "id",
			commitId: "id",
			id: "id",
			ids: "id",
			retainedIds: "id",
			offerId: "id",
			batchIds: "id",
			inputIds: "id",
			offerIds: "id",
			outcomes: { kind: "keep", ids: "id" },
			phase: "token",
			by: "token",
			filing: "token",
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
		sections: { ...keep("tokenEstimate", "contentHash"), id: "token" },
		fragments: { ...keep("contentHash", "dynamic"), id: "token", relPath: "path" },
		compile: {
			...keep("version", "previousHash", "systemPromptHash", "tokenEstimate", "contextWindow"),
			at: "id",
			thinkingLevel: "token",
			contextWindowSource: "token",
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
	"tool-schemas": { name: "tool", description: "drop", parameters: "json-schema" },
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

/**
 * The shapes the harness mints ids, digests and timestamps in: a short lowercase prefix before a UUID, hex digest,
 * ULID or compact-UTC run id, or an ISO-8601 timestamp. None of them can spell a path or a sentence.
 */
const MINTED_ID = new RegExp(
	[
		"^(?:[a-z][a-z0-9]{0,11}[_:-])?",
		"(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{6,128}|[0-9A-HJKMNP-TV-Z]{26}|\\d{8}T\\d{6}Z-[0-9a-f]{6})",
		"(?:[_:-]\\d{1,6})?$",
		"|^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
	].join(""),
	"u",
);
/** An identifier-shaped word of a harness vocabulary: no whitespace, no path separator, at most 64 characters. */
const TOKEN = /^(?=.{1,64}$)[A-Za-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]+)*$/u;
/** A middleware rule's `matcher:subject@scope`, as `middleware.fired` evidence's schema admits it. */
const EVIDENCE = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_.-]{1,64})(?:@([a-z][a-z0-9-]{0,31}))?$/u;
/**
 * The evidence Clio's own rules record, which a share keeps verbatim. Any other evidence (an operator's rule or hook)
 * keeps its matcher and scope only when both are ones these use, with its subject anonymized; else it is dropped. A
 * built-in missing here is only anonymized or dropped, never leaked.
 */
export const BUILTIN_EVIDENCE: ReadonlySet<string> = new Set([
	"build:replaced@self-repository",
	"check:completion-evidence@turn-end",
	"check:uncited-line-numbers@final-answer",
	"count:enumerated-steps@operator-request",
	"count:failure-recurrence@task-memory",
	"count:open-tasks@turn-end",
	"count:ready-detached-batches@turn-end",
	"count:repeated-call@tool-args",
	"diff:mutating-turn@board-scope",
	"flag:untrustedInstructionMarkers@tool-result",
	"match:completed-dispatch@user-turn",
	"match:guidance-entry@turn",
	"match:marketplace-capability@task",
	"observer:file-mutation@tool-result",
	"observer:skill-activation@tool-result",
	"observer:turn-outcome@turn",
	"path:compacted-file@tool-args",
	"path:protected-artifact@tool-args",
	"path:sister-repository@session",
	"rank:skills@task",
	"regex:ANNOUNCED_WORK@assistant-text",
	"regex:TOOL_CALL_PROSE@assistant-text",
	"regex:WORKER_CLAIM_PATTERNS@assistant-text",
	"typed:claims-log@task",
	"typed:hypothesis-slate@tool-args",
	"typed:verify.check@tool-args",
	"typed:verify.report@tool-result",
]);
const EVIDENCE_MATCHERS: ReadonlySet<string> = new Set(
	[...BUILTIN_EVIDENCE].map((text) => text.slice(0, text.indexOf(":"))),
);
const EVIDENCE_SCOPES: ReadonlySet<string> = new Set(
	[...BUILTIN_EVIDENCE].map((text) => text.slice(text.indexOf("@") + 1)),
);
const TOOL_VOCABULARY: ReadonlySet<string> = new Set([
	...Object.values(ToolNames),
	"auto",
	"none",
	"required",
	"unknown",
]);
const RUNTIME_VOCABULARY: ReadonlySet<string> = new Set(
	BUILTIN_RUNTIME_BOOT_MANIFEST.flatMap((runtime) => [runtime.id, ...(runtime.aliases ?? [])]),
);

/** Whether a runtime id is one Clio ships, which a share or a report may name verbatim. */
export function isBuiltinRuntimeId(value: string): boolean {
	return RUNTIME_VOCABULARY.has(value);
}

/**
 * A value a `model-id` field may leave readable: one token with no whitespace or other prose, the shape a report
 * bundle's envelope carries. A label such as a run's response model observation is not one and is anonymized.
 */
const PLAIN_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]*$/u;

const MODEL_FILE =
	/\.(?:gguf|ggml|bin|safetensors|pt|pth|ckpt|onnx|tflite|mlmodel|mlpackage|llamafile|h5|npz|pkl|engine)$/iu;
const HOME_ROOTS: ReadonlySet<string> = new Set(["home", "Users"]);

/**
 * Whether a model or target identity names a location rather than a provider's model: an absolute, home-relative,
 * drive or backslash path, any URL, a path that starts after a separator such as `lmstudio:/home/...`, a `.`, `..`,
 * `~` or empty segment, a home directory root before another segment, or a separator before a model file's name.
 * `qwen/qwen3-coder`, `openrouter/anthropic/x` and `qwen3:8b` stay readable; `org/repo/model-q4.gguf` does not.
 */
export function carriesPath(value: string): boolean {
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
 * A tool's parameter schema keeps its shape: `type` in the JSON type vocabulary, child schemas, and the `required`
 * entries that name one of its properties. A property name is whatever the schema's author chose, a path included, so
 * each one becomes a `literal` anonymous id and its `required` entry the same id (#434). Descriptions, titles,
 * examples and defaults are dropped and every other literal is anonymized.
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
				Object.entries(properties).map(([name, child]) => [literal(name), projectJsonSchema(child, anonymize)]),
			);
		else if (key === "required" && Array.isArray(item))
			out[key] = item
				.filter((name) => typeof name === "string" && properties !== undefined && Object.hasOwn(properties, name))
				.map((name) => literal(name as string));
	}
	return out;
}

/** The kinds of string a projection can leave readable without `keep`: what a report's preview lists. */
export type ReadableKind = "model" | "runtime" | "tool" | "token";

/**
 * What a projection left readable and what it withheld, for a share's inventory (R-16). Strings under `keep` are
 * vocabulary members and minted ids by the soundness lint's guarantee, so they are not listed.
 */
export interface ProjectionTally {
	readonly readable: Map<ReadableKind, Set<string>>;
	withheld: number;
}

export function createProjectionTally(): ProjectionTally {
	return { readable: new Map(), withheld: 0 };
}

function projectField(
	value: unknown,
	projection: FieldProjection,
	anonymize: Anonymize,
	tally?: ProjectionTally,
): unknown {
	const readable = (kind: ReadableKind, text: string): string => {
		if (tally) {
			const values = tally.readable.get(kind) ?? new Set<string>();
			values.add(text);
			tally.readable.set(kind, values);
		}
		return text;
	};
	const withheld = (): string => {
		if (tally) tally.withheld += 1;
		return WITHHELD;
	};
	if (projection === "keep") return value;
	if (projection === "drop") return DROP;
	if (projection === "withhold") return mapStrings(value, withheld);
	if (projection === "model-id")
		return mapStrings(value, (text) =>
			carriesPath(text) || !PLAIN_MODEL_ID.test(text) ? anonymize("model", text) : readable("model", text),
		);
	if (projection === "json-schema") return projectJsonSchema(value, anonymize);
	if (projection === "settings") return mapStringsAndKeys(value, (text) => anonymize("config", text), isSettingsField);
	if (projection === "settings-path") return mapStrings(value, (text) => projectSettingsPath(text, anonymize));
	if (projection === "id") return mapStrings(value, (text) => (MINTED_ID.test(text) ? text : anonymize("id", text)));
	if (projection === "token")
		return mapStrings(value, (text) => (TOKEN.test(text) ? readable("token", text) : anonymize("name", text)));
	if (projection === "evidence") {
		if (typeof value !== "string") return DROP;
		// A fixed harness constant, like a `keep` vocabulary: not listed as readable, and its `@` fits no inventory name.
		if (BUILTIN_EVIDENCE.has(value)) return value;
		const parts = EVIDENCE.exec(value);
		const [, matcher = "", subject = "", scope] = parts ?? [];
		if (!parts || !EVIDENCE_MATCHERS.has(matcher) || (scope !== undefined && !EVIDENCE_SCOPES.has(scope))) return DROP;
		return `${matcher}:${anonymize("name", subject)}${scope !== undefined ? `@${scope}` : ""}`;
	}
	if (projection === "tool")
		return mapStrings(value, (text) => (TOOL_VOCABULARY.has(text) ? readable("tool", text) : anonymize("name", text)));
	if (projection === "runtime")
		return mapStrings(value, (text) =>
			RUNTIME_VOCABULARY.has(text) ? readable("runtime", text) : anonymize("name", text),
		);
	if (projection === "token-keys") {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				TOKEN.test(key) ? readable("token", key) : anonymize("name", key),
				item,
			]),
		);
	}
	if (typeof projection === "string") return mapStrings(value, (text) => anonymize(projection, text));
	if (Array.isArray(value)) return value.map((item) => projectField(item, projection, anonymize, tally));
	if (typeof value === "string") return withheld();
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!Object.hasOwn(projection, key)) continue;
		const projected = projectField(item, projection[key] as FieldProjection, anonymize, tally);
		if (projected !== DROP) out[key] = projected;
	}
	return out;
}

/** The event and object tables one profile projects through. */
export interface ShareProjection {
	readonly events: Readonly<Record<string, FieldProjection>>;
	readonly objects: Readonly<Record<string, FieldProjection>>;
	/** How a record's envelope context is projected; absent, it is carried as it is. */
	readonly context?: { readonly [field: string]: FieldProjection };
}

const BASE_PROJECTION: ShareProjection = { events: SHARE_EVENT_PROJECTIONS, objects: SHARE_OBJECT_PROJECTIONS };

/**
 * Fields `report` anonymizes whatever the shared tables say (R2-safety-secrets-12). An endpoint or directory digest is
 * unsalted, so guessing reverses it; a System One engine is a target name; playbook step and command ids are names the
 * operator chose.
 */
const REPORT_FIELDS: Readonly<Record<string, AnonKind>> = {
	endpointIdentityHash: "endpoint",
	parentCwdHash: "path",
	engine: "name",
	stepId: "name",
	commandId: "name",
};

/**
 * Under `report` a record's context keeps the scope ids, which the archive names its scopes by, and the agent, which
 * is named by its scope; other ids go through `id`, so a provider's tool call id becomes anonymous. A System One agent
 * is named by its engine, a target name, so {@link projectSharedContext} makes it a `name` id (R2-safety-secrets-12).
 */
const REPORT_CONTEXT = {
	sessionId: "keep",
	runId: "keep",
	processId: "keep",
	turnId: "id",
	batchId: "id",
	parentRunId: "id",
	callId: "id",
	attemptId: "id",
	toolCallId: "id",
	agent: "keep",
} as const satisfies FieldProjection;

/**
 * The `report` overrides (R-16). A target id is a name the operator typed into settings, often a machine's or a site's,
 * so under `report` every target id becomes a `name` id. With `anonymizeModels` every other model identity becomes a
 * `model` id too. Both only tighten: neither `name` nor `model` keeps a value.
 */
function reportOverride(projection: FieldProjection, anonymizeModels: boolean, field?: string): FieldProjection {
	if (projection === "model-id") {
		if (field === "targetId" || field === "target") return "name";
		return anonymizeModels ? "model" : projection;
	}
	if (typeof projection === "string")
		return field !== undefined && Object.hasOwn(REPORT_FIELDS, field) ? (REPORT_FIELDS[field] as AnonKind) : projection;
	return Object.fromEntries(
		Object.entries(projection).map(([key, inner]) => [key, reportOverride(inner, anonymizeModels, key)]),
	);
}

const reportProjections = new Map<boolean, ShareProjection>();

/**
 * The tables a profile projects through: `report` applies {@link reportOverride} to the shared tables, every other
 * profile uses them as they are. `models: "anonymize"` applies only to `report`.
 */
export function projectionFor(profile: string, models: "keep" | "anonymize" = "keep"): ShareProjection {
	if (profile !== "report") return BASE_PROJECTION;
	const anonymizeModels = models === "anonymize";
	let projection = reportProjections.get(anonymizeModels);
	if (!projection) {
		const table = (source: Readonly<Record<string, FieldProjection>>) =>
			Object.fromEntries(Object.entries(source).map(([key, inner]) => [key, reportOverride(inner, anonymizeModels)]));
		projection = {
			events: table(SHARE_EVENT_PROJECTIONS),
			objects: table(SHARE_OBJECT_PROJECTIONS),
			context: REPORT_CONTEXT,
		};
		reportProjections.set(anonymizeModels, projection);
	}
	return projection;
}

/** A shareable record's payload as a share below research carries it; null for an event the table does not admit. */
export function projectSharedPayload(
	kind: string,
	data: unknown,
	anonymize: Anonymize,
	projection: ShareProjection = BASE_PROJECTION,
	tally?: ProjectionTally,
): unknown | null {
	if (!Object.hasOwn(projection.events, kind)) return null;
	return projectField(data, projection.events[kind] as FieldProjection, anonymize, tally);
}

/** A structural object as a share below research carries it; null for a subject the table does not admit. */
export function projectSharedObject(
	subject: string,
	value: unknown,
	anonymize: Anonymize,
	projection: ShareProjection = BASE_PROJECTION,
	tally?: ProjectionTally,
): unknown | null {
	if (!Object.hasOwn(projection.objects, subject)) return null;
	return projectField(value, projection.objects[subject] as FieldProjection, anonymize, tally);
}

/** A record's envelope context as a profile carries it; as it is when the profile does not project contexts. */
export function projectSharedContext<C>(
	ctx: C,
	anonymize: Anonymize,
	projection: ShareProjection = BASE_PROJECTION,
	tally?: ProjectionTally,
): C {
	if (projection.context === undefined) return ctx;
	const role = (ctx as { agent?: { role?: unknown } } | null)?.agent?.role;
	const table =
		role === "system-one" ? { ...projection.context, agent: { role: "keep", id: "name" } as const } : projection.context;
	return projectField(ctx, table, anonymize, tally) as C;
}

import { type Static, Type } from "typebox";

/**
 * TypeBox schema for the settings file. Mirrors the DEFAULT_SETTINGS constant in
 * src/core/defaults.ts. If you add a field there, add it here too and extend the
 * Static type export downstream.
 */

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

const ToolCallFormatSchema = Type.Union([
	Type.Literal("openai"),
	Type.Literal("anthropic"),
	Type.Literal("hermes"),
	Type.Literal("llama3-json"),
	Type.Literal("mistral"),
	Type.Literal("qwen"),
	Type.Literal("xml"),
]);

const ThinkingFormatSchema = Type.Union([
	Type.Literal("qwen-chat-template"),
	Type.Literal("openrouter"),
	Type.Literal("zai"),
	Type.Literal("anthropic-extended"),
	Type.Literal("deepseek-r1"),
	Type.Literal("openai-codex"),
	Type.Literal("harmony"),
]);

const StructuredOutputsSchema = Type.Union([
	Type.Literal("json-schema"),
	Type.Literal("gbnf"),
	Type.Literal("xgrammar"),
	Type.Literal("none"),
]);

/**
 * Partial<CapabilityFlags>. Endpoint-level overrides layer on top of the
 * runtime's defaults; all keys are optional so an endpoint can carry only the
 * fields it actually pins.
 */
const EndpointCapabilitiesSchema = Type.Partial(
	Type.Object({
		chat: Type.Boolean(),
		tools: Type.Boolean(),
		toolCallFormat: ToolCallFormatSchema,
		reasoning: Type.Boolean(),
		thinkingFormat: ThinkingFormatSchema,
		structuredOutputs: StructuredOutputsSchema,
		vision: Type.Boolean(),
		audio: Type.Boolean(),
		embeddings: Type.Boolean(),
		rerank: Type.Boolean(),
		fim: Type.Boolean(),
		contextWindow: Type.Integer({ minimum: 0 }),
		maxTokens: Type.Integer({ minimum: 0 }),
	}),
);

const EndpointPricingSchema = Type.Object({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
	cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
});

const EndpointAuthSchema = Type.Object({
	apiKeyEnvVar: Type.Optional(Type.String({ minLength: 1 })),
	apiKeyRef: Type.Optional(Type.String({ minLength: 1 })),
	oauthProfile: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const EndpointLifecycleSchema = Type.Union([Type.Literal("user-managed"), Type.Literal("clio-managed")]);

const EndpointDescriptorSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	runtime: Type.String({ minLength: 1 }),
	url: Type.Optional(Type.String({ minLength: 1 })),
	auth: Type.Optional(EndpointAuthSchema),
	defaultModel: Type.Optional(Type.String({ minLength: 1 })),
	wireModels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	capabilities: Type.Optional(EndpointCapabilitiesSchema),
	lifecycle: Type.Optional(EndpointLifecycleSchema),
	gateway: Type.Optional(Type.Boolean()),
	pricing: Type.Optional(EndpointPricingSchema),
});

const WorkerTargetSchema = Type.Object({
	endpoint: Type.Union([Type.String(), Type.Null()]),
	model: Type.Union([Type.String(), Type.Null()]),
	thinkingLevel: ThinkingLevelSchema,
});

const CompactionThresholdsSchema = Type.Object({
	warning: Type.Number({ minimum: 0, maximum: 1 }),
	maskObservations: Type.Number({ minimum: 0, maximum: 1 }),
	pruneObservations: Type.Number({ minimum: 0, maximum: 1 }),
	maskDialogue: Type.Number({ minimum: 0, maximum: 1 }),
	llmSummary: Type.Number({ minimum: 0, maximum: 1 }),
});

/**
 * Graduated compaction controls. `threshold` remains optional only so older
 * settings files can validate while core/config.ts migrates it to
 * thresholds.llmSummary in memory.
 */
const CompactionSchema = Type.Object({
	thresholds: CompactionThresholdsSchema,
	auto: Type.Boolean(),
	excludeLastTurns: Type.Integer({ minimum: 1 }),
	threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	systemPrompt: Type.Optional(Type.String({ minLength: 1 })),
});

const RetrySchema = Type.Object({
	enabled: Type.Boolean(),
	maxRetries: Type.Integer({ minimum: 0 }),
	baseDelayMs: Type.Integer({ minimum: 0 }),
	maxDelayMs: Type.Integer({ minimum: 0 }),
});

const TerminalSchema = Type.Object({
	showTerminalProgress: Type.Boolean(),
});

const SkillsSchema = Type.Object({
	trustProjectCompatRoots: Type.Boolean(),
});

const DelegationToolGovernanceSchema = Type.Union([
	Type.Literal("clio-policy"),
	Type.Literal("agent-managed"),
	Type.Literal("deny-all"),
]);

const DelegationAgentSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	command: Type.String({ minLength: 1 }),
	args: Type.Array(Type.String()),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	connectTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	turnTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	permissionTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	toolGovernance: Type.Optional(DelegationToolGovernanceSchema),
	labels: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const DelegationSchema = Type.Object({
	agents: Type.Array(DelegationAgentSchema),
	defaults: Type.Object({
		connectTimeoutMs: Type.Integer({ minimum: 0 }),
		turnTimeoutMs: Type.Integer({ minimum: 0 }),
		permissionTimeoutMs: Type.Integer({ minimum: 0 }),
		toolGovernance: DelegationToolGovernanceSchema,
	}),
});

export const SettingsSchema = Type.Object({
	version: Type.Literal(1),
	identity: Type.String({ minLength: 1 }),
	safetyLevel: Type.Union([Type.Literal("suggest"), Type.Literal("auto-edit"), Type.Literal("full-auto")]),
	endpoints: Type.Array(EndpointDescriptorSchema),
	runtimePlugins: Type.Array(Type.String({ minLength: 1 })),
	orchestrator: WorkerTargetSchema,
	workers: Type.Object({
		default: WorkerTargetSchema,
		profiles: Type.Record(Type.String({ minLength: 1 }), WorkerTargetSchema),
	}),
	scope: Type.Array(Type.String()),
	budget: Type.Object({
		sessionCeilingUsd: Type.Number({ minimum: 0 }),
		concurrency: Type.Union([Type.Literal("auto"), Type.Number({ minimum: 1 })]),
	}),
	theme: Type.String(),
	terminal: TerminalSchema,
	skills: SkillsSchema,
	delegation: DelegationSchema,
	// User keybinding overrides mirror pi-tui's KeybindingsConfig: each id
	// maps to a KeyId (string) or a KeyId[] (array of strings). The loader
	// in core/config.ts normalizes legacy single-string entries on read.
	keybindings: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
	state: Type.Object({
		recentModels: Type.Optional(Type.Array(Type.String())),
	}),
	compaction: CompactionSchema,
	retry: RetrySchema,
});

export type ValidatedSettings = Static<typeof SettingsSchema>;

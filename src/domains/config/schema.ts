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

const EndpointDescriptorSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	runtime: Type.String({ minLength: 1 }),
	url: Type.Optional(Type.String({ minLength: 1 })),
	auth: Type.Optional(EndpointAuthSchema),
	defaultModel: Type.Optional(Type.String({ minLength: 1 })),
	wireModels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	capabilities: Type.Optional(EndpointCapabilitiesSchema),
	gateway: Type.Optional(Type.Boolean()),
	pricing: Type.Optional(EndpointPricingSchema),
});

const WorkerTargetSchema = Type.Object({
	endpoint: Type.Union([Type.String(), Type.Null()]),
	model: Type.Union([Type.String(), Type.Null()]),
	thinkingLevel: ThinkingLevelSchema,
});

/**
 * Compaction controls (Phase 12 slice 12c). Matches the shape of
 * `CompactionSettings` in src/core/defaults.ts: threshold (0..1) gates the
 * auto trigger, `auto` is the master switch, and the two optional fields
 * let power users override the summarization model or system prompt.
 */
const CompactionSchema = Type.Object({
	threshold: Type.Number({ minimum: 0, maximum: 1 }),
	auto: Type.Boolean(),
	model: Type.Optional(Type.String({ minLength: 1 })),
	systemPrompt: Type.Optional(Type.String({ minLength: 1 })),
});

export const SettingsSchema = Type.Object({
	version: Type.Literal(1),
	identity: Type.String({ minLength: 1 }),
	defaultMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
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
	// User keybinding overrides mirror pi-tui's KeybindingsConfig: each id
	// maps to a KeyId (string) or a KeyId[] (array of strings). The loader
	// in core/config.ts normalizes legacy single-string entries on read.
	keybindings: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
	state: Type.Object({
		lastMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
	}),
	compaction: CompactionSchema,
});

export type ValidatedSettings = Static<typeof SettingsSchema>;

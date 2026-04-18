import { type Static, Type } from "@sinclair/typebox";

/**
 * TypeBox schema for the settings file. Mirrors the DEFAULT_SETTINGS constant in
 * src/core/defaults.ts. If you add a field there, add it here too and extend the
 * Static type export downstream.
 */

const ThinkingFormatSchema = Type.Union([
	Type.Literal("qwen"),
	Type.Literal("qwen-chat-template"),
	Type.Literal("openrouter"),
	Type.Literal("zai"),
]);

const EndpointSpecSchema = Type.Object({
	url: Type.String({ minLength: 1 }),
	default_model: Type.Optional(Type.String()),
	api_key: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	reasoning: Type.Optional(Type.Boolean()),
	thinking_format: Type.Optional(ThinkingFormatSchema),
	context_window: Type.Optional(Type.Integer({ minimum: 1 })),
	max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
	supports_images: Type.Optional(Type.Boolean()),
	compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const LocalProviderSchema = Type.Object({
	endpoints: Type.Record(Type.String(), EndpointSpecSchema),
});

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

const WorkerTargetSchema = Type.Object({
	provider: Type.Optional(Type.String({ minLength: 1 })),
	endpoint: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
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
	provider: Type.Object({
		active: Type.Union([Type.String(), Type.Null()]),
		model: Type.Union([Type.String(), Type.Null()]),
		scope: Type.Optional(Type.Array(Type.String())),
	}),
	providers: Type.Optional(
		Type.Object({
			llamacpp: Type.Optional(LocalProviderSchema),
			lmstudio: Type.Optional(LocalProviderSchema),
			ollama: Type.Optional(LocalProviderSchema),
			"openai-compat": Type.Optional(LocalProviderSchema),
		}),
	),
	orchestrator: Type.Optional(WorkerTargetSchema),
	workers: Type.Optional(
		Type.Object({
			default: Type.Optional(WorkerTargetSchema),
		}),
	),
	budget: Type.Object({
		sessionCeilingUsd: Type.Number({ minimum: 0 }),
		concurrency: Type.Union([Type.Literal("auto"), Type.Number({ minimum: 1 })]),
	}),
	runtimes: Type.Object({
		enabled: Type.Array(Type.String()),
	}),
	theme: Type.String(),
	keybindings: Type.Record(Type.String(), Type.String()),
	state: Type.Object({
		lastMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
	}),
	intelligence: Type.Optional(
		Type.Object({
			enabled: Type.Boolean(),
		}),
	),
	compaction: Type.Optional(CompactionSchema),
});

export type ValidatedSettings = Static<typeof SettingsSchema>;

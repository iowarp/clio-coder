import { type Static, Type } from "@sinclair/typebox";

/**
 * TypeBox schema for the settings file. Mirrors the DEFAULT_SETTINGS constant in
 * src/core/defaults.ts. If you add a field there, add it here too and extend the
 * Static type export downstream.
 */

const EndpointSpecSchema = Type.Object({
	url: Type.String({ minLength: 1 }),
	default_model: Type.Optional(Type.String()),
	api_key: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const LocalProviderSchema = Type.Object({
	endpoints: Type.Record(Type.String(), EndpointSpecSchema),
});

const WorkerTargetSchema = Type.Object({
	provider: Type.String({ minLength: 1 }),
	endpoint: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
});

export const SettingsSchema = Type.Object({
	version: Type.Literal(1),
	identity: Type.String({ minLength: 1 }),
	defaultMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
	safetyLevel: Type.Union([Type.Literal("suggest"), Type.Literal("auto-edit"), Type.Literal("full-auto")]),
	provider: Type.Object({
		active: Type.Union([Type.String(), Type.Null()]),
		model: Type.Union([Type.String(), Type.Null()]),
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
});

export type ValidatedSettings = Static<typeof SettingsSchema>;

import { Type, type Static } from "@sinclair/typebox";

/**
 * TypeBox schema for the settings file. Mirrors the DEFAULT_SETTINGS constant in
 * src/core/defaults.ts. If you add a field there, add it here too and extend the
 * Static type export downstream.
 */

export const SettingsSchema = Type.Object({
	version: Type.Literal(1),
	identity: Type.String({ minLength: 1 }),
	defaultMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
	safetyLevel: Type.Union([Type.Literal("suggest"), Type.Literal("auto-edit"), Type.Literal("full-auto")]),
	provider: Type.Object({
		active: Type.Union([Type.String(), Type.Null()]),
		model: Type.Union([Type.String(), Type.Null()]),
	}),
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
});

export type ValidatedSettings = Static<typeof SettingsSchema>;

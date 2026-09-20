import { type Static, Type } from "typebox";
import { SettingsOrigin } from "./settings.js";

const closed = { additionalProperties: false };
export const SettingTiming = Type.Union([
	Type.Literal("hotReload"),
	Type.Literal("nextTurn"),
	Type.Literal("restartRequired"),
]);
export const SettingControl = Type.Object(
	{
		path: Type.String(),
		section: Type.String(),
		group: Type.String(),
		label: Type.String(),
		description: Type.String(),
		help: Type.Optional(Type.String()),
		/** Per-choice operator help, keyed by the choice value. */
		valueHelp: Type.Record(Type.String(), Type.String()),
		kind: Type.Union([
			Type.Literal("boolean"),
			Type.Literal("number"),
			Type.Literal("string"),
			Type.Literal("list"),
			Type.Literal("json"),
		]),
		choices: Type.Optional(Type.Array(Type.String())),
		/** Known-good values for a free-text control; the engine still validates the write. */
		suggestions: Type.Optional(Type.Array(Type.String())),
		optional: Type.Boolean(),
		timing: SettingTiming,
		/** The text form `applyControlValue` accepts. Structured collections cross as a count only. */
		value: Type.String(),
		source: SettingsOrigin,
		access: Type.Union([Type.Literal("writable"), Type.Literal("read-only")]),
		/** Why a read-only control has no editor. Always present when access is read-only. */
		reason: Type.Optional(Type.String()),
		/** A caveat shown beside a writable control. */
		note: Type.Optional(Type.String()),
		/** When present the write must carry `confirmed: true`, and the page shows this sentence first. */
		confirm: Type.Optional(Type.String()),
	},
	closed,
);
export const SettingsSection = Type.Object(
	{ id: Type.String(), label: Type.String(), description: Type.String() },
	closed,
);
export const SettingsControls = Type.Object(
	{ sections: Type.Array(SettingsSection), controls: Type.Array(SettingControl), userFile: Type.String() },
	closed,
);
export const SettingWrite = Type.Object(
	{
		path: Type.String({ maxLength: 200, pattern: "^[A-Za-z][A-Za-z0-9]*(\\.[A-Za-z][A-Za-z0-9]*){1,6}$" }),
		value: Type.String({ maxLength: 8192 }),
		confirmed: Type.Optional(Type.Boolean()),
	},
	closed,
);
export const SettingWritten = Type.Object(
	{
		/** Every control whose effective value changed, the requested one first. */
		changed: Type.Array(Type.Object({ path: Type.String(), value: Type.String() }, closed)),
		timing: SettingTiming,
		controls: SettingsControls,
	},
	closed,
);
export type SettingControl = Static<typeof SettingControl>;
export type SettingsControls = Static<typeof SettingsControls>;
export type SettingWrite = Static<typeof SettingWrite>;
export type SettingWritten = Static<typeof SettingWritten>;

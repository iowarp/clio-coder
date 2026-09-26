import { type Static, Type } from "typebox";

// `_clio-coder/extensions/*` and `_clio-coder/library/reload`: the terminal's /extensions view and the two
// reloads. The agent bounds extensions at 64, lines at 40 and every string at 512 bytes.
const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 520 });
const method = Type.String({ maxLength: 128 });
const count = Type.Integer({ minimum: 0 });

export const ExtensionsCapability = Type.Object({ version: Type.Literal(1), list: method, reload: method }, closed);
export const LibraryCapability = Type.Object({ version: Type.Literal(1), reload: method }, closed);

export const SessionExtensions = Type.Object(
	{
		version: Type.Literal(1),
		extensions: Type.Array(
			Type.Object(
				{
					id: text,
					name: text,
					version: text,
					description: text,
					scope: text,
					state: Type.Union([
						Type.Literal("eligible"),
						Type.Literal("disabled"),
						Type.Literal("invalid"),
						Type.Literal("incompatible"),
						Type.Literal("shadowed"),
					]),
					overriddenBy: Type.Optional(text),
					runtime: Type.Boolean(),
					problems: count,
					diagnostics: Type.Array(text, { maxItems: 3 }),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export type SessionExtensions = Static<typeof SessionExtensions>;

export const ExtensionReload = Type.Union([
	Type.Object(
		{
			status: Type.Literal("committed"),
			generation: count,
			changed: Type.Boolean(),
			added: count,
			removed: count,
			modified: count,
			hooks: Type.Object({ registered: count, dropped: count, issues: count, overridden: count }, closed),
			lines: Type.Array(text, { maxItems: 40 }),
		},
		closed,
	),
	Type.Object(
		{ status: Type.Literal("rejected"), reason: text, generation: count, lines: Type.Array(text, { maxItems: 40 }) },
		closed,
	),
]);
export type ExtensionReload = Static<typeof ExtensionReload>;

export const LibraryReload = Type.Union([
	Type.Object(
		{ status: Type.Literal("refreshed"), generation: count, previousGeneration: count, changed: Type.Boolean() },
		closed,
	),
	Type.Object({ status: Type.Literal("failed"), error: Type.String({ maxLength: 1100 }) }, closed),
]);

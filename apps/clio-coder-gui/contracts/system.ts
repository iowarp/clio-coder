import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
const nullable = Type.Union([Type.String(), Type.Null()]);
const presence = Type.Union([Type.Literal("present"), Type.Literal("absent"), Type.Literal("unknown")]);
/**
 * How far one agent is wired as a delegation peer. The states are different facts and never share a
 * word: `configured` has a delegation entry, `not-acp` has no recipe Clio Coder could speak,
 * `proposed` is what the terminal review would offer, `decided` holds a standing answer against
 * unchanged facts, and `not-offered` is none of those. `unknown` means the settings that decide it
 * could not be read.
 */
export const InteropWiring = Type.Union([
	Type.Literal("configured"),
	Type.Literal("not-acp"),
	Type.Literal("proposed"),
	Type.Literal("decided"),
	Type.Literal("not-offered"),
	Type.Literal("unknown"),
]);
export const SystemReport = Type.Object(
	{
		checkedAt: Type.String(),
		paths: Type.Object(
			{ config: Type.String(), data: Type.String(), state: Type.String(), cache: Type.String() },
			closed,
		),
		findings: Type.Array(
			Type.Object(
				{
					name: Type.String(),
					ok: Type.Boolean(),
					level: Type.Union([Type.Literal("ok"), Type.Literal("warn"), Type.Literal("error")]),
					detail: Type.String(),
					detailRedacted: Type.Boolean(),
				},
				closed,
			),
		),
	},
	closed,
);
/** `?probe=versions` is the only way this read runs a foreign executable, and only its `--version`. */
export const InteropQuery = Type.Object({ probe: Type.Optional(Type.Literal("versions")) }, closed);
export type InteropWiring = Static<typeof InteropWiring>;
export const Interop = Type.Object(
	{
		detectedAt: Type.String(),
		agents: Type.Array(
			Type.Object(
				{
					kind: Type.String(),
					label: Type.String(),
					hasExecutable: Type.Boolean(),
					presence,
					binary: nullable,
					version: nullable,
					/** `probed` ran `--version` for this read; `recorded` is the last version Clio Coder wrote down. */
					versionSource: Type.Union([Type.Literal("probed"), Type.Literal("recorded"), Type.Null()]),
					installDir: nullable,
					adapter: Type.Union([presence, Type.Null()]),
					decision: Type.Union([Type.Literal("accepted"), Type.Literal("declined"), Type.Null()]),
					decidedAt: nullable,
					/** The answer was given against facts that have since moved, so the agent is offered again. */
					decisionStale: Type.Boolean(),
					wiring: InteropWiring,
					skillCount: Type.Union([Type.Integer(), Type.Null()]),
					projectArtifacts: Type.Union([Type.Integer(), Type.Null()]),
					inventory: Type.Object(
						{
							status: Type.Union([Type.Literal("known"), Type.Literal("unknown")]),
							listing: Type.Literal("unknown"),
							diagnostics: Type.Array(Type.String()),
							items: Type.Array(
								Type.Object(
									{
										kind: Type.String(),
										name: Type.String(),
										path: Type.String(),
										scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
										plugin: Type.Optional(Type.String()),
										version: Type.Optional(Type.String()),
										marketplace: Type.Optional(Type.String()),
										installation: Type.Optional(Type.Union([Type.Literal("installed"), Type.Literal("unknown")])),
										enabled: Type.Optional(Type.Boolean()),
									},
									closed,
								),
							),
						},
						closed,
					),
				},
				closed,
			),
		),
	},
	closed,
);
export type Interop = Static<typeof Interop>;

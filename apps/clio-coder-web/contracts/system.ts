import { Type } from "typebox";

const closed = { additionalProperties: false };
const nullable = Type.Union([Type.String(), Type.Null()]);
const presence = Type.Union([Type.Literal("present"), Type.Literal("absent"), Type.Literal("unknown")]);
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
					installDir: nullable,
					adapter: Type.Union([presence, Type.Null()]),
					decision: Type.Union([Type.Literal("accepted"), Type.Literal("declined"), Type.Null()]),
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

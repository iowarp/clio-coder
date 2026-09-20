import { Type } from "typebox";

const closed = { additionalProperties: false };
export const SessionTargets = Type.Object(
	{
		targets: Type.Array(
			Type.Object(
				{
					id: Type.String({ maxLength: 128 }),
					runtime: Type.String({ maxLength: 64 }),
					models: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 64 }),
					isOrchestrator: Type.Boolean(),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export const TargetProbe = Type.Object(
	{
		targetId: Type.String({ maxLength: 128 }),
		healthy: Type.Boolean(),
		latencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		reason: Type.Union([
			Type.Null(),
			...[
				Type.Literal("not-configured"),
				Type.Literal("unreachable"),
				Type.Literal("unsupported"),
				Type.Literal("probe-failed"),
			],
		]),
	},
	closed,
);

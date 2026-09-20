import { Type } from "typebox";

const closed = { additionalProperties: false };
const record = Type.Record(Type.String(), Type.Unknown());
const strings = Type.Array(Type.String());
const nullable = Type.Union([Type.String(), Type.Null()]);
export const LibraryResource = Type.Object(
	{
		key: Type.String(),
		kind: Type.Union([Type.Literal("agent"), Type.Literal("skill"), Type.Literal("prompt"), Type.Literal("fleet")]),
		name: Type.String(),
		description: Type.String(),
		invocation: Type.Optional(Type.String()),
		path: Type.String(),
		source: Type.Object({ class: Type.String(), id: Type.String(), scope: Type.String() }, closed),
		owner: Type.Optional(record),
		origin: record,
		format: Type.Optional(Type.String()),
		availability: Type.String(),
		reason: Type.Optional(Type.String()),
		trusted: Type.Boolean(),
		modelInvocable: Type.Optional(Type.Boolean()),
		audience: Type.Optional(Type.String()),
		diagnostics: strings,
	},
	closed,
);
export const LibraryInventory = Type.Object(
	{
		version: Type.Literal(1),
		generatedAt: Type.String(),
		cwd: Type.String(),
		audience: Type.String(),
		packages: Type.Array(
			Type.Object(
				{
					ref: Type.String(),
					kind: Type.String(),
					name: Type.String(),
					description: Type.String(),
					version: Type.Optional(Type.String()),
					sha256: Type.Optional(Type.String()),
					sourceUrl: Type.String(),
					requires: Type.Optional(strings),
					origin: record,
					format: Type.Optional(Type.String()),
					provides: Type.Optional(Type.Array(record)),
					catalogOrigin: Type.String(),
					copies: Type.Array(record),
					refusal: Type.Optional(Type.String()),
				},
				closed,
			),
		),
		copies: Type.Array(record),
		resources: Type.Array(LibraryResource),
		diagnostics: strings,
		truncated: Type.Object({ packages: Type.Boolean(), copies: Type.Boolean(), resources: Type.Boolean() }, closed),
	},
	closed,
);
export const LibraryExtensions = Type.Object(
	{
		extensions: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					name: Type.String(),
					version: Type.String(),
					description: Type.String(),
					scope: Type.String(),
					enabled: Type.Boolean(),
					valid: Type.Boolean(),
					compatible: Type.Boolean(),
					effective: Type.Boolean(),
					loadable: Type.Boolean(),
					capabilities: Type.Union([record, Type.Null()]),
					runtime: Type.Union([record, Type.Null()]),
					provenance: Type.Union([record, Type.Null()]),
					diagnostics: Type.Array(
						Type.Object({ type: Type.String(), message: Type.String(), path: Type.Optional(Type.String()) }, closed),
					),
				},
				closed,
			),
		),
	},
	closed,
);
export const LibraryAgents = Type.Object(
	{
		agents: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					name: Type.String(),
					description: Type.String(),
					source: Type.String(),
					audience: Type.String(),
					category: Type.String(),
					skills: strings,
					tools: strings,
					configuration: record,
				},
				closed,
			),
		),
	},
	closed,
);
export const LibraryVerifiers = Type.Object(
	{
		version: Type.Literal(1),
		generatedAt: Type.String(),
		catalogPresent: Type.Boolean(),
		catalogValid: Type.Union([Type.Boolean(), Type.Null()]),
		rejection: nullable,
		rejectedAt: nullable,
		discovery: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
		blockedBy: nullable,
		checks: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					description: Type.String(),
					origin: Type.String(),
					signal: Type.String(),
					authority: Type.String(),
					runner: Type.String(),
					argumentCount: Type.Integer(),
					runsAtRepositoryRoot: Type.Boolean(),
					argvFixed: Type.Boolean(),
					timeoutMs: Type.Number(),
					tags: strings,
				},
				closed,
			),
		),
		checksTruncated: Type.Boolean(),
		diagnosticCount: Type.Integer(),
	},
	closed,
);

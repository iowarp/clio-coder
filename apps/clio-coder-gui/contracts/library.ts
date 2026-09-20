import { Type } from "typebox";
import { Id } from "./common.js";

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

const scope = Type.Union([Type.Literal("user"), Type.Literal("project")]);
const operation = Type.Union([
	Type.Literal("install"),
	Type.Literal("update"),
	Type.Literal("enable"),
	Type.Literal("disable"),
	Type.Literal("remove"),
]);
/** Catalog refs only. Paths and URLs stay terminal operations, so the browser can never name a source. */
const packageRef = Type.String({ pattern: "^(skill|agent|prompt|fleet|plugin):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const identity = Type.Object({ ref: Type.String(), kind: Type.String(), name: Type.String(), scope }, closed);
const copyState = Type.Object({ scope, loadable: Type.Boolean(), state: Type.String() }, closed);
const dependentBreak = Type.Object({ ref: Type.String(), scope, missing: strings }, closed);
export const LibraryPlanRequest = Type.Object(
	{
		operation,
		ref: packageRef,
		scope: Type.Optional(scope),
		force: Type.Optional(Type.Boolean()),
		withRequirements: Type.Optional(Type.Boolean()),
	},
	closed,
);
export const LibraryPlan = Type.Object(
	{
		id: Type.String({ pattern: "^[a-f0-9]{16}$" }),
		createdAt: Type.String(),
		expiresAt: Type.String(),
		operation,
		applicable: Type.Boolean(),
		steps: Type.Array(
			Type.Object(
				{
					operation,
					identity,
					destination: Type.String(),
					source: Type.Optional(
						Type.Object({ sourceUrl: Type.String(), sha256: Type.String(), staged: Type.Boolean() }, closed),
					),
					content: Type.Optional(
						Type.Object(
							{
								valid: Type.Boolean(),
								resources: Type.Array(Type.Object({ kind: Type.String(), name: Type.String(), valid: Type.Boolean() }, closed)),
								diagnostics: strings,
							},
							closed,
						),
					),
					dependencies: Type.Object({ requires: strings, missing: strings, inactive: strings }, closed),
					dependents: Type.Object(
						{ newlyBroken: Type.Array(dependentBreak), preexisting: Type.Array(dependentBreak) },
						closed,
					),
					effectiveAfter: Type.Optional(copyState),
					fallbackNote: Type.String(),
					recovery: Type.String(),
					refusal: Type.Optional(Type.String()),
				},
				closed,
			),
		),
		diagnostics: strings,
	},
	closed,
);
export const LibraryPlanParams = Type.Object({ id: Id, planId: Type.String({ pattern: "^[a-f0-9]{16}$" }) }, closed);
export const LibraryApplyResult = Type.Object(
	{
		planId: Type.String(),
		committed: Type.Integer(),
		failed: Type.Integer(),
		unattempted: Type.Integer(),
		outcomes: Type.Array(
			Type.Object(
				{
					status: Type.Union([Type.Literal("committed"), Type.Literal("failed"), Type.Literal("unattempted")]),
					operation,
					identity,
					verification: Type.Optional(
						Type.Object(
							{
								evidence: Type.Union([Type.Literal("pre-refresh"), Type.Literal("post-refresh")]),
								tree: Type.Union([Type.Literal("present"), Type.Literal("absent"), Type.Literal("changed")]),
								record: Type.Union([Type.Literal("recorded"), Type.Literal("absent"), Type.Literal("unreadable")]),
								copy: Type.Optional(Type.String()),
								resources: Type.Array(
									Type.Object(
										{
											kind: Type.String(),
											name: Type.String(),
											available: Type.Boolean(),
											reason: Type.Optional(Type.String()),
										},
										closed,
									),
								),
								effective: Type.Union([Type.Object({ scope, loadable: Type.Boolean() }, closed), Type.Null()]),
							},
							closed,
						),
					),
					recovery: Type.Optional(
						Type.Object({ packageBackup: Type.Optional(Type.String()), stateBackup: Type.Optional(Type.String()) }, closed),
					),
					diagnostics: strings,
					error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String(), next: Type.String() }, closed)),
				},
				closed,
			),
		),
		/** The web server holds no agent session, so an open conversation keeps its library until it reloads. */
		refresh: Type.Object({ status: Type.Literal("not-applicable"), reason: Type.String() }, closed),
	},
	closed,
);
export const LibraryPlanReleased = Type.Object({ released: Type.Boolean() }, closed);

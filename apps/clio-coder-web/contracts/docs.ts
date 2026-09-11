import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
export const DocEntry = Type.Object({ path: Type.String(), title: Type.String() }, closed);
export const DocsTree = Type.Object(
	{
		pages: Type.Array(DocEntry),
		groups: Type.Array(Type.Object({ title: Type.String(), pages: Type.Array(DocEntry) }, closed)),
	},
	closed,
);
export const DocPage = Type.Object(
	{
		path: Type.String(),
		title: Type.String(),
		markdown: Type.String(),
		links: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
		unavailableLinks: Type.Array(Type.String()),
	},
	closed,
);
export const DocsSearch = Type.Array(
	Type.Object({ path: Type.String(), title: Type.String(), excerpt: Type.String() }, closed),
);
export const Blueprints = Type.Object(
	{
		available: Type.Boolean(),
		items: Type.Array(
			Type.Object(
				{
					topic: Type.String(),
					title: Type.String(),
					file: Type.String(),
				},
				closed,
			),
		),
	},
	closed,
);
export type DocPage = Static<typeof DocPage>;
export type DocsTree = Static<typeof DocsTree>;
export type Blueprints = Static<typeof Blueprints>;
export type DocsRequest =
	| { kind: "tree" }
	| { kind: "blueprints" }
	| { kind: "page"; path: string }
	| { kind: "search"; q: string };
export type BlueprintFile = { body: Uint8Array; type: string; size: number };

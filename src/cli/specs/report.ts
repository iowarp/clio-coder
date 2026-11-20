import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["report"],
	summary: "preview, then send a report to the maintainers",
	hidden: false,
});

/** Nested leaves added in 0.8.5; each is dispatched inside `report`. */
export const leaves = [
	defineCommandSpec({
		path: ["report", "sweep"],
		summary: "revoke this machine's expired report gists and bundles through gh",
		hidden: false,
	}),
] as const;

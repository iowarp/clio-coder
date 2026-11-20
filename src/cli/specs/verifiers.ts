import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["verifiers"],
	summary: "discover, inspect, author, validate, edit, or dry-run project checks",
	hidden: false,
});

import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["evolve"],
	summary: "create, validate, or summarize change manifests",
	hidden: true,
});

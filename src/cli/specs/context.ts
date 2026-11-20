import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["context"],
	summary: "show project context status (CLIO-CODER.md, preload, codemap)",
	hidden: false,
});

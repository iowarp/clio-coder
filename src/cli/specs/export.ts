import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["export"],
	summary: "alias for clio-coder share export",
	hidden: true,
});

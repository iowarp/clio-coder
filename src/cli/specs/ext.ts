import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["ext"],
	summary: "alias for clio-coder extensions",
	hidden: true,
});

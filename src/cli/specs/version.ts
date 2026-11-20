import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["version"],
	summary: "print the CLIO Coder version",
	hidden: false,
});

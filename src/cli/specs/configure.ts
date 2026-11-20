import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["configure"],
	summary: "interactive first-run/configuration wizard",
	hidden: false,
});

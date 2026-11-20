import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["dev"],
	summary: "harness instruments and power-user surfaces; run 'clio-coder dev' for the list",
	hidden: false,
});

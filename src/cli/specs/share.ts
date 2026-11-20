import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["share"],
	summary: "export or import CLIO Coder project/resource archives",
	hidden: false,
});

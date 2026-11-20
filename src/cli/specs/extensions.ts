import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["extensions"],
	summary: "install, list, enable, disable, or remove extension packages",
	hidden: false,
});

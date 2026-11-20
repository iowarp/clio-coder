import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["components"],
	summary: "list, snapshot, or diff harness components",
	hidden: true,
});

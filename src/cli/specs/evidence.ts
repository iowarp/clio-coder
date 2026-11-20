import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["evidence"],
	summary: "list runs or inspect one run's sealed evidence",
	hidden: false,
});

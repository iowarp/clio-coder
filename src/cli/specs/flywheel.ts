import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["flywheel"],
	summary: "print the maintainers' ranked backlog from shared usage",
	hidden: true,
});

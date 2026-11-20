import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["report"],
	summary: "preview, then send a report to the maintainers",
	hidden: false,
});

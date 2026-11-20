import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["doctor"],
	summary: "diagnose state; --fix creates or repairs it",
	hidden: false,
});

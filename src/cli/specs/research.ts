import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["research"],
	summary: "hill climb a check's metric within a budget; inspect or regrade campaigns",
	hidden: false,
});

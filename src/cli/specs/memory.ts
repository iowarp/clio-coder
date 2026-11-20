import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["memory"],
	summary: "list, propose, promote, approve, reject, or prune memory",
	hidden: false,
});

import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["agents"],
	summary: "list discovered agent recipes",
	hidden: false,
});

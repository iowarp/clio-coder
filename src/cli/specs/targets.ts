import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["targets"],
	summary: "list configured targets, health, auth, and capabilities",
	hidden: false,
});

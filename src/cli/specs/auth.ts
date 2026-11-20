import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["auth"],
	summary: "list, check, log in to, or log out of target and runtime credentials",
	hidden: false,
});

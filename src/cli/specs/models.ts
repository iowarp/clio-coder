import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["models"],
	summary: "list models for configured targets",
	hidden: false,
});

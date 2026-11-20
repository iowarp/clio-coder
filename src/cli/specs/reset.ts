import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["reset"],
	summary: "recover or wipe CLIO Coder state",
	hidden: false,
});

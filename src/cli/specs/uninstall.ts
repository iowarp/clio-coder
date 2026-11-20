import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["uninstall"],
	summary: "remove CLIO Coder: its state, settings and launcher",
	hidden: false,
});

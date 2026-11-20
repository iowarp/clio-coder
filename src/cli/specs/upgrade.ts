import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["upgrade"],
	summary: "upgrade CLIO Coder and run pending migrations",
	hidden: false,
});

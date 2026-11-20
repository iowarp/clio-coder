import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["acp"],
	summary: "serve CLIO Coder as an ACP v1 agent over stdio",
	hidden: false,
});

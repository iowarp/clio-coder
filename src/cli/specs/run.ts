import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["run"],
	summary: "run one headless main-agent turn",
	hidden: false,
});

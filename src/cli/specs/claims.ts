import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["claims"],
	summary: "list, share or compact the project's recorded claims and worker disputes",
	hidden: false,
});

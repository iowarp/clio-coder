import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["campaign"],
	summary: "run one seeded project across a roster of models; per-entry gates, refusals, tokens, wall time",
	hidden: false,
});

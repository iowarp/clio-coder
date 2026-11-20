import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["usage"],
	summary: "cross-session usage facts and opportunities (experimental)",
	hidden: false,
});

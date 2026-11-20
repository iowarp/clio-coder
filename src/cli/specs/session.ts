import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["session"],
	summary: "open sessions on this state dir from any host; end or release one",
	hidden: false,
});

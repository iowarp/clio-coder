import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["fleet"],
	summary: "run playbooks on the fleet; inspect, verify, land, or cancel runs; admission control",
	hidden: false,
});

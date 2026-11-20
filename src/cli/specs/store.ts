import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["store"],
	summary: "inspect, verify and manage this project's store",
	hidden: false,
});

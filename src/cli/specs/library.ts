import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["library"],
	summary: "register, install, update, import, inspect, and manage packages of every kind",
	hidden: false,
});

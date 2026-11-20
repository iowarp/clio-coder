import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["paths"],
	summary: "print resolved config/data/cache directories",
	hidden: false,
});

import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["setup"],
	summary: "print the installers' closing message",
	hidden: true,
});

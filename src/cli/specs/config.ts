import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["config"],
	summary:
		"inspect effective customization and provenance; review or approve project safety, hooks, settings, extensions, or plugins",
	hidden: false,
});

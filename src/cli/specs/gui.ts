import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["gui"],
	summary: "open the alpha graphical application; 'gui background restart' after an upgrade",
	hidden: false,
});

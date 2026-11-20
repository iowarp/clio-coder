import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["help"],
	summary: "print a command's help; --json prints the machine-readable command manifest",
	hidden: false,
});

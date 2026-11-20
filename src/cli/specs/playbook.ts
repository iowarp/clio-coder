import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["playbook"],
	summary: "list, author, validate, and graph playbooks",
	hidden: false,
});

import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["tasks"],
	summary: "list, add, hand, finish, or drop project operator tasks",
	hidden: false,
});

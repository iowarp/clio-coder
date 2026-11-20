import { defineCommandSpec, type LeafFlagsSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["auth"],
	summary: "list, check, log in to, or log out of target and runtime credentials",
	hidden: false,
});

/** `auth login --api-key` stores the key in the credential store under the runtime id (SPEC 6.4, review R08). */
export const leafFlags: ReadonlyArray<LeafFlagsSpec> = [
	{
		path: ["auth", "login"],
		flags: [{ name: "--api-key", value: "string", placement: "leaf", persistence: "persisted" }],
	},
];

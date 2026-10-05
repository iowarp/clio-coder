import type { ExtensionApiV2 } from "@iowarp/clio-coder/extensions";

export default function extension(api: ExtensionApiV2): void {
	api.tool("describe", (input) => {
		if (input === null || typeof input !== "object" || !("name" in input) || typeof input.name !== "string")
			return { text: "name must be a string", isError: true };
		return { text: `Hello, ${input.name}.`, data: { name: input.name } };
	});
}

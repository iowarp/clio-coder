import type { ExtensionApiV2 } from "@iowarp/clio-coder/extensions";

export default function extension(api: ExtensionApiV2): void {
	api.handle("protect", async (args, ctx) => {
		const path = args.trim();
		if (!path) return { text: "Usage: protect <path>" };
		const current = await ctx.store.get<string[]>("protected");
		const paths = [...new Set([...(current.value ?? []), path])];
		const saved = await ctx.store.set("protected", paths, { ifVersion: current.version });
		return { text: saved.ok ? `Protected ${path}` : "The store changed; retry protect." };
	});
	api.hook("before_tool", async (event, ctx) => {
		if (event.point !== "before_tool" || !["write", "edit"].includes(event.tool)) return {};
		const path =
			event.args !== null && typeof event.args === "object" && "path" in event.args ? event.args.path : undefined;
		const { value = [] } = await ctx.store.get<string[]>("protected");
		return typeof path === "string" && value.includes(path)
			? { effects: [{ kind: "block_tool", reason: `__EXTENSION_ID__ protects ${path}` }] }
			: {};
	});
}

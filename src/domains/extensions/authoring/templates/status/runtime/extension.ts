import type { ExtensionApiV2, ExtensionContextV2, ExtensionOutputV2 } from "@iowarp/clio-coder/extensions";

async function pulse(ctx: ExtensionContextV2): Promise<ExtensionOutputV2> {
	const { value = 0 } = await ctx.state.get<number>("ticks");
	return {
		text: `__EXTENSION_ID__: ${value} ticks`,
		status: { text: `__EXTENSION_ID__ · ${value} ticks`, tone: "neutral" },
		band: {
			t: "kv",
			items: [
				{ label: "Workspace", value: ctx.snapshot.workspace },
				{ label: "Ticks", value: String(value) },
			],
		},
	};
}

export default function extension(api: ExtensionApiV2): void {
	api.handle("status", (_args, ctx) => pulse(ctx));
	api.on("session_open", (_event, ctx) => pulse(ctx));
	api.on("tick", async (_event, ctx) => {
		const current = await ctx.state.get<number>("ticks");
		await ctx.state.set("ticks", (current.value ?? 0) + 1, { ifVersion: current.version });
		return pulse(ctx);
	});
}

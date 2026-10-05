import type { ExtensionApiV2, ExtensionOutputV2 } from "@iowarp/clio-coder/extensions";

function regions(): NonNullable<ExtensionOutputV2["regions"]> {
	return {
		header: { t: "text", text: "__EXTENSION_ID__ workspace", tone: "brand", bold: true },
		board: {
			t: "board",
			action: "inspect",
			columns: [
				{ title: "Ready", cards: [{ key: "alpha", title: "Alpha task", detail: "Start here" }] },
				{ title: "Done", cards: [{ key: "beta", title: "Beta task" }] },
			],
		},
		footer: { t: "actions", items: [{ id: "next", label: "Refresh board", hotkey: "n", primary: true }] },
	};
}

export default function extension(api: ExtensionApiV2): void {
	api.handle("enter", () => ({
		text: "Entered __EXTENSION_ID__ desk.",
		workspace: { enter: "desk" },
		regions: regions(),
	}));
	api.handle("leave", () => ({ text: "Left __EXTENSION_ID__ desk.", workspace: { leave: true } }));
	api.action("next", () => ({ text: "Workspace refreshed.", regions: regions() }));
	api.action("inspect", (event) => ({ text: `Selected ${event.key ?? "unknown"}` }));
	api.on("turn_end", () => undefined);
}

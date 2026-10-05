import type { ExtensionApiV2, ExtensionOutputV2 } from "@iowarp/clio-coder/extensions";

function panel(): ExtensionOutputV2 {
	return {
		text: "Opened __EXTENSION_ID__ panel.",
		panel: {
			title: "__EXTENSION_ID__ tasks",
			view: {
				t: "box",
				children: [
					{
						t: "table",
						columns: ["Task", "State"],
						rows: [
							["Alpha", "ready"],
							["Beta", "done"],
						],
						keys: ["alpha", "beta"],
						action: "inspect",
					},
					{ t: "actions", items: [{ id: "refresh", label: "Refresh", hotkey: "r", primary: true }] },
				],
			},
		},
	};
}

export default function extension(api: ExtensionApiV2): void {
	api.handle("panel", () => panel());
	api.action("refresh", () => panel());
	api.action("inspect", (event) => ({ text: `Selected ${event.key ?? "unknown"}` }));
}

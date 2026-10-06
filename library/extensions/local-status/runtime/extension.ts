import type { ExtensionApiV2, ExtensionContextV2 } from "@iowarp/clio-coder/extensions";

export default function extension(api: ExtensionApiV2): void {
	const status = (context: ExtensionContextV2) => ({
		text: `Local status: ${context.snapshot.workspace}`,
		status: { text: "Local status ready", tone: "positive" as const },
	});
	api.handle("status", (_args, context) => status(context));
	api.on("session_open", (_event, context) => status(context));
}

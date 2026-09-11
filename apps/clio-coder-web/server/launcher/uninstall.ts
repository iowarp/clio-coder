import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { controlService } from "../process-policy.js";
import { backgroundRemoval } from "./background.js";
import { contents, launcherStatus, uninstallLauncher } from "./install.js";

export interface WebUninstallOptions {
	stateDir: string;
	desktopPrefix: string;
	packageRoot: string;
}

export interface WebUninstallPlan {
	items: Array<{ label: string; path: string }>;
	remove(): Promise<void>;
}

/** Root lifecycle uses the same manifests and removers as the app's own commands. */
export async function prepareWebUninstall(
	options: WebUninstallOptions,
	control = controlService,
): Promise<WebUninstallPlan> {
	if (process.platform !== "linux") return { items: [], remove: async () => {} };
	const directories = new Set([join(options.stateDir, "web/background")]);
	const desktop = await launcherStatus(options.desktopPrefix);
	if (desktop.status === "conflict")
		throw new Error("Desktop launcher ownership could not be verified; uninstall stopped before removing Clio state.");
	if (desktop.status !== "absent") {
		// launcherStatus has checked the digest and regenerated the entry from this manifest.
		const manifest = JSON.parse((await contents(desktop.manifest)) ?? "null");
		const root = await realpath(options.packageRoot);
		const candidates = [join(root, "dist/web/server.js"), join(root, "apps/clio-coder-web/server/main.ts")];
		if (!candidates.includes(manifest.launch.entry))
			throw new Error("Desktop launcher belongs to another installation; uninstall stopped before removing Clio state.");
		if (manifest.launch.background) directories.add(manifest.launch.background);
	}
	const backgrounds: Array<NonNullable<Awaited<ReturnType<typeof backgroundRemoval>>>> = [];
	for (const directory of directories) {
		const plan = await backgroundRemoval(directory, options.packageRoot, control);
		if (plan) backgrounds.push(plan);
	}
	const items = [
		...backgrounds.map((plan) => ({ label: "Background service", path: plan.path })),
		...(desktop.status !== "absent" ? [{ label: "Desktop launcher", path: desktop.entry }] : []),
	];
	return {
		items,
		remove: async () => {
			// Revalidate immediately before mutation. The caller may have waited for confirmation.
			const current = await prepareWebUninstall(options, control);
			if (JSON.stringify(current.items) !== JSON.stringify(items))
				throw new Error("Web installation changed during confirmation; run uninstall again.");
			for (const plan of backgrounds) await plan.remove();
			await uninstallLauncher(options.desktopPrefix);
		},
	};
}

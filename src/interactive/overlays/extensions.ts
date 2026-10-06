import type { InstalledExtension } from "../../domains/extensions/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../../session-control/slash-commands.js";
import { clioTheme } from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const EXTENSIONS_EMPTY =
	"no extensions installed. install one with `clio-coder extensions install <path>`, then `clio-coder extensions list` shows what it contributed.";

/**
 * Whether this extension's takeover of its plugin's prompts is live, and if
 * not, why. The plugin is a separate package: a takeover answers `/<plugin>:*`
 * only while the plugin is in effect and this extension is running.
 */
function pluginPairing(ext: InstalledExtension, state: string): string {
	const plugin = ext.plugin as string;
	const takes = (ext.runtimeV2?.commands ?? [])
		.filter((command) => command.replaces === "prompt" && ext.pluginPrompts?.includes(`${plugin}:${command.name}`))
		.map((command) => `/${plugin}:${command.name}`);
	if (state === "muted")
		return `serves ${plugin}. Muted for this session, so ${plugin}'s own prompts answer /${plugin}:* until /extensions unmute ${ext.id}.`;
	if (takes.length > 0)
		return `serves ${plugin}, which is installed and in effect. This extension answers ${takes.join(", ")} locally; its other commands run as /ext:${ext.id}:*.`;
	if ((ext.pluginPrompts?.length ?? 0) > 0)
		return `serves ${plugin}, which is installed and in effect, and declares no takeover of its prompts. Its commands run as /ext:${ext.id}:*.`;
	return `serves ${plugin}, which is not in effect (not installed, disabled or shadowed). No /${plugin}:* prompt is taken over, and this extension's commands run as /ext:${ext.id}:*.`;
}

export function openExtensionsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const list = ctx.listExtensions?.() ?? [];
	const items: ListOverlayItem[] = list.map((ext) => {
		const state = !ext.valid
			? "invalid"
			: !ext.compatible
				? "incompatible"
				: !ext.enabled
					? "disabled"
					: ext.trustBlocked
						? "untrusted"
						: ext.muted
							? "muted"
							: ext.consentPending
								? "awaiting consent"
								: ext.loadable
									? "eligible"
									: `shadowed:${ext.overriddenBy ?? "higher"}`;

		const runtime = ctx.operatorExtensions?.entries().find((entry) => entry.id === ext.id && entry.scope === ext.scope);
		const meta = (): string => {
			const text = ext.runtime || ext.runtimeV2 ? `${state}; runtime ${runtime?.state ?? "not started"}` : state;
			return state === "eligible"
				? clioTheme().fg("success", text)
				: state === "disabled"
					? clioTheme().fg("disabledOption", "disabled")
					: clioTheme().fg("warning", state);
		};

		const label = `${ext.id.padEnd(22)} ${ext.scope.padEnd(7)} ${ext.description}`;

		return {
			id: ext.id,
			label,
			get meta() {
				return meta();
			},
			group: "Extensions",
			detail: () => {
				const lines = [
					`# Extension: ${ext.id}`,
					`**Version:** ${ext.version}`,
					`**Scope:** ${ext.scope}`,
					`**Description:** ${ext.description}`,
					`**State:** ${state}`,
				];
				if (ext.plugin) lines.push(`**Plugin:** ${pluginPairing(ext, state)}`);
				if (ext.runtime || ext.runtimeV2) {
					lines.push(
						`**Operator runtime:** ${runtime?.state ?? "not started"}; generation ${runtime?.generation ?? 0}`,
						ext.runtimeV2
							? "Runtime code executes on interactive startup/reload after installation, under Node permissions built from its manifest. Those are a seat belt, not a sandbox: network is not restricted, and a package allowed to run programs gives them your account's authority."
							: "Runtime code executes on interactive startup/reload after installation. It has your user account's authority; it is not an OS sandbox.",
					);
					if (runtime?.reason) lines.push(runtime.reason);
					if (runtime?.status) lines.push(`**Status:** ${runtime.status.text}`);
					for (const command of ctx.operatorExtensions
						?.commands((ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items.map((prompt) => prompt.name) ?? [])
						.filter((row) => row.extensionId === ext.id) ?? [])
						lines.push(`/${command.invocation}: ${command.description} (${command.available ? "ready" : command.reason})`);
				}
				if (ext.capabilities?.tools.length)
					lines.push(`**Tool evidence:** ${runtime?.toolEvidence ?? "registry binding unknown in this view"}`);
				for (const reason of runtime?.newSessionReasons ?? []) lines.push(reason);
				lines.push(`Manage this copy: clio-coder extensions enable|disable|remove ${ext.id} --${ext.scope}`);
				if (ext.capabilities?.tools.length)
					lines.push(
						`**Command tools:** ${ext.capabilities.tools.map((tool) => tool.name).join(", ")}`,
						"Restart the session after changes to refresh tool schemas.",
					);
				for (const diagnostic of ext.diagnostics) lines.push(`**${diagnostic.type}:** ${diagnostic.message}`);
				if (ext.overriddenBy) {
					lines.push(`**Overridden By:** ${ext.overriddenBy}`);
				}
				return lines;
			},
		};
	});

	return openListOverlay(tui, {
		markerId: "extensions",
		title: "Extensions Reference",
		items,
		filterable: true,
		emptyMessage: EXTENSIONS_EMPTY,
		onClose,
	});
}

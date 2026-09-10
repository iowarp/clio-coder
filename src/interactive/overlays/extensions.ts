import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { clioTheme } from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const EXTENSIONS_EMPTY =
	"no extensions installed. install one with `clio-coder extensions install <path>`, then `clio-coder extensions list` shows what it contributed.";

export function openExtensionsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const list = ctx.listExtensions?.() ?? [];
	const items: ListOverlayItem[] = list.map((ext) => {
		const state = !ext.valid
			? "invalid"
			: !ext.compatible
				? "incompatible"
				: !ext.enabled
					? "disabled"
					: ext.loadable
						? "eligible"
						: `shadowed:${ext.overriddenBy ?? "higher"}`;

		const runtime = ctx.operatorExtensions?.entries().find((entry) => entry.id === ext.id && entry.scope === ext.scope);
		let meta = ext.runtime ? `${state}; runtime ${runtime?.state ?? "not started"}` : state;
		if (state === "eligible") {
			meta = clioTheme().fg("success", meta);
		} else if (state === "disabled") {
			meta = clioTheme().fg("dim", "disabled");
		} else {
			meta = clioTheme().fg("warning", state);
		}

		const label = `${ext.id.padEnd(22)} ${ext.scope.padEnd(7)} ${ext.description}`;

		return {
			id: ext.id,
			label,
			meta,
			group: "Harness extensions",
			detail: () => {
				const lines = [
					`# Extension: ${ext.id}`,
					`**Version:** ${ext.version}`,
					`**Scope:** ${ext.scope}`,
					`**Description:** ${ext.description}`,
					`**State:** ${state}`,
				];
				if (ext.runtime) {
					lines.push(
						`**Operator runtime:** ${runtime?.state ?? "not started"}; generation ${runtime?.generation ?? 0}`,
						"Runtime code executes on interactive startup/reload after installation. It has your user account's authority; it is not an OS sandbox.",
					);
					if (runtime?.reason) lines.push(runtime.reason);
					if (runtime?.status) lines.push(`**Status:** ${runtime.status.text}`);
					for (const command of ctx.operatorExtensions
						?.commands(ctx.listPrompts().items.map((prompt) => prompt.name))
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

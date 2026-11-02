/**
 * `/extensions`: every installed harness extension, whether it is running, and
 * whether anything about it is broken. Each row leads with its state as a
 * status chip, so the shape of the list answers the question before a row is
 * opened; the detail then names the exact command that manages the copy.
 */

import { readLifecycleReceipts } from "../../core/library-receipts.js";
import { packageActivityText, recentPackageActivity } from "../../core/package-activity.js";
import { extensionIdentity } from "../../domains/extensions/activity.js";
import type { InstalledExtension } from "../../domains/extensions/index.js";
import { promptRefs } from "../../domains/extensions/operator-commands.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../../session-control/slash-commands.js";
import {
	chip,
	chipRows,
	clioTheme,
	commandBlock,
	type Fact,
	factRows,
	type StatusKind,
	statusChip,
	titleRow,
} from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const EXTENSIONS_EMPTY =
	"no extensions installed. install one with `clio-coder extensions install <path>`, then `clio-coder extensions list` shows what it contributed.";

const FACT_OPTIONS = { labelRole: "fieldName" as const, stack: "never" as const };

/** The install state in one word, the same vocabulary `extensions list` prints. */
function extensionState(ext: InstalledExtension): string {
	return !ext.valid
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
}

/** The outcome glyph for a state, so a broken copy reads as broken in a monochrome terminal. */
function stateStatus(state: string): StatusKind {
	if (state === "eligible") return "ok";
	if (state === "invalid" || state === "incompatible") return "error";
	if (state === "untrusted") return "warning";
	if (state === "awaiting consent") return "pending";
	return "cancelled";
}

function runtimeStatus(state: string | undefined): StatusKind {
	if (state === "ready") return "running";
	if (state === "failed") return "error";
	if (state === "starting" || state === "staging") return "pending";
	return "queued";
}

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

/** What the OS sandbox does for a runtime, or what it would do, in one line. */
function confinement(
	net: boolean,
	sandbox: { backend: string | null; network: "blocked" | "allowed" | "unenforced"; reason?: string } | undefined,
): string {
	if (sandbox === undefined)
		return `not started; it runs in an OS sandbox when one is available, with the network ${net ? "open as declared" : "blocked as declared"}`;
	if (sandbox.backend === null)
		return `no OS sandbox (${sandbox.reason ?? "unavailable"}); Node flags only, so ${net ? "the network is open as declared" : "the declared network ban is not enforced"}`;
	return `${sandbox.backend} OS sandbox; network ${sandbox.network === "blocked" ? "blocked (enforced)" : "open as declared"}; secrets masked and Clio-managed paths read-only`;
}

const SCOPE_GROUP: Readonly<Record<InstalledExtension["scope"], string>> = {
	user: "User scope",
	project: "Project scope",
	dev: "Dev folders (this session)",
};

/**
 * The command that manages this copy. The CLI takes `--user` or `--project`;
 * a dev folder is never in install state, so its only handle is the session
 * mute, and naming a `--dev` flag that does not exist sent operators to a
 * usage error.
 */
function manageCommand(ext: InstalledExtension): string {
	if (ext.scope === "dev") return `/extensions mute ${ext.id}`;
	return `clio-coder extensions enable|disable|remove ${ext.id} --${ext.scope}`;
}

export function openExtensionsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const list = ctx.listExtensions?.() ?? [];
	const items: ListOverlayItem[] = list.map((ext) => {
		const state = extensionState(ext);
		const hasRuntime = Boolean(ext.runtime || ext.runtimeV2);
		const runtime = ctx.operatorExtensions?.entries().find((entry) => entry.id === ext.id && entry.scope === ext.scope);
		const runtimeWord = runtime?.state ?? "not started";
		const id = sanitizeCallTargetText(ext.id);
		const description = sanitizeCallTargetText(ext.description);
		const meta = (): string => {
			const theme = clioTheme();
			const parts = [statusChip(theme, stateStatus(state), state)];
			if (hasRuntime) parts.push(statusChip(theme, runtimeStatus(runtime?.state), `runtime ${runtimeWord}`));
			return parts.join(theme.fg("divider", " · "));
		};

		return {
			id: ext.id,
			label: `${id} ${ext.scope} ${description}`,
			cells: { lead: id, text: description },
			get meta() {
				return meta();
			},
			group: SCOPE_GROUP[ext.scope],
			detailFormat: "rows",
			detail: (width) => {
				const theme = clioTheme();
				const chips = [
					statusChip(theme, stateStatus(state), state),
					...(hasRuntime ? [statusChip(theme, runtimeStatus(runtime?.state), `runtime ${runtimeWord}`)] : []),
					...(ext.overriddenBy ? [chip(theme, `overridden by the ${ext.overriddenBy} copy`, "warning")] : []),
					...(ext.devSource ? [chip(theme, `from ${sanitizeCallTargetText(ext.devSource)}`, "muted")] : []),
				];
				const facts: Fact[] = [];
				if (ext.plugin) facts.push({ label: "Plugin", value: sanitizeCallTargetText(pluginPairing(ext, state)) });
				const envelopeDigest = extensionIdentity(ext).envelopeDigest;
				if (envelopeDigest) facts.push({ label: "Envelope", value: `sha256 ${envelopeDigest}` });
				const receipt = readLifecycleReceipts(ext.id, ext.scope, "extension").at(-1);
				if (receipt)
					facts.push({
						label: "Last lifecycle",
						value: `${receipt.operation} ${receipt.at} by ${receipt.actor}; ${receipt.id}@${receipt.version}; digest ${receipt.contentDigest}; operation ${receipt.operationId}`,
					});
				for (const row of recentPackageActivity(ext.id))
					facts.push({ label: "Activity", value: `${row.at} ${packageActivityText(row)}`, tone: "muted" });
				if (hasRuntime) {
					facts.push({ label: "Runtime", value: `${runtimeWord}; generation ${runtime?.generation ?? 0}` });
					if (ext.runtimeV2)
						facts.push({ label: "Confinement", value: confinement(ext.runtimeV2.permissions.net, runtime?.sandbox) });
					facts.push({
						label: "Authority",
						value: ext.runtimeV2
							? "Runtime code executes on interactive startup/reload after installation, under Node permissions built from its manifest. Those are a seat belt, not a boundary: a package allowed to run programs has your account's authority except where the OS sandbox confines it."
							: "Runtime code executes on interactive startup/reload after installation. It has your user account's authority; it is not an OS sandbox.",
						tone: "muted",
					});
					if (runtime?.reason)
						facts.push({ label: "Reason", value: sanitizeCallTargetText(runtime.reason), tone: "warning" });
					if (runtime?.status) facts.push({ label: "Status", value: sanitizeCallTargetText(runtime.status.text) });
					for (const command of ctx.operatorExtensions
						?.commands(promptRefs((ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items ?? []))
						.filter((row) => row.extensionId === ext.id) ?? [])
						facts.push({
							label: `/${command.invocation}`,
							value: `${sanitizeCallTargetText(command.description)} ${
								command.available
									? statusChip(theme, "ok", "ready")
									: statusChip(theme, "warning", sanitizeCallTargetText(command.reason ?? "unavailable"))
							}`,
						});
				}
				if (ext.capabilities?.tools.length) {
					facts.push({
						label: "Tool evidence",
						value: runtime?.toolEvidence ?? "registry binding unknown in this view",
						tone: "muted",
					});
					facts.push({
						label: "Command tools",
						value: `${ext.capabilities.tools.map((tool) => sanitizeCallTargetText(tool.name)).join(", ")}. Restart the session after changes to refresh tool schemas.`,
					});
				}
				for (const reason of runtime?.newSessionReasons ?? [])
					facts.push({ label: "New session", value: sanitizeCallTargetText(reason), tone: "warning" });
				for (const diagnostic of ext.diagnostics)
					facts.push({
						label: diagnostic.type,
						value: statusChip(theme, diagnostic.type, sanitizeCallTargetText(diagnostic.message)),
					});
				return [
					titleRow(theme, id, width, { meta: `v${sanitizeCallTargetText(ext.version)} · ${ext.scope}` }),
					...chipRows(theme, chips, width),
					theme.fg("body", description),
					"",
					theme.fg("annotation", ext.scope === "dev" ? "Unload this folder for the session with" : "Manage this copy with"),
					...commandBlock(theme, manageCommand(ext), width),
					...factRows(theme, facts, width, FACT_OPTIONS),
				];
			},
		};
	});

	return openListOverlay(tui, {
		markerId: "extensions",
		title: "Extensions",
		items,
		filterable: true,
		unit: "rows",
		emptyMessage: EXTENSIONS_EMPTY,
		onClose,
	});
}

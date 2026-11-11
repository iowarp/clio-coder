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
import { displaySafe } from "../display-safe.js";
import {
	chip,
	chipRows,
	clioTheme,
	commandBlock,
	type Fact,
	factRows,
	type StatusKind,
	statusChip,
	statusSeverity,
	titleRow,
} from "../theme/index.js";
import { movedKeyNotice } from "./confirm-once.js";
import { detailWithHead, type ListOverlayItem, markdownRows, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const EXTENSIONS_EMPTY =
	"No extensions installed. The Library lists bundled ones under Extensions (/library), and `clio-coder extensions install <path>` installs a folder.";

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

/** The install state as the operator reads it; the CLI keeps the one-word vocabulary. */
function stateWords(state: string): string {
	if (state === "eligible") return "enabled";
	if (state === "incompatible") return "needs another Clio version";
	if (state === "untrusted") return "waits for workspace trust";
	if (state === "muted") return "muted for this session";
	if (state === "awaiting consent") return "awaiting your consent";
	if (state.startsWith("shadowed:")) return `overridden by the ${state.slice("shadowed:".length)} copy`;
	return state;
}

/** The outcome glyph for a state, so a broken copy reads as broken in a monochrome terminal. */
function stateStatus(state: string): StatusKind {
	if (state === "eligible") return "ok";
	if (state === "invalid" || state === "incompatible") return "error";
	if (state === "untrusted") return "warning";
	if (state === "awaiting consent") return "pending";
	return "cancelled";
}

/** The runtime state as the operator reads it. */
function runtimeWords(state: string | undefined): string {
	if (state === "ready") return "running";
	if (state === "failed") return "failed";
	if (state === "starting" || state === "staging") return "starting";
	if (state === undefined || state === "inactive") return "not started";
	return state;
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
 * usage error. A muted folder is offered the way back, not a second mute.
 */
function manageCommand(ext: InstalledExtension): string {
	if (ext.scope === "dev") return `/extensions ${ext.muted ? "unmute" : "mute"} ${ext.id}`;
	return `clio-coder extensions enable|disable|remove ${ext.id} --${ext.scope}`;
}

function manageLabel(ext: InstalledExtension): string {
	if (ext.scope !== "dev") return "Manage this copy with";
	return ext.muted ? "Bring this folder back for the session with" : "Unload this folder for the session with";
}

/** A local date and time for a receipt, which is stored as ISO. */
function receiptTime(at: string): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime())
		? at
		: date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function openExtensionsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const operator = ctx.operatorExtensions;
	const promptNames = (): ReturnType<typeof promptRefs> =>
		promptRefs((ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items ?? []);
	/** The first command this extension can run now, which `v` puts in the composer. */
	let runnable = new Map<string, string>();

	const buildItems = (): ListOverlayItem[] => {
		// Every record is neutralized once, here: the manifests, the operator
		// runtime's view of them and their commands all carry text a package author
		// wrote. The envelope digest is taken from the raw record, so it is the same
		// digest the CLI and the receipts print.
		const raw = ctx.listExtensions?.() ?? [];
		const list = displaySafe(raw);
		const runtimes = displaySafe(operator?.entries() ?? []);
		const commands = displaySafe(operator?.commands(promptNames()) ?? []);
		runnable = new Map();
		for (const command of commands)
			if (command.available && !runnable.has(command.extensionId)) runnable.set(command.extensionId, command.invocation);
		return list.map((ext, index) => {
			const state = extensionState(ext);
			const hasRuntime = Boolean(ext.runtime || ext.runtimeV2);
			const runtime = runtimes.find((entry) => entry.id === ext.id && entry.scope === ext.scope);
			const runtimeWord = runtimeWords(runtime?.state);
			const id = ext.id;
			const own = commands.filter((row) => row.extensionId === ext.id);
			// The row text is one line; the pane renders the description as Markdown.
			const description = sanitizeCallTargetText(ext.description);
			// The worse of the two states leads, so a narrow row that keeps one chip
			// keeps the one that says the runtime failed. A runtime that was never
			// started on a copy that is not enabled follows from the state and is not
			// a chip of its own, and an enabled copy that runs says only that it runs.
			// A copy Clio refuses to load shows that refusal alone, unless its runtime failed on top of it.
			const runtimeChip =
				hasRuntime && (state === "eligible" ? true : runtime !== undefined && runtime.state === "failed");
			const stateChips = (theme: ReturnType<typeof clioTheme>): string[] =>
				[
					...(runtimeChip && state === "eligible" ? [] : [[stateStatus(state), stateWords(state)] as const]),
					...(runtimeChip ? [[runtimeStatus(runtime?.state), runtimeWord] as const] : []),
				]
					.sort((a, b) => statusSeverity(a[0]) - statusSeverity(b[0]))
					.map(([kind, text]) => statusChip(theme, kind, text));
			const meta = (): string => {
				const theme = clioTheme();
				return stateChips(theme).join(theme.fg("divider", " · "));
			};
			/** What the operator can do about this copy now, said once under its state. */
			const drifted = ext.diagnostics.some((diagnostic) => /drift/u.test(diagnostic.message));
			const next = (): string | undefined => {
				if (drifted)
					return `Its files changed after it was installed, so Clio will not run it. Reinstall it from its source with clio-coder extensions install <path> --${ext.scope === "dev" ? "user" : ext.scope} --force, or remove it.`;
				if (state === "disabled")
					return `Disabled. clio-coder extensions enable ${ext.id} --${ext.scope} turns it back on.`;
				if (!hasRuntime || state !== "eligible") return undefined;
				if (runtimeWord === "not started")
					return operator ? "Not started in this session yet. Press R to start installed extensions now." : undefined;
				if (runtimeWord === "failed") return operator ? "Fix the cause below, then press R to start it again." : undefined;
				if (runnable.has(ext.id)) return `Press v to put /${runnable.get(ext.id)} in the composer.`;
				return undefined;
			};

			return {
				id: ext.id,
				label: `${id} ${ext.scope} ${description}`,
				cells: { lead: id, text: description },
				get meta() {
					return meta();
				},
				group: SCOPE_GROUP[ext.scope],
				...detailWithHead((width) => {
					const theme = clioTheme();
					const chips = [
						...stateChips(theme),
						...(ext.overriddenBy ? [chip(theme, `overridden by the ${ext.overriddenBy} copy`, "warning")] : []),
						...(ext.devSource ? [chip(theme, `from ${ext.devSource}`, "muted")] : []),
					];
					// What it does for the operator comes first: its commands, its status
					// and why it is not running. Provenance and authority follow.
					const use: Fact[] = [];
					// One label for every command keeps the label column narrow; the
					// invocation leads the value so a long one wraps under itself.
					for (const command of own)
						use.push({
							label: "Command",
							// The command and whether it runs now lead; what it does follows, so the
							// state is never lost at the end of a wrapped description.
							value: [
								theme.fg("inlineCode", `/${command.invocation}`),
								command.available
									? statusChip(theme, "ok", "ready")
									: statusChip(theme, "warning", command.reason ?? "unavailable"),
								theme.fg("body", sanitizeCallTargetText(command.description)),
							].join(theme.fg("divider", " · ")),
						});
					if (runtime?.status) use.push({ label: "Status", value: sanitizeCallTargetText(runtime.status.text) });
					if (runtime?.reason) use.push({ label: "Reason", value: runtime.reason, tone: "warning" });
					for (const reason of runtime?.newSessionReasons ?? [])
						use.push({ label: "New session", value: reason, tone: "warning" });
					for (const diagnostic of ext.diagnostics)
						use.push({
							label: diagnostic.type === "error" ? "Problem" : "Note",
							value: statusChip(theme, diagnostic.type, sanitizeCallTargetText(diagnostic.message)),
						});

					const facts: Fact[] = [
						{ label: "Version", value: ext.version },
						{
							label: "Scope",
							value: ext.scope === "dev" ? `dev folder${ext.devSource ? ` ${ext.devSource}` : ""}` : ext.scope,
						},
					];
					if (ext.plugin) facts.push({ label: "Plugin", value: pluginPairing(ext, state) });
					if (hasRuntime) {
						facts.push({
							label: "Runtime",
							value: runtime?.generation ? `${runtimeWord}, generation ${runtime.generation}` : runtimeWord,
						});
						if (ext.runtimeV2)
							facts.push({ label: "Confinement", value: confinement(ext.runtimeV2.permissions.net, runtime?.sandbox) });
						facts.push({
							label: "Authority",
							value: ext.runtimeV2
								? "Runtime code executes on interactive startup/reload after installation, under Node permissions built from its manifest. Those are a seat belt, not a boundary: a package allowed to run programs has your account's authority except where the OS sandbox confines it."
								: "Runtime code executes on interactive startup/reload after installation. It has your user account's authority; it is not an OS sandbox.",
							tone: "muted",
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
							value: `${ext.capabilities.tools.map((tool) => tool.name).join(", ")}. Restart the session after changes to refresh tool schemas.`,
						});
					}
					const envelopeDigest = extensionIdentity(raw[index] ?? ext).envelopeDigest;
					if (envelopeDigest) facts.push({ label: "Envelope", value: `sha256 ${envelopeDigest}`, tone: "muted" });
					const receipt = displaySafe(readLifecycleReceipts(ext.id, ext.scope, "extension").at(-1));
					if (receipt)
						facts.push({
							label: "Last change",
							value: `${receipt.operation} ${receiptTime(receipt.at)} by ${receipt.actor}; ${receipt.id}@${receipt.version}; digest ${receipt.contentDigest}; operation ${receipt.operationId}`,
							tone: "muted",
						});
					for (const row of displaySafe(recentPackageActivity(ext.id)))
						facts.push({ label: "Activity", value: `${row.at} ${packageActivityText(row)}`, tone: "muted" });
					const hint = next();
					// The title and the state chips stay pinned while the rest scrolls;
					// the description keeps its Markdown structure under them.
					return {
						head: [
							titleRow(theme, ext.name && ext.name !== id ? `${ext.name} (${id})` : id, width, {
								meta: `v${ext.version} · ${ext.scope}`,
							}),
							...chipRows(theme, chips, width),
							...(hint ? [theme.fg("guidance", hint)] : []),
						],
						rest: [
							...markdownRows(ext.description, width),
							"",
							...factRows(theme, use, width, FACT_OPTIONS),
							...(use.length > 0 ? [""] : []),
							...factRows(theme, facts, width, FACT_OPTIONS),
							"",
							theme.fg("annotation", manageLabel(ext)),
							...commandBlock(theme, manageCommand(ext), width),
						],
					};
				}),
			};
		});
	};

	/** `v`: the selected extension's first ready command, typed into the composer for the operator to finish. */
	const use = (item: ListOverlayItem): void => {
		const invocation = runnable.get(item.id);
		if (!invocation) {
			ctx.notice("info", `${item.id} has no command ready to run; its detail says why.`);
			return;
		}
		if (!ctx.setEditorText) return;
		ctx.setEditorText(`/${invocation} `);
		onClose();
	};
	/**
	 * `r`: restart every installed extension. A reload waits for an idle session
	 * and this list holds the screen, so it closes first and the host's reload
	 * notice reports the result.
	 */
	const reload = (): void => {
		if (!operator) return;
		onClose();
		void operator.reload("reload").then((result) => {
			if (result.status === "deferred") ctx.notice("info", "Extensions restart once the current turn finishes.");
		});
	};

	return openListOverlay(tui, {
		markerId: "extensions",
		title: "Extensions",
		items: buildItems(),
		filterable: true,
		explicitSearch: true,
		// The detail is where an extension's commands, state and recovery live, so a
		// wide terminal draws it beside the list instead of under it in a few rows.
		layout: "split",
		unit: "rows",
		emptyMessage: EXTENSIONS_EMPTY,
		status: () => {
			const active = operator?.surface.activeWorkspace;
			return active
				? clioTheme().fg(
						"annotation",
						sanitizeCallTargetText(
							`Workspace ${active.title} from ${active.extensionId} is active; /extensions leave leaves it`,
						),
					)
				: undefined;
		},
		hints: (selected) => [
			...(selected && runnable.has(selected.id) && ctx.setEditorText ? [{ key: "v", verb: "use command" }] : []),
		],
		...(operator
			? {
					globalHints: [{ key: "R", verb: "restart all" }],
					globalActions: { R: reload, r: () => ctx.notice("info", movedKeyNotice("r", "R")) },
					confirmGlobal: { R: { verb: "restart", label: "every extension" } },
				}
			: {}),
		actions: { v: use },
		onClose,
	});
}

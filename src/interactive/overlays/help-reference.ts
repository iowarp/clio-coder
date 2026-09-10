import type { ExtensionCommandRow } from "../../domains/extensions/operator-commands.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import { CLOSED_ACTION_ORDER, GLOBAL_ACTION_ORDER } from "../application-controller.js";
import type { ClioKeybindingManager } from "../keybinding-manager.js";
import { commandReference, SLASH_COMMAND_GROUPS } from "../slash-commands.js";
import { formatKeybindingDetailBodyLines } from "./keybinding-detail.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

function formatKey(raw: string): string {
	if (raw === "(unbound)") return raw;
	return raw
		.split(" / ")
		.map((single) =>
			single
				.split("+")
				.map((segment) => {
					const head = segment.charAt(0);
					return head.length === 0 ? segment : head.toUpperCase() + segment.slice(1);
				})
				.join("+"),
		)
		.join(" / ");
}

export function openHelpOverlay(
	tui: TUI,
	manager: ClioKeybindingManager,
	onClose: () => void,
	initialFilter?: string,
	extensionCommands: readonly ExtensionCommandRow[] = [],
): OverlayHandle {
	// Commands are grouped by the verb they perform, in SLASH_COMMAND_GROUPS
	// order, and keep registry order inside each group.
	const groupRank = new Map(SLASH_COMMAND_GROUPS.map((group, index) => [group, index] as const));
	const commands: ListOverlayItem[] = [...commandReference()]
		.sort((a, b) => (groupRank.get(a.group) ?? 0) - (groupRank.get(b.group) ?? 0))
		.map((ref) => {
			const usagePart = ref.usage.length >= 30 ? `${ref.usage} ` : ref.usage.padEnd(30);
			const label = `${usagePart}${ref.description}`;
			const item: ListOverlayItem = {
				id: ref.name,
				label,
				group: ref.group,
				// Overlay key actions are deliberately not duplicated here: each
				// overlay's footer hint is the live source of its keys, and a static
				// copy would rot exactly like the old SLASH_HOTKEYS table did.
				detail: () => [`# Command: /${ref.name}`, `**Usage:** \`${ref.usage}\``, `**Description:** ${ref.description}`],
			};
			return item;
		});

	commands.push(
		...extensionCommands.map((row) => ({
			id: `extension:${row.invocation}`,
			label: `/${row.invocation}  ${row.description}`,
			group: "Operator extensions",
			meta: row.available ? "ready" : "unavailable",
			detail: () => [
				`# /${row.invocation}`,
				`Owner: ${row.extensionId} (${row.scope}); operator generation ${row.generation}`,
				row.available ? "Runs installed operator code; results stay local to you." : (row.reason ?? "Runtime unavailable"),
			],
		})),
	);

	const keyItems = (): ListOverlayItem[] => {
		const conflicts = manager.getConflicts();
		const keys: ListOverlayItem[] = manager.hotkeyEntries().map((row) => {
			const formattedKeys = formatKey(manager.actionLabel(row.id));
			const keysPart = formattedKeys.length >= 24 ? `${formattedKeys} ` : formattedKeys.padEnd(24);
			const label = `${keysPart}${row.description}`;

			const item: ListOverlayItem = {
				id: row.id,
				label,
				group: "Keys",
				detail: (width) => {
					const warnings = manager
						.platformWarnings()
						.filter((w) => w.id === row.id)
						.map((w) => `${w.keys.map(formatKey).join(" / ")} may not fire: ${w.reason}`);
					for (const conflict of conflicts.filter((entry) => entry.keybindings.includes(row.id))) {
						const appOrder = ["clio-coder.leader", ...CLOSED_ACTION_ORDER, ...GLOBAL_ACTION_ORDER].filter((id) =>
							conflict.keybindings.includes(id),
						);
						warnings.push(
							`${conflict.key}: ${conflict.keybindings.join(", ")}. Cancellation and the menu trigger take priority; outside the menu, the focused dialog owns input. Composer history precedes other application actions, then editing.${appOrder.length > 1 ? ` Composer app precedence: ${appOrder.join(" before ")}.` : ""}`,
						);
					}
					const detailEntry = {
						id: row.id,
						keys: formattedKeys,
						action: row.description,
						source: row.source,
						warnings,
					};
					return formatKeybindingDetailBodyLines(detailEntry, width);
				},
			};

			const metaParts: string[] = [];
			if (row.source === "user") metaParts.push("user");
			const hasConflict = conflicts.some((c) => c.keybindings.includes(row.id));
			if (hasConflict) metaParts.push("conflict");
			if (metaParts.length > 0) {
				item.meta = metaParts.join(", ");
			}

			return item;
		});

		return keys;
	};

	// Static concept topics. Unlike commands and keys these are not generated
	// from a registry; keep each detail consistent with the enforced behavior
	// and with the live footer hints on the surface it documents.
	const topics: ListOverlayItem[] = [
		{
			id: "topic-keyboard-migration",
			label: "keyboard migration             Defaults, action menu, editing and explicit overrides",
			group: "Topics",
			detail: () => [
				"# Keyboard migration",
				"Default keys: Alt+L Library, Alt+M model, Shift+Tab effort, Ctrl+Q follow-up, Alt+Q recovery. Alt+B/D and Home/End now edit the composer.",
				`The persistent action menu is ${manager.actionLabel("clio-coder.leader")}. Fixed suffixes work independently of direct key overrides; arrows and Enter reach every available entry.`,
				"Existing configured action IDs are preserved. Explicit [] disables an action's direct and menu routes. This help lists your effective keys; settings are never rewritten.",
				"Pasted slash and bang text remains literal until a deliberate submit. Ctrl+R searches the fullscreen transcript; Ctrl+C closes focused search or a dialog before cancelling other work.",
			],
		},
		{
			id: "topic-fleet-runs",
			label: `${"fleet runs & steering".padEnd(30)}Inspect, guide, and cancel delegated workers`,
			group: "Topics",
			detail: () => [
				"# Fleet runs & steering",
				`**Fleet Runs board**: ${manager.actionLabel("clio-coder.dispatchBoard.toggle")}. Use Up/Down or j/k to select a live or recent run.`,
				"**Enter**: on a live run in a `--with-panes` session, Enter opens (or retargets) the watch pane beside Clio, rendering that run's stream; the arrow keys then move it between runs. On a finished run, or without panes, Enter toggles the inline worker-progress detail instead.",
				"**Steer**: press `s` on a live native run to close the board and prefill `@<runId> `. Add guidance and submit it normally. The first notice means queued; a received notice confirms worker delivery.",
				"**Cancel**: press `x` on a running, stale, queued, or retry-waiting run. The row changes to cancelling while the worker or retry is being stopped.",
				"**Capabilities**: ACP delegation runs cannot accept live steering. The board footer only advertises actions supported by the selected row.",
				"**Tasks versus runs**: `/tasks` shows the agent's plan steps. Fleet runs are concrete delegated worker executions and remain in this board as recent terminal history.",
			],
		},
		{
			id: "topic-files-pane",
			label: `${"panes & files".padEnd(30)}The files pane, the logs and shell panes, and what closes them`,
			group: "Topics",
			detail: () => [
				"# Panes & files",
				"**Where it works**: a session started inside a herdr pane with `clio-coder --with-panes` (or `interface.panes.enabled: auto`). Outside herdr `/files` still works as a full-screen pick that returns to the composer; `/panes open logs|shell` do not.",
				`**Files pane**: /files or ${manager.actionLabel("clio-coder.files.toggle")} opens Yazi from Clio focus. Yazi and the host own keys until Ctrl+Y returns selected paths and focus. Close the pane from Clio with the same action. /files pick borrows it for one selection.`,
				"**Picking**: navigate, select with Space for several, then Ctrl+Y (or Enter in pick mode). The paths land in the composer as `@file` mentions and the keyboard returns to the composer.",
				"**Logs and shell**: `/panes open logs` follows the newest dispatched run's journal; `/panes open shell` opens a shell in the workspace. A second open focuses the pane that is already there. `/panes close <name|all>` closes them; `/quit` closes the docks it manages (files, workers), leaves a shell or logs pane you opened, and prints which panes it left and how to close them.",
				"**Engine**: the files pane runs a vendored file manager installed with `clio-coder tools install yazi`; `clio-coder doctor` and `/panes` say whether it resolved.",
			],
		},
		{
			id: "topic-steering-modes",
			label: `${"steering modes".padEnd(30)}Interrupt, next slot, or end of turn: when a message lands mid-run`,
			group: "Topics",
			detail: () => [
				"# Steering modes",
				"While Clio is running, the key that submits a message chooses when it lands. The default is next slot.",
				"**Next slot** (Enter): the message is delivered between tool batches, mid-run. The agent keeps going and reads it before its next model call.",
				`**End of turn** (${manager.actionLabel("clio-coder.message.followUp")}): wait until the whole run settles, then start the next round.`,
				`**Interrupt** (${manager.actionLabel("clio-coder.message.interrupt")} or /interrupt <text>): settle active work and deliver a fresh prompt. Queued messages return ahead of any newer draft.`,
				"**Interrupt is refused** while an attached dispatch is running (the abort would kill the worker's run with no receipt; steer it with `@<agent>` or cancel it with Esc) and while a permission ask is parked (it is already waiting on you). In both cases the message is queued for the next slot and a notice says why.",
				`**Recover queues**: ${manager.actionLabel("clio-coder.message.dequeue")}. Workers accept next-slot steering through @<agent>.`,
			],
		},
		{
			id: "topic-autonomy",
			label: `${"autonomy & safety net".padEnd(30)}How the autonomy level and the always-on guardrails interact`,
			group: "Topics",
			detail: () => [
				"# Autonomy & safety net",
				"**Tool surface**: which tools exist at all through registration, tool profiles, skill narrowing, and dispatch admission. " +
					"Violations are terminal denials, never approvable.",
				"**Safety net** (always on, level-independent): damage-control rules, path policy for secrets and system paths, " +
					"command-substitution confirmation, and `git_destructive` blocks. Blocks are final at every level; confirm rails ask at every level.",
				"**Autonomy level** (`/settings`, persisted as `autonomy`): the operator's standing grant per action class for actions the net passed, " +
					"enforced by the harness at tool admission. read-only denies non-read, suggest parks every non-read call, " +
					"auto-edit parks unrecognized commands, and full-auto runs them.",
				"**Approvals**: a parked call waits for a one-shot operator decision; approving resumes only that call. " +
					"Workers resolve asks per `workers.onPermission` (Approvals Routing); headless runs auto-deny.",
				"**Inspecting a mutation**: a parked `write` or `edit` card carries the target, the byte count, and a `sha256` digest of the exact call arguments. " +
					"Press `v` to read the complete proposed content, or the complete effective diff against the file on disk, and `v` again to put it away; ↑/↓ and PageUp/PageDown scroll it. " +
					"Enter still allows, `s` still stops, and Esc still denies while it is open. The mutation text is shown locally and never enters the transcript, a notice, a desktop notification, or the render trace. " +
					"A worker escalation has no preview because the call's arguments never leave the worker, and its card says so.",
			],
		},
	];

	const items = [...commands, ...keyItems(), ...topics];

	const handle = openListOverlay(tui, {
		markerId: "help",
		title: "Help Center",
		items,
		filterable: true,
		...(initialFilter ? { initialFilter } : {}),
		onClose,
	});
	const unsubscribe = manager.onReload(() => handle.setItems([...commands, ...keyItems(), ...topics]));
	return {
		...handle,
		hide() {
			unsubscribe();
			handle.hide();
		},
	};
}

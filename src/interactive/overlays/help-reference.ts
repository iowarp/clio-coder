import type { ExtensionCommandRow } from "../../domains/extensions/operator-commands.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { Keybinding, OverlayHandle, TUI } from "../../engine/tui.js";
import { commandReference } from "../../session-control/slash-commands.js";
import { CLOSED_ACTION_ORDER, GLOBAL_ACTION_ORDER } from "../application-controller.js";
import { displaySafe } from "../display-safe.js";
import type { ClioKeybindingManager } from "../keybinding-manager.js";
import {
	MUTATION_PREVIEW_KEY,
	PERMISSION_STOP_KEY,
	PERMISSION_TERMS_KEY,
	permissionKeyLabel,
} from "../permission-hint.js";
import { compactArgumentHint } from "../slash-autocomplete.js";
import { clioTheme, dotSep, type Fact, factRows, keyName, statusChip, titleRow } from "../theme/index.js";
import { formatKeybindingDetailBodyLines } from "./keybinding-detail.js";
import { detailWithHead, type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** Fact tables keep their label column at every width, the way the key detail does. */
const FACT_OPTIONS = { labelRole: "fieldName" as const, stack: "never" as const };

function formatKey(raw: string): string {
	return raw === "(unbound)" ? raw : keyName(raw);
}

export function openHelpOverlay(
	tui: TUI,
	manager: ClioKeybindingManager,
	onClose: () => void,
	initialFilter?: string,
	extensionCommands: readonly ExtensionCommandRow[] = [],
	onPick?: (text: string) => void,
	hidden: (command: string) => boolean = () => false,
): OverlayHandle {
	// What Enter puts in the composer for a row, by row id; rows without one open their detail.
	const picks = new Map<string, string>();
	// Commands keep commandReference() order; the group rides as the row's meta.
	const commands: ListOverlayItem[] = commandReference()
		.filter((ref) => !hidden(ref.name))
		.map((ref) => {
			const needsArgument = ref.args?.positionals?.some((positional) => positional.required) === true;
			picks.set(ref.name, `/${ref.name}${needsArgument ? " " : ""}`);
			// Below 80 columns the flags are dropped before the description is cut:
			// `/run [--agent-profile <profile>] …` left nothing of what /run does.
			const { flags, ...withoutFlags } = ref.args ?? {};
			const positionals = ref.args ? compactArgumentHint(withoutFlags) : undefined;
			// The flags fold into one word so the row still says that it takes them.
			const options = flags !== undefined && Object.keys(flags).length > 0 ? " [options]" : "";
			const narrowUsage = `${positionals ? `/${ref.name} ${positionals}` : `/${ref.name}`}${options}`;
			const item: ListOverlayItem = {
				id: ref.name,
				label: `${ref.usage}  ${ref.description}  ${ref.group}`,
				cells: { lead: ref.usage, narrowLead: narrowUsage, text: ref.description },
				group: "Commands",
				meta: ref.group,
				// Overlay key actions are deliberately not duplicated here: each
				// overlay's footer hint is the live source of its keys, and a static
				// copy would rot exactly like the old SLASH_HOTKEYS table did.
				...detailWithHead((width) => {
					const theme = clioTheme();
					const facts: Fact[] = [
						{ label: "Usage", value: theme.fg("inlineCode", ref.usage) },
						{ label: "Does", value: ref.description },
						// The same copy the composer's detail panel shows for each subcommand.
						...Object.entries(ref.subcommandDescriptions ?? {}).map(
							([name, purpose]): Fact => ({ label: `/${ref.name} ${name}`, value: purpose }),
						),
					];
					return {
						head: [titleRow(theme, `/${ref.name}`, width, { meta: ref.group })],
						rest: factRows(theme, facts, width, FACT_OPTIONS),
					};
				}),
			};
			return item;
		});

	// Operator commands carry text an extension author wrote; it is neutralized
	// once here before any row or pane picks it up. The metas are getters so a
	// skin change repaints the chip instead of showing the colors of the skin
	// the help was built under.
	commands.push(
		...displaySafe(extensionCommands).map((row): ListOverlayItem => {
			// The row is one line; the pane's Does fact keeps the description's lines.
			const summary = sanitizeCallTargetText(row.description);
			picks.set(`extension:${row.invocation}`, `/${row.invocation}`);
			return {
				id: `extension:${row.invocation}`,
				label: `/${row.invocation}  ${summary}`,
				cells: { lead: `/${row.invocation}`, text: summary },
				group: "Operator extensions",
				get meta() {
					return row.available ? statusChip(clioTheme(), "ok", "ready") : statusChip(clioTheme(), "warning", "unavailable");
				},
				...detailWithHead((width) => {
					const theme = clioTheme();
					const facts: Fact[] = [
						{ label: "Does", value: row.description },
						{ label: "Owner", value: `${row.extensionId} (${row.scope} scope), operator generation ${row.generation}` },
						{
							label: "Status",
							value: row.available
								? statusChip(theme, "ok", "ready; runs installed operator code and its results stay local to you")
								: statusChip(theme, "warning", row.reason ?? "runtime unavailable"),
						},
					];
					return {
						head: [titleRow(theme, `/${row.invocation}`, width, { meta: "operator extension" })],
						rest: factRows(theme, facts, width, FACT_OPTIONS),
					};
				}),
			};
		}),
	);

	// Editor, selection and viewport primitives are tables inside two topics, and
	// an action with no key and no menu letter is named in the keyboard topic.
	const isPrimitive = (id: string): boolean => /^tui\.(editor|input|select|altScreen)\./u.test(id);
	const isUnbound = (id: Keybinding): boolean =>
		manager.isDisabled(id) || (manager.getKeys(id).length === 0 && !manager.leaderTargets().some((t) => t.id === id));

	const keyItems = (): ListOverlayItem[] => {
		const conflicts = manager.getConflicts();
		const entries = manager.hotkeyEntries().filter((row) => !isPrimitive(row.id) && !isUnbound(row.id));
		const keys: ListOverlayItem[] = entries.map((row) => {
			const formattedKeys = formatKey(manager.fullActionLabel(row.id));
			// A rebound key says so, and a key two actions share carries the warning
			// glyph, so the conflict is visible before the row is opened.
			const hasConflict = conflicts.some((c) => c.keybindings.includes(row.id));
			// The conflict leads, so a narrow row that keeps one chip keeps the warning.
			const metaParts = (): string[] => [
				...(hasConflict ? [statusChip(clioTheme(), "warning", "conflict")] : []),
				...(row.source === "user" ? ["user"] : []),
			];

			const item: ListOverlayItem = {
				id: row.id,
				label: `${formattedKeys}  ${row.description}`,
				cells: { lead: formattedKeys, text: row.description },
				group: "Keys",
				...(row.source === "user" || hasConflict
					? {
							get meta() {
								return metaParts().join(dotSep(clioTheme()));
							},
						}
					: {}),
				detailFormat: "rows",
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

			return item;
		});

		return keys;
	};

	const unboundLine = (): string[] => {
		const names = manager
			.hotkeyEntries()
			.filter((row) => !isPrimitive(row.id) && isUnbound(row.id))
			.map((row) => `\`${row.id}\` (${manager.getDescription(row.id)})`);
		if (names.length === 0) return [];
		return [
			`${names.length} more action${names.length === 1 ? " has" : "s have"} no key; bind one under \`interface.keybindings\`: ${names.join(", ")}.`,
		];
	};

	// A table of primitive keys built from the live bindings, so a rebind shows.
	// The label carries every description, so the filter still finds a key by what it does.
	const primitiveTopic = (id: string, lead: string, text: string, include: (id: string) => boolean): ListOverlayItem => {
		const rows = () => manager.hotkeyEntries().filter((row) => include(row.id));
		return {
			id,
			label: `${lead}  ${text}  ${rows()
				.map((row) => manager.getDescription(row.id))
				.join(" ")}`,
			cells: { lead, text },
			group: "Topics",
			...detailWithHead((width) => {
				const theme = clioTheme();
				const facts: Fact[] = rows().map((row) => ({
					label: formatKey(manager.isDisabled(row.id) ? "(unbound)" : manager.fullActionLabel(row.id)),
					value: `${manager.getDescription(row.id)}${row.source === "user" ? " (user)" : ""}`,
				}));
				return {
					head: [titleRow(theme, lead, width, { meta: "topic" })],
					rest: factRows(theme, facts, width, FACT_OPTIONS),
				};
			}),
		};
	};

	// Static concept topics. Unlike commands and keys these are not generated
	// from a registry; keep each detail consistent with the enforced behavior
	// and with the live footer hints on the surface it documents.
	const topics: ListOverlayItem[] = [
		{
			id: "topic-learning-clio",
			label: "learning clio & tips  Demo guidance: what it teaches, how tips retire, how to turn it off",
			cells: { lead: "learning clio & tips", text: "Demo guidance: what it teaches, how tips retire, how to turn it off" },
			group: "Topics",
			detail: () => [
				"# Learning Clio",
				"**Ask Clio**: questions about Clio itself, such as how to switch models or what workers do, get answered from its own settings and docs.",
				"**Demo guidance** (on by default) teaches as you work: the launchpad, one footer tip at a time, and after some turns a `[tip]` naming a feature that would have helped that turn. A newcomer gets two post-turn tips a session, later one.",
				"**Tips retire**: a tip stops once you use its feature or key, or after a few showings. What you have learned is kept in `harness-profile.json` in Clio's state directory; delete it to start the lessons over.",
				`**Worth knowing**: /model or ${manager.actionLabel("clio-coder.model.select")} picks a model; /run coder <task> hands work to a background worker, and /run coder --read-only <task> one that cannot change files; /library skills browses skills, /skill <name> runs one, and /library installs more; /usage shows quota and spend; /doctor checks the install; ${manager.actionLabel("clio-coder.leader")} y switches this session to YOLO.`,
				"**Turning it off**: Demo guidance in /settings (`interface.demo: false`) for good, or `--no-demo` for one session. The Minimal output style also stays quiet.",
			],
		},
		{
			id: "topic-keyboard-model",
			label: "keyboard model  Alt for actions, Ctrl+G for any terminal, Ctrl for editing",
			cells: { lead: "keyboard model", text: "Alt for actions, Ctrl+G for any terminal, Ctrl for editing" },
			group: "Topics",
			detail: () => [
				"# Keyboard model",
				`Three rules cover every key. Ctrl edits text and talks to the terminal, as in any readline editor. Alt+letter runs a Clio action: ${(
					[
						["clio-coder.model.select", "model"],
						["clio-coder.library.toggle", "library"],
						["clio-coder.output.cycle", "output"],
						["clio-coder.status.toggle", "dashboard"],
						["clio-coder.dispatchBoard.toggle", "workers"],
						["clio-coder.files.toggle", "files"],
						["clio-coder.music.toggle", "music"],
						["clio-coder.message.interrupt", "send now"],
						["clio-coder.queue.open", "queue"],
						["clio-coder.editor.external", "external editor"],
					] as const
				)
					.map(([id, name]) => `${manager.actionLabel(id)} ${name}`)
					.join(", ")}; ${manager.actionLabel("clio-coder.thinking.cycle")} cycles thinking effort.`,
				`${manager.actionLabel("clio-coder.leader")} opens the action menu, and the same letter runs the same action there, so it works in terminals that never deliver Alt. A few actions live only in the menu: d background worker, x dismiss notice, y autonomy. Shift+Tab is t there. Arrows and Enter reach every entry.`,
				"On an empty composer: ? shows the key card, / commands, ! shell, @ a file, left arrow the workers, down arrow the tasks. Esc stops a run; Ctrl+C twice or Ctrl+D exits.",
				"Rebinding a direct key never moves its menu letter. An explicit [] disables both. This help lists your effective keys; settings are never rewritten.",
				...unboundLine(),
			],
		},
		primitiveTopic(
			"topic-editing-keys",
			"editing keys",
			"Cursor, delete, yank, undo and selection keys in the composer and pickers",
			(id) => /^tui\.(editor|input|select)\./u.test(id),
		),
		primitiveTopic(
			"topic-transcript-keys",
			"transcript keys (fullscreen layout)",
			"Scroll, search and jump between prompts in the fullscreen transcript",
			(id) => id.startsWith("tui.altScreen."),
		),
		{
			id: "topic-fleet-runs",
			label: "fleet runs & steering  Inspect, guide, and cancel delegated workers",
			cells: { lead: "fleet runs & steering", text: "Inspect, guide, and cancel delegated workers" },
			group: "Topics",
			detail: () => [
				"# Fleet runs & steering",
				"**Internal helpers**: Scout and other shadow agents appear as Clio → agent cards. Minimal shows identity/status, Default adds the current action while running, and Detailed shows the full worker card. `/view` opens the complete report. Helpers remain inspectable and steerable/cancellable through this board using the same supported actions, without floating fleet cards.",
				`**Workers dock**: in a \`--with-panes\` session ${manager.actionLabel("clio-coder.dispatchBoard.toggle")} shows the workers dashboard beside Clio and moves the keyboard into it: a card per worker of this session, running ones first. Up/Down or j/k select, Enter takes the dock over with that worker's live stream, Esc returns to the cards. q or ${manager.actionLabel("clio-coder.dispatchBoard.toggle")} in the dock hides it and hands the keyboard back; the same key from Clio shows or hides it, and twice within 0.4 s closes it. A takeover of a fleet step or a retried worker moves on to the next step or attempt when it finishes.`,
				`**Fleet Runs board**: /fleet, the left arrow on an empty composer, or ${manager.actionLabel("clio-coder.dispatchBoard.toggle")} in a session without panes. Use Up/Down or j/k to select a live or recent run.`,
				"**Enter**: toggles the inline worker-progress detail on any run, and Esc folds an open detail before it closes the board.",
				"**Watch**: press `w` on a live run in a `--with-panes` session to take the workers dock over for that run (opening it, or bringing back a hidden one, without moving the keyboard); the arrow keys then move it between runs.",
				"**Steer**: press `m` (message) on a live native run to close the board and prefill `@<runId> `. Add guidance and submit it normally. The first notice means queued; a received notice confirms worker delivery.",
				"**Cancel**: press `x` on a running, stale, queued, or retry-waiting run. The row changes to cancelling while the worker or retry is being stopped.",
				"**Capabilities**: ACP delegation runs cannot accept live steering. The board footer only advertises actions supported by the selected row.",
				"**Tasks versus runs**: `/tasks` shows the agent's plan steps. Fleet runs are concrete delegated worker executions and remain in this board as recent terminal history.",
			],
		},
		{
			id: "topic-files-pane",
			label: "panes & files  The files pane, the logs and shell panes, and what closes them",
			cells: { lead: "panes & files", text: "The files pane, the logs and shell panes, and what closes them" },
			group: "Topics",
			detail: () => [
				"# Panes & files",
				"**Where it works**: Clio's own pane host, which bare `clio-coder` opens, or any herdr pane Clio was started in. Outside herdr `/files` still works as a full-screen pick that returns to the composer; `/panes open logs|shell` do not.",
				`**Files pane**: /files or ${manager.actionLabel("clio-coder.files.toggle")} shows Yazi and moves the keyboard into it. Yazi and the host own keys until Ctrl+Y returns selected paths and focus. The same key from Clio focus, or inside Yazi, hides the pane and hands the keyboard back: Yazi keeps running and keeps its directory, and the key brings it back. Tap it twice within 0.4 s to close the pane and end Yazi. /files hide, /files close and /files pick are the explicit forms.`,
				`**Music pane**: ${manager.actionLabel("clio-coder.music.toggle")} or /music shows or hides the focus-radio pane without taking the keyboard, and twice within 0.4 s stops it and closes it. Pressed inside the player, it hides the pane and hands the keyboard back. With integrations.music.enabled on, the pane starts hidden and silent after the first frame, so the first press only reveals it. /music on plays, /music pause silences it and keeps the pane, /music off stops and closes it, /music next skips a station, /music status says what is playing.`,
				"**Hidden panes**: a hidden pane waits in a tab labeled `clio parked` in your herdr workspace and returns to its slot at the share you last gave it. The tab goes away when the last pane leaves it, and `/quit` closes whatever is still parked.",
				"**Picking**: navigate, select with Space for several, then Ctrl+Y (or Enter in pick mode). The paths land in the composer as `@file` mentions and the keyboard returns to the composer.",
				"**Logs and shell**: `/panes open logs` follows the newest dispatched run's journal; `/panes open shell` opens a shell in the workspace. A second open focuses the pane that is already there. `/panes close <name|all>` closes them; `/quit` closes the docks it manages (files, workers, and the music pane, which ends its playback, hidden or not), leaves a shell or logs pane you opened, and prints which panes it left and how to close them.",
				"**Engine**: the files pane runs a vendored file manager installed with `clio-coder tools install yazi`; `clio-coder doctor` and `/panes` say whether it resolved.",
			],
		},
		{
			id: "topic-steering-modes",
			label: "steering modes  Interrupt, next slot, or end of turn: when a message lands mid-run",
			cells: { lead: "steering modes", text: "Interrupt, next slot, or end of turn: when a message lands mid-run" },
			group: "Topics",
			detail: () => [
				"# Steering modes",
				"While Clio is running, the key that submits a message chooses when it lands. The default is next slot.",
				"**Next slot** (Enter): the message is delivered between tool batches, mid-run. The agent keeps going and reads it before its next model call.",
				`**End of turn**: open the queue navigator (${manager.actionLabel("clio-coder.queue.open")}) and press t on a queued message; it then waits until the whole run settles. ACP clients ask for it with mode end-of-turn.`,
				`**Send now** (${manager.actionLabel("clio-coder.message.interrupt")}): settle active work and deliver the draft as a fresh prompt; with an empty draft it flushes the queue. Queued messages stay queued for the new run. While a tool is running you are asked whether to stop it or wait for it.`,
				`**Queue navigator** (${manager.actionLabel("clio-coder.queue.open")}): reorder, edit, remove, change the slot of, or send now any queued message.`,
				"**Interrupt is refused** while an attached dispatch is running (the abort would kill the worker's run with no sealed run record; steer it with `@<agent>` or cancel it with Esc) and while a permission ask is parked (it is already waiting on you). In both cases the message is queued for the next slot and a notice says why.",
				`**Recover queues**: ${manager.actionLabel("clio-coder.queue.open")}, then a puts every queued message back in the composer. Workers accept next-slot steering through @<agent>.`,
			],
		},
		{
			id: "topic-autonomy",
			label: "autonomy & safety net  How the autonomy level and the always-on guardrails interact",
			cells: { lead: "autonomy & safety net", text: "How the autonomy level and the always-on guardrails interact" },
			group: "Topics",
			detail: () => [
				"# Autonomy & safety net",
				"**Tool surface**: which tools exist at all through registration, tool profiles, skill narrowing, and dispatch admission. " +
					"Violations are terminal denials, never approvable.",
				"**Safety net**: the floor (deleting or overwriting /, home or a system tree, mkfs, wipefs, block-device writes, fork bombs, writes into Clio's own state, reads of its credential store) and rules in an approved `.clio-coder/safety.yaml` block at every level; secret and protected paths block at default. " +
					"At default, other damage-control rules ask instead of blocking.",
				"**Mode** (`/settings`, persisted as `safety.autonomy`): default runs workspace edits, and shell commands inside an OS sandbox where the host has one, without asking. " +
					"Commands that leave the sandbox and outward actions are first reviewed by the safety judge, larger dispatch plans ask you, and destructive workspace operations run after a snapshot `/rewind` can undo. Yolo never waits for you and questions take their recommended option. Contained yolo (the default) keeps default's sandbox, snapshots and judge, and refuses what would ask you; unconfined yolo (`safety.yoloConfinement`) skips approvals and the sandbox unless `safety.sandbox` is required. " +
					"Its first activation shows a one-time acceptance card, and it is refused as root outside a container.",
				"**Approvals**: a parked call waits for a one-shot operator decision; approving resumes only that call. " +
					"Workers resolve asks per `fleet.permissions.mode` (Fleet approvals routing in /settings); headless runs deny what the safety judge does not allow.",
				"**Inspecting a mutation**: a parked `write` or `edit` card carries the target, the byte count, and a `sha256` digest of the exact call arguments. " +
					`Press ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} to read the complete proposed content, or the complete effective diff against the file on disk, and ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} again to put it away; ↑/↓ and PgUp/PgDn scroll it. ${permissionKeyLabel(PERMISSION_TERMS_KEY)} opens the standing terms of the decision the same way. ` +
					`Enter still allows and ${permissionKeyLabel(PERMISSION_STOP_KEY)} still stops while either view is open; the action menu also offers x stop, v inspect and t terms while the permission card owns input. Esc closes the view and the card is as it was, and only Esc on the card itself denies. The mutation text is shown locally and never enters the transcript, a notice, a desktop notification, or the render trace. ` +
					"A worker escalation has no preview because the call's arguments never leave the worker, and its card says so.",
			],
		},
	];

	// Task-first entry points. If a spec renames one of these commands, its row changes with it.
	const startHere: ReadonlyArray<{ id: string; task: string; pick?: string }> = [
		{ id: "start-model", task: "Switch model", pick: "/model" },
		{ id: "start-new", task: "Start a new session", pick: "/new" },
		{ id: "start-compact", task: "Free up context", pick: "/compact" },
		{ id: "start-context", task: "See what fills the context", pick: "/context" },
		{ id: "start-rewind", task: "Undo file changes", pick: "/rewind" },
		{ id: "start-run", task: "Hand work to a worker", pick: "/run " },
		{ id: "start-settings", task: "Change a setting", pick: "/settings" },
		{ id: "start-keys", task: "Keys and the action menu" },
	];
	const startItems: ListOverlayItem[] = startHere.map((row) => {
		if (row.pick) picks.set(row.id, row.pick);
		const shown = row.pick?.trim() ?? "keyboard model";
		return { id: row.id, label: `${row.task}  ${shown}`, cells: { lead: row.task, text: shown }, group: "Start here" };
	});

	const allItems = (): ListOverlayItem[] => [...startItems, ...commands, ...keyItems(), ...topics];

	const handle = openListOverlay(tui, {
		markerId: "help",
		title: "Help Center",
		tall: true,
		items: allItems(),
		filterable: true,
		filterPlaceholder: "type to find a command, key or topic",
		exactMatchesOnly: true,
		...(initialFilter ? { initialFilter } : {}),
		hints: (selected) => (selected && picks.has(selected.id) && onPick ? [{ key: "Enter", verb: "use" }] : []),
		onSelect: (item) => {
			const pick = picks.get(item.id);
			if (pick !== undefined && onPick) {
				onClose();
				onPick(pick);
				return;
			}
			if (item.id === "start-keys") {
				handle.clearFilter();
				handle.selectById("topic-keyboard-model");
			}
			handle.openDetail();
		},
		onClose,
	});
	const unsubscribe = manager.onReload(() => handle.setItems(allItems()));
	return {
		...handle,
		hide() {
			unsubscribe();
			handle.hide();
		},
	};
}

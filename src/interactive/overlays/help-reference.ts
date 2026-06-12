import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { ClioKeybindingManager } from "../keybinding-manager.js";
import { commandReference } from "../slash-commands.js";
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
): OverlayHandle {
	const commands: ListOverlayItem[] = commandReference().map((ref) => {
		const usagePart = ref.usage.length >= 30 ? `${ref.usage} ` : ref.usage.padEnd(30);
		const label = `${usagePart}${ref.description}`;
		const item: ListOverlayItem = {
			id: ref.name,
			label,
			group: "Commands",
			// Overlay key actions are deliberately not duplicated here: each
			// overlay's footer hint is the live source of its keys, and a static
			// copy would rot exactly like the old SLASH_HOTKEYS table did.
			detail: () => {
				const lines = [`# Command: /${ref.name}`, `**Usage:** \`${ref.usage}\``, `**Description:** ${ref.description}`];
				if (ref.aliases.length > 0) {
					lines.push(`**Aliases:** ${ref.aliases.map((a) => `/${a}`).join(", ")}`);
				}
				return lines;
			},
		};
		if (ref.aliases.length > 0) {
			item.meta = ref.aliases.join(", ");
		}
		return item;
	});

	const conflicts = manager.getConflicts();
	const keys: ListOverlayItem[] = manager.hotkeyEntries().map((row) => {
		const formattedKeys = formatKey(row.keys);
		const keysPart = formattedKeys.length >= 24 ? `${formattedKeys} ` : formattedKeys.padEnd(24);
		const label = `${keysPart}${row.description}`;

		const item: ListOverlayItem = {
			id: row.id,
			label,
			group: "Keys",
			detail: () => {
				const warnings = manager
					.platformWarnings()
					.filter((w) => w.id === row.id)
					.map((w) => `${w.keys.map(formatKey).join(" / ")} may not fire: ${w.reason}`);
				const detailEntry = {
					id: row.id,
					keys: formattedKeys,
					action: row.description,
					source: row.source,
					warnings,
				};
				return formatKeybindingDetailBodyLines(detailEntry, 100);
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

	// Static concept topics. Unlike commands and keys these are not generated
	// from a registry; keep each detail consistent with the enforced behavior
	// documented in docs/safety-model.md.
	const topics: ListOverlayItem[] = [
		{
			id: "topic-autonomy",
			label: `${"autonomy & safety net".padEnd(30)}How the autonomy level and the always-on guardrails interact`,
			group: "Topics",
			detail: () => [
				"# Autonomy & safety net",
				"**Autonomy level** (`/settings`, persisted as `autonomy`): read-only | suggest | auto-edit | full-auto. " +
					"It sets how much initiative the system prompt asks of the model. It does not loosen or tighten any hard gate.",
				"**Approvals**: actions classified `system_modify`, plus rules marked for confirmation, park the tool call and open a one-shot approval overlay. " +
					"Approving resumes only that call.",
				"**Safety net** (always on, identical at every autonomy level): damage-control rules, default-deny bash with a built-in safe-command allowlist, " +
					"path policy for secrets and system paths, protected artifacts, the loop guard, and dispatch scope checks. " +
					"Tune it in `.clio/safety.yaml`; see docs/safety-model.md.",
			],
		},
	];

	const items = [...commands, ...keys, ...topics];

	return openListOverlay(tui, {
		title: "Help Center",
		mode: "browse",
		items,
		filterable: true,
		...(initialFilter ? { initialFilter } : {}),
		onClose,
	});
}

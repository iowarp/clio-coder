/** Pure library tab metadata; keep this outside the render graph. */

import type { LibraryEntryKind } from "../../domains/resources/index.js";

/** Library kinds in keyboard traversal order. */
export const LIBRARY_TABS: ReadonlyArray<{ id: LibraryEntryKind; label: string }> = [
	{ id: "skill", label: "Skills" },
	{ id: "agent", label: "Agents" },
	{ id: "prompt", label: "Prompts" },
	{ id: "fleet", label: "Fleets" },
	{ id: "plugin", label: "Plugins" },
];

export function isLibraryTab(value: string): value is LibraryEntryKind {
	return LIBRARY_TABS.some((tab) => tab.id === value);
}

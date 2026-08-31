/**
 * The Skills Hub's tab table.
 *
 * It sits in its own module rather than inside `skills-hub.ts` because the slash
 * registry parses `/library <kind>` against it, and the registry has to stay off
 * the render module graph. Pulling the whole hub overlay in for four ids made
 * `src/cli/run.ts` a second, disjoint reacher of the interactive theme and
 * `src/engine/tui.ts`, which splits the merged chunk the Stage 0 instant shell
 * depends on. See `tests/contracts/instant-shell-import-graph.test.ts`.
 *
 * Pure data plus its membership test: no rendering, no overlay state.
 * `skills-hub.ts` re-exports both symbols, so every existing importer keeps the
 * path it had.
 */

import type { LibraryEntryKind } from "../../domains/resources/index.js";

/** The hub's tabs, in the order ←/→ walks them. `skill` is the original view. */
export const LIBRARY_TABS: ReadonlyArray<{ id: LibraryEntryKind; label: string }> = [
	{ id: "skill", label: "Skills" },
	{ id: "agent", label: "Agents" },
	{ id: "prompt", label: "Prompts" },
	{ id: "fleet", label: "Fleets" },
];

export function isLibraryTab(value: string): value is LibraryEntryKind {
	return LIBRARY_TABS.some((tab) => tab.id === value);
}

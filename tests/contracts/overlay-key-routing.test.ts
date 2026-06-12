import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type OverlayKeyDeps, type OverlayState, routeOverlayKey } from "../../src/interactive/index.js";

const ESC = "\x1b";

/**
 * routeOverlayKey is the seam where BT04-1 regressed: the Skills Hub state
 * was added (71c3e53) without joining the list-overlay routing union from
 * 7cae8fe, so every hub key fell through to the dispatch-board branch and was
 * swallowed. These tests pin the contract for every list overlay: all input
 * including Esc is forwarded to the focused ListOverlay (return false). The
 * kit owns Esc so a first Esc can clear a nonempty filter before a second
 * Esc closes (bt-06 finding 2); router-level Esc interception bypassed that.
 */

const LIST_OVERLAY_STATES: ReadonlyArray<OverlayState> = ["help", "agents", "prompts", "extensions", "skills-hub"];

function makeDeps(): { deps: OverlayKeyDeps; closed: () => number; shutdowns: () => number } {
	let closeCount = 0;
	let shutdownCount = 0;
	const deps = {
		closeOverlay: () => {
			closeCount += 1;
		},
		requestShutdown: () => {
			shutdownCount += 1;
		},
	} as unknown as OverlayKeyDeps;
	return { deps, closed: () => closeCount, shutdowns: () => shutdownCount };
}

const neverMatches = () => false;

describe("list-overlay key routing", () => {
	for (const state of LIST_OVERLAY_STATES) {
		it(`forwards typing, arrows, Enter, and action keys to the ${state} overlay`, () => {
			const { deps, closed } = makeDeps();
			for (const key of ["t", "\x1b[A", "\x1b[B", "\r", "i", "\t"]) {
				strictEqual(
					routeOverlayKey(key, state, deps, neverMatches),
					false,
					`${JSON.stringify(key)} must reach the focused ListOverlay in ${state}`,
				);
			}
			strictEqual(closed(), 0, "no key except Esc closes the overlay");
		});

		it(`forwards Esc to the ${state} overlay so the kit can clear a filter before closing`, () => {
			const { deps, closed } = makeDeps();
			strictEqual(routeOverlayKey(ESC, state, deps, neverMatches), false);
			strictEqual(closed(), 0, "close happens through the ListOverlay's onClose, not the router");
		});
	}

	it("skills-hub no longer falls through to the key-swallowing dispatch-board branch (BT04-1)", () => {
		const { deps, closed } = makeDeps();
		// Before the fix this returned true (input swallowed, hub dead).
		strictEqual(routeOverlayKey("t", "skills-hub", deps, neverMatches), false);
		strictEqual(closed(), 0);
	});
});

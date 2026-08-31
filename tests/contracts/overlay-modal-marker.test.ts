/**
 * A modal overlay owning the keyboard is a fact about the pane, and the pane
 * has to be able to say it out loud.
 *
 * Nothing outside the process can see that a Clio overlay has taken the keys.
 * An external driver writing into the pane, and herdr deciding whether the pane
 * is idle, working, or blocked on a human, both read the pane rather than the
 * process, so keystrokes meant for the composer land in a settings list and a
 * controller waiting for idle wakes into a modal. Clio's answer is an OSC 0
 * terminal title, published for exactly as long as a modal is up.
 *
 * That title is a machine interface with a consumer outside this repo, so this
 * file pins the whole of it: the grammar, the transitions on open and close,
 * and the stacked case where one modal opens on top of another. The consumer:
 *
 *   repo:  ~/tools/herdr (branch clio-coder-agent)
 *   path:  src/detect/manifests/clio-coder.toml
 *   rule:  region = "osc_title"
 *
 * herdr has no IPC channel into Clio. Changing the grammar here without
 * changing the manifest rule in the same change set silently un-blinds it.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import {
	formatModalMarkerTitle,
	MODAL_MARKER_BASE_TITLE,
	MODAL_MARKER_TITLE_PATTERN,
	modalMarkerStack,
	parseModalMarkerTitle,
	resetModalMarker,
} from "../../src/interactive/modal-marker.js";
import { showClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import { openListOverlay } from "../../src/interactive/overlays/list-overlay.js";

const HERDR_MANIFEST = "~/tools/herdr/src/detect/manifests/clio-coder.toml";

/**
 * Every marker id Clio publishes, one per modal surface. They deliberately
 * match the `OverlayState` vocabulary the key router already uses, so a marker
 * read off a pane maps one-to-one onto the state that produced it.
 */
const MARKER_IDS = [
	"agents",
	"ask-user",
	"auth",
	"context-reset",
	"context-view",
	"cost",
	"cwd-fallback",
	"decisions",
	"dispatch-board",
	"extensions",
	"fleet-run-approval",
	"handoff-review",
	"help",
	"interop",
	"library-install",
	"memory",
	"message-picker",
	"model",
	"model-scope",
	"permission-confirm",
	"prompts",
	"resume",
	"settings",
	"side-question",
	"skills-hub",
	"tasks",
	"tree",
	"view",
] as const;

function contract(detail: string): string {
	return [
		`modal marker contract broken: ${detail}`,
		`consumer: ${HERDR_MANIFEST}, rule region "osc_title"`,
		"herdr and any external pane driver read this title to know a modal owns the keyboard.",
		"Changing the grammar requires a coordinated herdr manifest update in the same change set.",
	].join("\n  ");
}

/** A TUI whose terminal records every title Clio writes, in order. */
function markerTui(): { tui: TUI; titles: string[] } {
	const titles: string[] = [];
	const live = new Set<object>();
	const tui = {
		terminal: {
			rows: 40,
			columns: 120,
			setTitle(title: string): void {
				titles.push(title);
			},
		},
		showOverlay(_component: Component, _options?: OverlayOptions): OverlayHandle {
			const token = {};
			live.add(token);
			let hidden = false;
			return {
				hide: (): void => void live.delete(token),
				setHidden: (next: boolean): void => {
					hidden = next;
				},
				isHidden: () => hidden,
				focus: () => {},
				unfocus: () => {},
				isFocused: () => live.has(token),
			};
		},
		requestRender(): void {},
	} as unknown as TUI;
	return { tui, titles };
}

const body = (): Component => ({ render: () => ["body"], invalidate: () => {} });

function openFrame(tui: TUI, markerId: string): OverlayHandle {
	return showClioOverlayFrame(tui, body(), { anchor: "center", width: 40, markerId, title: markerId });
}

describe("contracts/overlay modal marker", () => {
	afterEach(() => resetModalMarker());

	// ── grammar ────────────────────────────────────────────────────────────────

	it("pins the title grammar an external reader matches", () => {
		strictEqual(MODAL_MARKER_BASE_TITLE, "clio", contract("the base title moved"));
		strictEqual(formatModalMarkerTitle([]), "clio", contract("an empty stack no longer clears the marker"));
		strictEqual(
			formatModalMarkerTitle(["permission-confirm"]),
			"clio [modal:permission-confirm]",
			contract("the single-modal title moved"),
		);
		strictEqual(
			formatModalMarkerTitle(["settings", "keybinding-detail", "library-install"]),
			"clio [modal:library-install+2]",
			contract("the stacked title moved"),
		);
	});

	it("keeps the base title outside the marker pattern so absence is a positive statement", () => {
		strictEqual(MODAL_MARKER_TITLE_PATTERN.test("clio"), false, contract("the base title now reads as a modal"));
		strictEqual(parseModalMarkerTitle("clio"), null, contract("the base title now parses as a modal"));
		deepStrictEqual(parseModalMarkerTitle("clio [modal:ask-user]"), { id: "ask-user", depth: 1 });
		deepStrictEqual(parseModalMarkerTitle("clio [modal:library-install+2]"), { id: "library-install", depth: 3 });
	});

	it("keeps every id Clio ships matchable by the pattern it publishes them under", () => {
		// The full set of marker ids, which is the vocabulary the detector's rule
		// is written against. An id the pattern cannot match names a modal that is
		// invisible to the reader it exists for.
		for (const id of MARKER_IDS) {
			const title = formatModalMarkerTitle([id]);
			strictEqual(MODAL_MARKER_TITLE_PATTERN.test(title), true, contract(`${title} is not matchable`));
			strictEqual(parseModalMarkerTitle(title)?.id, id, contract(`${title} does not read back as ${id}`));
		}
	});

	// ── open and close ─────────────────────────────────────────────────────────

	it("writes nothing until the first modal, so a pane with no overlay keeps its own title", () => {
		const { titles } = markerTui();
		deepStrictEqual(titles, [], contract("Clio claimed the terminal title before any modal opened"));
	});

	it("signals on open and clears on close", () => {
		const { tui, titles } = markerTui();

		const handle = openFrame(tui, "settings");
		deepStrictEqual(modalMarkerStack(), ["settings"]);
		deepStrictEqual(titles, ["clio [modal:settings]"], contract("opening a modal did not publish the marker"));

		handle.hide();
		deepStrictEqual(modalMarkerStack(), []);
		deepStrictEqual(titles, ["clio [modal:settings]", "clio"], contract("closing a modal left the marker on the title"));
	});

	it("is idempotent on a second close", () => {
		const { tui, titles } = markerTui();
		const handle = openFrame(tui, "settings");
		handle.hide();
		handle.hide();
		deepStrictEqual(titles, ["clio [modal:settings]", "clio"], contract("a repeated close republished the title"));
	});

	// ── stacking ───────────────────────────────────────────────────────────────

	it("names the modal that owns the keys and counts the ones beneath it", () => {
		const { tui, titles } = markerTui();

		const settings = openFrame(tui, "settings");
		const detail = openFrame(tui, "keybinding-detail");
		const confirm = openFrame(tui, "library-install");

		deepStrictEqual(modalMarkerStack(), ["settings", "keybinding-detail", "library-install"]);
		strictEqual(
			titles.at(-1),
			"clio [modal:library-install+2]",
			contract("a modal opened over two others did not name itself as the owner"),
		);

		confirm.hide();
		strictEqual(titles.at(-1), "clio [modal:keybinding-detail+1]", contract("unwinding did not restore the owner"));
		detail.hide();
		strictEqual(titles.at(-1), "clio [modal:settings]", contract("unwinding did not restore the last modal"));
		settings.hide();
		strictEqual(titles.at(-1), "clio", contract("the last close did not clear the marker"));
	});

	it("keeps the top modal when one underneath it closes first", () => {
		const { tui, titles } = markerTui();
		const under = openFrame(tui, "settings");
		openFrame(tui, "keybinding-detail");

		under.hide();

		deepStrictEqual(modalMarkerStack(), ["keybinding-detail"]);
		strictEqual(
			titles.at(-1),
			"clio [modal:keybinding-detail]",
			contract("closing a buried modal moved the owner instead of just shrinking the stack"),
		);
	});

	it("drops the claim while a modal is hidden and takes it back on focus", () => {
		// The skills hub hides its frame to shell out to a child process, which
		// hands the keyboard to that child. A hidden overlay is out of the engine's
		// focus order, so it must stop claiming the keys without leaving the stack.
		const { tui, titles } = markerTui();
		const handle = openFrame(tui, "skills-hub");

		handle.setHidden(true);
		strictEqual(titles.at(-1), "clio", contract("a hidden modal kept claiming the keyboard"));
		deepStrictEqual(modalMarkerStack(), []);

		handle.focus();
		strictEqual(titles.at(-1), "clio [modal:skills-hub]", contract("a refocused modal did not retake the marker"));
		deepStrictEqual(modalMarkerStack(), ["skills-hub"]);
	});

	// ── real openers ───────────────────────────────────────────────────────────

	it("marks the ask_user overlay, the modal a driver most needs to see", () => {
		const { tui, titles } = markerTui();

		const session = openAskUserOverlay(tui, { onCancel: () => {} });
		strictEqual(titles.at(-1), "clio [modal:ask-user]", contract("the ask_user overlay published no marker"));

		session.close();
		strictEqual(titles.at(-1), "clio", contract("the ask_user overlay left its marker behind"));
	});

	it("marks a list overlay under its own surface id, not its rendered title or active tab", () => {
		const { tui, titles } = markerTui();

		const handle = openListOverlay(tui, {
			markerId: "agents",
			title: "Agents Reference",
			items: [],
			onClose: () => {},
		});
		strictEqual(titles.at(-1), "clio [modal:agents]", contract("a list overlay published no marker"));

		handle.hide();
		strictEqual(titles.at(-1), "clio", contract("a list overlay left its marker behind"));
	});
});

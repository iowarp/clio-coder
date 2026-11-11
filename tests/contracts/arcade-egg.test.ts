import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isArcadeTrigger } from "../../src/domains/session/easter-eggs.js";
import { createArcadeState, steerArcade, tickArcade } from "../../src/interactive/arcade-game.js";
import { arcadeSize, openArcadeOverlay, renderArcade } from "../../src/interactive/arcade-overlay.js";

describe("arcade egg", () => {
	it("opens only on its trigger phrase", () => {
		assert.equal(isArcadeTrigger("Insert coin!"), true);
		assert.equal(isArcadeTrigger("  clio,  insert coin. "), true);
		assert.equal(isArcadeTrigger("please insert coin into the parser"), false);
	});

	it("moves the player, stops at walls and turns when the way opens", () => {
		const state = createArcadeState(["#####", "#. P#", "#####"]);
		assert.equal(state.player.facing, "left");
		tickArcade(state);
		assert.deepEqual([state.player.x, state.player.y], [2, 1]);
		steerArcade(state, "up");
		tickArcade(state);
		// Up is a wall: the turn waits and the player keeps going left.
		assert.deepEqual([state.player.x, state.player.y], [1, 1]);
		assert.equal(state.player.next, "up");
		tickArcade(state);
		assert.deepEqual([state.player.x, state.player.y], [1, 1]);
	});

	it("eats bugs and issues, and wins when none are left", () => {
		const state = createArcadeState(["######", "#*.P #", "######"]);
		assert.equal(state.remaining, 2);
		tickArcade(state);
		assert.equal(state.score, 10);
		assert.equal(state.status, "playing");
		tickArcade(state);
		assert.equal(state.score, 60);
		assert.equal(state.status, "won");
	});

	it("loses when a gate ghost catches the player", () => {
		const walk = createArcadeState(["######", "#1 P.#", "######"]);
		tickArcade(walk);
		assert.equal(walk.status, "playing");
		tickArcade(walk); // the player walks into the ghost's cell
		assert.equal(walk.status, "lost");
		const chase = createArcadeState(["#######", "#1  P.#", "#######"]);
		tickArcade(chase);
		tickArcade(chase); // the ghost steps onto the player on its move
		assert.equal(chase.status, "lost");
		assert.equal(chase.ghosts[0]?.label, "CI");
		assert.equal(tickArcade(chase), "lost");
	});

	it("shows a one-line notice in a terminal smaller than the maze", () => {
		const size = arcadeSize();
		const lines = renderArcade(createArcadeState(), size.columns - 1, size.rows);
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /needs a \d+x\d+ terminal/);
		assert.equal(renderArcade(createArcadeState(), size.columns, size.rows).length, size.rows);
	});

	it("opens over the TUI and closes on q with its clock stopped", () => {
		const shown: { component: { handleInput?(data: string): void; render(width: number): string[] }; hidden: boolean }[] =
			[];
		const timers = new Set<number>();
		let closed = 0;
		const tui = {
			terminal: { columns: 80, rows: 30 },
			requestRender: () => {},
			showOverlay: (component: never) => {
				const entry = { component, hidden: false };
				shown.push(entry);
				return {
					hide: () => {
						entry.hidden = true;
					},
					setHidden: () => {},
					isHidden: () => entry.hidden,
					focus: () => {},
					unfocus: () => {},
					isFocused: () => !entry.hidden,
					getBounds: () => undefined,
				};
			},
		};
		const session = openArcadeOverlay(tui as never, {
			onClose: () => closed++,
			setInterval: (() => {
				timers.add(1);
				return 1;
			}) as never,
			clearInterval: ((id: number) => timers.delete(id)) as never,
		});
		assert.equal(session.isOpen(), true);
		assert.equal(shown.length, 1);
		assert.equal(timers.size, 1);
		assert.equal(shown[0]?.component.render(80).length, 30);
		shown[0]?.component.handleInput?.("w");
		shown[0]?.component.handleInput?.("q");
		assert.equal(session.isOpen(), false);
		assert.equal(shown[0]?.hidden, true);
		assert.equal(timers.size, 0);
		assert.equal(closed, 1);
		session.close();
		assert.equal(closed, 1);
	});
});

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { autoPacingAllowed, resolveSmoothStreamingMode } from "../../src/interactive/stream-pacing-policy.js";

describe("stream pacing policy", () => {
	it("gives valid process overrides precedence and makes invalid values fail off", () => {
		deepStrictEqual(
			[undefined, "0", "off", "auto", "1", "on", "unexpected"].map((value) =>
				resolveSmoothStreamingMode("auto", value === undefined ? {} : { CLIO_CODER_SMOOTH_STREAM: value }),
			),
			["auto", "off", "off", "auto", "on", "on", "off"],
		);
	});

	it("admits auto only for a local capable TTY with no accessibility or output risk", () => {
		const base = { isTTY: true, term: "xterm-256color", backpressureObserved: false };
		strictEqual(autoPacingAllowed(base), true);
		for (const unsafe of [
			{ isTTY: false },
			{ term: "dumb" },
			{ sshConnection: "host" },
			{ sshTty: "/dev/pts/1" },
			{ tmux: "/tmp/tmux" },
			{ sty: "screen" },
			{ ci: "1" },
			{ reducedMotion: "1" },
			{ screenReader: "1" },
			{ backpressureObserved: true },
		]) {
			strictEqual(autoPacingAllowed({ ...base, ...unsafe }), false, JSON.stringify(unsafe));
		}
	});
});

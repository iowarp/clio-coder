import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { quotaMeter } from "../../src/interactive/quota-view.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { footerState } from "../harness/footer-fixture.js";

test("status and quota meters use bounded semantic cells at release widths", () => {
	for (const width of [60, 80, 120, 200]) {
		const state = footerState();
		state.resources = {
			scope: "local OS",
			sampledAt: state.now,
			cpuPercent: 150,
			processRssBytes: 1024 ** 3,
			hostFreeBytes: 3 * 1024 ** 3,
			hostTotalBytes: 4 * 1024 ** 3,
			network: null,
			disk: null,
			gpu: null,
		};
		const lines = renderDashboardPage(state, "Status", width, 240, "Alt+U");
		const plain = lines.map(stripTerminalSequences);
		const cpu = plain.find((line) => /\bCPU\b/u.test(line));
		const ram = plain.find((line) => /\bRAM\b/u.test(line));
		ok(cpu && ram, `${width}: CPU and RAM remain visible`);
		match(cpu, new RegExp(`${GLYPH.meterFull}{10}`));
		match(ram, new RegExp(`${GLYPH.meterFull}{3}${GLYPH.meterEmpty}{7}`));
		match(plain.join("\n"), new RegExp(`${GLYPH.next} close`));
		for (const line of lines) {
			ok(visibleWidth(line) <= width);
			for (const escapeTail of line.split(String.fromCharCode(27)).slice(1))
				ok(/^\[[0-9;]*m/u.test(escapeTail), "only SGR escapes are allowed");
		}
		const quota = quotaMeter(50, 10);
		strictEqual(stripTerminalSequences(quota), `${GLYPH.meterFull.repeat(5)}${GLYPH.meterEmpty.repeat(5)}`);
	}
});

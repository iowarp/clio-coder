/**
 * Yazi DDS stdout is a four-field line protocol whose JSON body may contain
 * commas. These contracts use the pinned release transcript and drive the
 * bounded poll-tail reader without launching Yazi.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createYaziEventStream, parseYaziEventLine, type YaziEvent } from "../../src/domains/mux/yazi/event-stream.js";

const CD = 'cd,1788144910603600,1788144910603600,{"tab":1,"url":"/tmp/work, with comma"}';
const PICK = 'clio-pick,1788144910603600,1788144912100146,["pick-token","/tmp/a b.txt","/tmp/c.rs"]';

describe("contracts/yazi DDS stream", () => {
	let scratch: string;

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-yazi-stream-"));
	});

	after(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("parses the pinned four-field transcript without splitting commas inside JSON", () => {
		deepStrictEqual(parseYaziEventLine(CD), {
			kind: "cd",
			receiver: "1788144910603600",
			sender: "1788144910603600",
			tab: "1",
			cwd: "/tmp/work, with comma",
		});
		deepStrictEqual(parseYaziEventLine(PICK), {
			kind: "clio-pick",
			receiver: "1788144910603600",
			sender: "1788144912100146",
			values: ["pick-token", "/tmp/a b.txt", "/tmp/c.rs"],
		});
		strictEqual(parseYaziEventLine('hover,1,1,{"tab":1,"url":null}'), null);
		strictEqual(parseYaziEventLine("cd,1,1,not-json"), null);
		strictEqual(parseYaziEventLine('clio-pick,1,2,["token",3]'), null);
	});

	it("tails complete lines, retains a partial line, and ignores unknown kinds", async () => {
		const path = join(scratch, "events.stream");
		writeFileSync(path, `${CD}\nhover,1,1,{"tab":1,"url":null}\n${PICK.slice(0, 35)}`);
		const events: YaziEvent[] = [];
		let now = 100;
		const stream = createYaziEventStream({
			path,
			onEvent: (event) => events.push(event),
			isAlive: () => true,
			now: () => (now += 1),
			autoStart: false,
		});
		await stream.poll();
		strictEqual(events.length, 1);
		appendFileSync(path, `${PICK.slice(35)}\ncd,1,1,not-json\n`);
		await stream.poll();
		deepStrictEqual(
			events.map((event) => event.kind),
			["cd", "clio-pick"],
		);
		deepStrictEqual(stream.stats(), {
			bytesRead: Buffer.byteLength(`${CD}\nhover,1,1,{"tab":1,"url":null}\n${PICK}\ncd,1,1,not-json\n`),
			linesRead: 2,
			malformedLines: 1,
			lastLineAt: 102,
			stopReason: null,
		});
		stream.stop();
		strictEqual(await stream.done, "stopped");
	});

	it("stops once for a vanished pane, missing file, and size cap", async () => {
		const path = join(scratch, "stop.stream");
		writeFileSync(path, "");
		const paneGone = createYaziEventStream({
			path,
			onEvent: () => {},
			isAlive: () => false,
			autoStart: false,
		});
		await paneGone.poll();
		strictEqual(await paneGone.done, "pane-gone");

		const missing = createYaziEventStream({
			path: join(scratch, "absent.stream"),
			onEvent: () => {},
			isAlive: () => true,
			autoStart: false,
		});
		await missing.poll();
		strictEqual(await missing.done, "file-missing");

		writeFileSync(path, "12345");
		const capped = createYaziEventStream({
			path,
			onEvent: () => {},
			isAlive: () => true,
			maxBytes: 4,
			autoStart: false,
		});
		await capped.poll();
		strictEqual(await capped.done, "size-cap");
		strictEqual(capped.stats().bytesRead, 0);
	});
});

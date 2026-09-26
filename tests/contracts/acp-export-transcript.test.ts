import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { writeTranscriptExport } from "../../src/domains/session/transcript-export.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const refuse = (member: string) =>
	new Proxy(
		{},
		{
			get() {
				throw new Error(`test host: ${member} was reached`);
			},
		},
	);
const readEntries = (sessionId: string) => {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
};
const at = (second: number) => `2026-09-26T09:00:0${second}.000Z`;

async function withSession(body: (root: string, contract: SessionContract, sessionId: string) => Promise<void>) {
	const scratch = await isolateClioEnv("clio-coder-acp-export-");
	const contract: SessionContract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
	try {
		const root = realpathSync(scratch.dir);
		const meta = contract.create({ cwd: root });
		contract.append({ id: "u1", parentId: null, at: at(1), kind: "user", payload: { text: "Compare <b>A</b> & B" } });
		contract.append({
			id: "c1",
			parentId: "u1",
			at: at(2),
			kind: "tool_call",
			payload: { toolCallId: "t1", name: "read", args: { path: "README.md" } },
		});
		contract.append({
			id: "r1",
			parentId: "c1",
			at: at(3),
			kind: "tool_result",
			payload: { toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "B reads 4.2 ```" }] } },
		});
		contract.append({
			id: "a1",
			parentId: "r1",
			at: at(4),
			kind: "assistant",
			payload: {
				text: "A reads 3.1",
				content: [
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "A reads 3.1; B reads 4.2. <script>alert(1)</script>" },
				],
			},
		});
		contract.append({ id: "u2", parentId: "a1", at: at(5), kind: "user", payload: { text: "abandoned question" } });
		contract.switchTurn("a1");
		contract.append({ id: "u3", parentId: "a1", at: at(6), kind: "user", payload: { text: "which is higher?" } });
		contract.append({ id: "a3", parentId: "u3", at: at(7), kind: "assistant", payload: { text: "B is higher." } });
		await contract.checkpoint();
		await body(root, contract, meta.id);
	} finally {
		await contract.close();
		scratch.restore();
	}
}

test("export writes the branch the session is on as escaped HTML with no script, through the command bridge", async () => {
	await withSession(async (root, contract, sessionId) => {
		const control = acpCommandControl({
			dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
			bus: createSafeEventBus(),
			providers: refuse("providers") as AcpCommandHost["providers"],
			exportTranscript: (path?: string) =>
				writeTranscriptExport({
					sessionId,
					leafTurnId: (id) => contract.tree(id).leafId,
					readEntries,
					cwd: root,
					now: () => new Date(2026, 8, 26, 9, 30),
					...(path === undefined ? {} : { path }),
				}),
		});
		assert.ok(control.catalog().commands.some((row) => row.name === "export"));
		const result = await control.invoke({ command: "export", argv: [] });
		assert.equal(result.level, "success", result.lines.join("\n"));
		const expected = join(root, ".clio-coder", "exports", `${sessionId}-2026-09-26.html`);
		assert.match(result.lines.join("\n"), /wrote 2 requests to \.clio-coder\/exports\//);
		assert.ok(existsSync(expected));
		const html = readFileSync(expected, "utf8");
		assert.match(html, /Compare &lt;b&gt;A&lt;\/b&gt; &amp; B/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(html, /<script/i, "the export runs nothing");
		assert.match(html, /which is higher\?/);
		assert.doesNotMatch(html, /abandoned question/, "an abandoned branch is not exported");
		assert.doesNotMatch(html, /private/, "reasoning is noted, not copied");
		assert.match(html, /Reasoning was reported for this reply and is not included/);
		assert.match(html, /B reads 4\.2/);
	});
});

test("export writes Markdown to a named .md path with fences longer than any in the text, and refuses with no session", async () => {
	await withSession(async (root, contract, sessionId) => {
		const report = writeTranscriptExport({
			sessionId,
			leafTurnId: (id) => contract.tree(id).leafId,
			readEntries,
			cwd: root,
			path: "notes/session.md",
		});
		assert.equal(report.text, "wrote 2 requests to notes/session.md");
		const markdown = readFileSync(join(root, "notes", "session.md"), "utf8");
		assert.match(markdown, /^# Clio Coder session /);
		assert.match(
			markdown,
			/````text\nB reads 4\.2 ```\n````/,
			"a result that contains a fence is wrapped in a longer one",
		);
		assert.doesNotMatch(markdown, /abandoned question/);
		assert.deepEqual(writeTranscriptExport({ sessionId: null, leafTurnId: () => null, readEntries, cwd: root }), {
			level: "error",
			text: "no active session to export",
		});
	});
});

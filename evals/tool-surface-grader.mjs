import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const events = readFileSync(process.env.CLIO_CODER_EVAL_RUNNER_STDOUT_FILE, "utf8")
	.split(/\r?\n/u)
	.flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
const starts = events.filter((event) => event.type === "tool_execution_start");
const ends = events.filter((event) => event.type === "tool_execution_end");
function output(call) {
	const end = ends.find((event) => event.toolCallId === call.toolCallId);
	assert.ok(end, "required tool call did not finish");
	return JSON.stringify(end.result);
}
switch (process.argv[2]) {
	case "read-tail": {
		assert.equal(starts.length, 1);
		const call = starts[0];
		assert.equal(call.toolName, "read");
		assert.equal(resolve(call.args.path), resolve("evals/fixtures/tool-surface/read.txt"));
		assert.equal(call.args.tail, 2, "last-line probe must use the advertised tail argument");
		assert.match(output(call), /gamma/u);
		assert.match(output(call), /delta/u);
		assert.doesNotMatch(output(call), /alpha|beta/u);
		break;
	}
	case "bash-cwd-reset": {
		assert.equal(starts.length, 2);
		assert.ok(starts.every((call) => call.toolName === "bash"));
		assert.equal(starts[0].args.command.trim(), "cd evals/fixtures/tool-surface/subdir && pwd");
		assert.equal(starts[1].args.command.trim(), "pwd");
		assert.equal(starts[1].args.cwd, undefined);
		assert.ok(output(starts[0]).includes(resolve("evals/fixtures/tool-surface/subdir")));
		assert.ok(output(starts[1]).includes(process.cwd()));
		assert.ok(!output(starts[1]).includes("/tool-surface/subdir"));
		break;
	}
	case "web-fetch-scheme": {
		const calls = starts.filter((call) => !(call.toolName === "gateway" && ["find", "describe"].includes(call.args.op)));
		assert.equal(calls.length, 1);
		const call = calls[0];
		const viaGateway = call.toolName === "gateway" && call.args.op === "call" && call.args.capability === "web_fetch";
		assert.ok(call.toolName === "web_fetch" || viaGateway);
		assert.equal((viaGateway ? call.args.args : call.args).url, "file:///tool-surface-fixture");
		assert.equal(ends.find((end) => end.toolCallId === call.toolCallId)?.isError, true);
		assert.match(output(call), /(?:unsupported|invalid|only)[\s\S]*(?:scheme|https?)/iu);
		break;
	}
	default:
		throw new Error("unknown tool surface case");
}

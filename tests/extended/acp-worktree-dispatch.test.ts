import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { verifyReceiptFileReport } from "../../src/interactive/view/artifacts.js";
import { mergeWorktreeBranch } from "../../src/tools/task-worktree.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const ACP_WRITER = `
const {writeFileSync}=require("node:fs");
const {join}=require("node:path");
let cwd;
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...message})+"\\n");
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const request=JSON.parse(line);
 if(request.method==="initialize")send({id:request.id,result:{protocolVersion:1}});
 if(request.method==="session/new"){
  cwd=request.params.cwd;
  send({id:request.id,result:{sessionId:"worktree-fixture"}});
 }
 if(request.method==="session/prompt"){
  if(process.env.CLIO_ACP_TEST_SECRET!=="fixture-only")throw Error("missing explicit environment reference");
  writeFileSync(join(cwd,"proof.txt"),"HELLO");
  send({method:"session/update",params:{sessionId:"worktree-fixture",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Created proof.txt"}}}});
  send({id:request.id,result:{stopReason:"end_turn"}});
 }
});
`;

let root: string;
let previousSecret: string | undefined;
beforeEach(async () => {
	await isolateDispatchState();
	previousSecret = process.env.CLIO_ACP_TEST_SECRET;
	process.env.CLIO_ACP_TEST_SECRET = "fixture-only";
	root = mkdtempSync(join(tmpdir(), "clio-acp-worktree-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(root, "base.txt"), "base\n");
	git("add", "base.txt");
	git("commit", "-qm", "base");
});
afterEach(() => {
	if (previousSecret === undefined) delete process.env.CLIO_ACP_TEST_SECRET;
	else process.env.CLIO_ACP_TEST_SECRET = previousSecret;
	rmSync(root, { recursive: true, force: true });
	restoreDispatchState();
});

test("ACP worktree dispatch records its branch and changed paths for later merge", { timeout: 20_000 }, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "default";
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{
			id: "acp-writer",
			command: process.execPath,
			args: ["-e", ACP_WRITER],
			env: { CLIO_ACP_TEST_SECRET: "{env:CLIO_ACP_TEST_SECRET}" },
			toolGovernance: "deny-all",
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "acp-writer",
			task: "Create proof.txt",
			cwd: root,

			executionRole: "builder",
			requestOrigin: "user",
			worktree: true,
			apply: "preserve",
		});
		const receipt = await run.finalPromise;
		equal(receipt.outcome, "succeeded");
		ok(receipt.worktree);
		deepStrictEqual(receipt.worktree.changedPaths, ["proof.txt"]);
		equal(receipt.worktree.applied, false);
		equal(readFileSync(join(receipt.worktree.path, "proof.txt"), "utf8"), "HELLO");
		equal(existsSync(join(root, "proof.txt")), false);
		const stateDir = process.env.CLIO_CODER_STATE_DIR;
		ok(stateDir);
		ok(verifyReceiptFileReport(stateDir, run.runId).ok);
		deepStrictEqual(mergeWorktreeBranch(root, receipt.worktree.branch, "fixture"), { ok: true });
		equal(readFileSync(join(root, "proof.txt"), "utf8"), "HELLO");
	} finally {
		await bundle.extension.stop?.();
	}
});

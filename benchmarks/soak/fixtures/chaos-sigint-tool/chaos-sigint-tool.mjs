import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 1. Strict seed validation (integer string only, no partials)
const seedRaw = process.env.CLIO_CODER_CHAOS_SEED;
if (!seedRaw || !/^-?\d+$/u.test(seedRaw)) {
	console.error(`[chaos-sigint-tool] Error: CLIO_CODER_CHAOS_SEED must be a strict integer, got "${seedRaw}"`);
	process.exit(1);
}
const seed = Number(seedRaw);
if (!Number.isSafeInteger(seed)) {
	console.error(`[chaos-sigint-tool] Error: CLIO_CODER_CHAOS_SEED is out of safe integer range: "${seedRaw}"`);
	process.exit(1);
}

// 2. Environment verification
const clioEntry = process.env.CLIO_CODER_ENTRY;
if (!clioEntry) {
	console.error("[chaos-sigint-tool] Error: CLIO_CODER_ENTRY environment variable is required");
	process.exit(1);
}

const stateDir = process.env.CLIO_CODER_STATE_DIR;
if (!stateDir) {
	console.error("[chaos-sigint-tool] Error: CLIO_CODER_STATE_DIR environment variable is required");
	process.exit(1);
}

// 3. Process marker & fixture creation
// Write only the exact compound command to plain-text tool-command.txt so the marker does NOT appear in Clio argv
const processMarker = `clio_chaos_sigint_seed_${seed}_${Date.now()}`;
const toolCommandPath = join(process.cwd(), "tool-command.txt");
const toolCommandContent = `sleep 300; echo ${processMarker}\n`;
writeFileSync(toolCommandPath, toolCommandContent, "utf8");

const prompt = "Read tool-command.txt and pass its exact contents to the bash tool.";

let childProcess = null;

function pgrepMarker(marker) {
	try {
		const stdout = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
		return stdout
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

function cleanupAll() {
	if (childProcess && !childProcess.killed) {
		try {
			childProcess.kill("SIGKILL");
		} catch {
			// ignore
		}
	}
	for (const pidStr of pgrepMarker(processMarker)) {
		const pid = Number.parseInt(pidStr, 10);
		if (Number.isInteger(pid) && pid > 0) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// gone
				}
			}
		}
	}
}

function fail(message) {
	console.error(message);
	cleanupAll();
	process.exit(1);
}

async function waitFor(predicate, timeoutMs, stepMs = 100) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return await predicate();
}

// 4. Spawn node "$CLIO_CODER_ENTRY" with --no-context-files --no-skills run --autonomy full-auto --target "${CLIO_CODER_SOAK_TARGET:-node-a}" --json
let stderrBuffer = "";
const child = spawn(
	process.execPath,
	[
		clioEntry,
		"--no-context-files",
		"--no-skills",
		"run",
		"--autonomy",
		"full-auto",
		"--target",
		process.env.CLIO_CODER_SOAK_TARGET || "node-a",
		"--json",
		prompt,
	],
	{
		env: { ...process.env, CLIO_CODER_STATE_DIR: stateDir },
		stdio: ["ignore", "pipe", "pipe"],
	},
);
childProcess = child;

// Forward nested stdout live so usage folding remains measured
child.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
});

// Capture stderr boundedly
child.stderr.on("data", (chunk) => {
	if (stderrBuffer.length < 100_000) {
		stderrBuffer += chunk.toString("utf8");
	}
});

const exitPromise = new Promise((resolve) => {
	child.on("close", (code, signal) => {
		resolve({ code, signal });
	});
});

// 5. Wait until the tool process truly exists, then send SIGINT to Clio
const toolStarted = await waitFor(() => pgrepMarker(processMarker).length > 0, 30_000);
if (!toolStarted) {
	fail(`[chaos-sigint-tool] Error: tool process with marker ${processMarker} never appeared. stderr:\n${stderrBuffer}`);
}

// Send SIGINT to Clio
child.kill("SIGINT");

// 6. Wait for exit 130
const exitResult = await exitPromise;
const exitCode = exitResult.code !== null ? exitResult.code : exitResult.signal === "SIGINT" ? 130 : -1;

if (exitCode !== 130) {
	fail(
		`[chaos-sigint-tool] Error: expected exit code 130, got code=${exitResult.code}, signal=${exitResult.signal}. stderr:\n${stderrBuffer}`,
	);
}

// 7. Verify marked process/group is gone
const processCleaned = await waitFor(() => pgrepMarker(processMarker).length === 0, 5_000);
const remainingPids = pgrepMarker(processMarker);
const orphanedChildren = remainingPids.length;

if (!processCleaned || orphanedChildren > 0) {
	fail(`[chaos-sigint-tool] Error: orphaned tool children survived SIGINT: PIDs=[${remainingPids.join(", ")}]`);
}

// 8. Inspect the item state for a canceled receipt with exitCode 130 and positive tokenCount
const receiptsDir = join(stateDir, "receipts");
if (!existsSync(receiptsDir)) {
	fail(`[chaos-sigint-tool] Error: state directory receipts folder missing at ${receiptsDir}`);
}

const receiptFiles = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
if (receiptFiles.length === 0) {
	fail("[chaos-sigint-tool] Error: no receipt files found in state directory");
}

let validReceiptFound = false;
for (const file of receiptFiles) {
	try {
		const raw = readFileSync(join(receiptsDir, file), "utf8");
		const receipt = JSON.parse(raw);
		if (receipt && typeof receipt === "object") {
			const outcome = receipt.outcome;
			const rExitCode = receipt.exitCode;
			const tokens = receipt.tokenCount ?? receipt.tokens?.total ?? 0;
			if (outcome === "canceled" && rExitCode === 130 && tokens > 0) {
				validReceiptFound = true;
				break;
			}
		}
	} catch {
		// skip invalid JSON
	}
}

if (!validReceiptFound) {
	fail(
		`[chaos-sigint-tool] Error: item state lacks canceled receipt with exitCode 130 and positive tokenCount. Checked ${receiptFiles.length} receipt files.`,
	);
}

// 9. Emit exactly one final marker: {"type":"clio_soak_chaos","seed":N,"faultInjected":true,"exitCode":130,"orphanedChildren":0}
const finalMarker = {
	type: "clio_soak_chaos",
	seed: seed,
	faultInjected: true,
	exitCode: 130,
	orphanedChildren: 0,
};

console.log(JSON.stringify(finalMarker));
process.exit(0);

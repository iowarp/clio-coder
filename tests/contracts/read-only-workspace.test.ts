import { deepEqual, equal, notDeepEqual, ok, rejects, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// A read-only run or worker leaves the project as it found it (DOG-001): the session-start index refresh, the
// incremental refresh after a file change, the stop-time session timestamp, the `.clio-coder/.gitignore` repair
// and the one-time layout conversion all write `<project>/.clio-coder/`. Each project here is indexed, then drifts
// (a new source file, a deleted ignore file, a legacy `fleets/` layout), so every one of those writers has work
// to do. The read-only session must leave the tree byte-identical, directory mtimes included; the control
// session shows the same writers do run outside the mode. Entering the mode for good is one-way, so the last
// case is the only one that does.
const home = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-read-only-workspace-")));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
const { resetXdgCache } = await import("../../src/core/xdg.js");
resetXdgCache();
const { enterReadOnlyMode, withReadOnlyMode } = await import("../../src/core/read-only-mode.js");
const { ensureProjectIgnore } = await import("../../src/core/project-root.js");
const { createTelemetryHub } = await import("../../src/core/telemetry/hub.js");
const { codemapPath, legacyCodewikiPath, readCodewiki, writeCodewiki } = await import(
	"../../src/domains/context/codewiki/artifact.js"
);
const { coordinateCodewikiExclusive, coordinateCodewikiWrite } = await import(
	"../../src/domains/context/codewiki/coordinator.js"
);
const { createContextBundle } = await import("../../src/domains/context/extension.js");
const { readClioState, writeClioState } = await import("../../src/domains/context/state.js");
const { convertWorkspaceOnce } = await import("../../src/domains/lifecycle/canonical-names.js");
const startCwd = process.cwd();
after(() => {
	process.chdir(startCwd);
	rmSync(home, { recursive: true, force: true });
});

function snapshot(root: string): Record<string, string> {
	const entries: Record<string, string> = { ".": `d:${lstatSync(root).mtimeMs}` };
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = lstatSync(path);
			const key = relative(root, path);
			if (stat.isDirectory()) {
				entries[key] = `d:${stat.mtimeMs}`;
				walk(path);
			} else {
				entries[key] = `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mtimeMs}`;
			}
		}
	};
	walk(root);
	return entries;
}

async function driftedProject(name: string): Promise<string> {
	const ws = join(home, name);
	mkdirSync(join(ws, "src"), { recursive: true });
	writeFileSync(join(ws, "package.json"), '{"name":"fixture","type":"module"}\n');
	writeFileSync(join(ws, "src", "math.ts"), "export function add(a: number, b: number) {\n\treturn a + b;\n}\n");
	const indexedAt = new Date().toISOString();
	const indexed = await coordinateCodewikiWrite(ws, () => ({ kind: "build", cwd: ws, language: "typescript" }), {
		afterCommit: ({ codewiki, fingerprint }, workspace) =>
			writeClioState(workspace, {
				version: 1,
				projectType: codewiki.language,
				fingerprint,
				codewikiVersion: codewiki.version,
				lastIndexedAt: indexedAt,
				lastSessionAt: indexedAt,
			}),
	});
	ok(indexed?.wrote);
	writeFileSync(join(ws, "src", "sub.ts"), "export function sub(a: number, b: number) {\n\treturn a - b;\n}\n");
	unlinkSync(join(ws, ".clio-coder", ".gitignore"));
	mkdirSync(join(ws, ".clio-coder", "fleets"));
	writeFileSync(join(ws, ".clio-coder", "fleets", "review.yaml"), "name: review\n");
	return ws;
}

/** One headless session as a run sees it: start, a file change, stop. */
async function session(ws: string, readOnly: boolean): Promise<void> {
	process.chdir(ws);
	try {
		equal(convertWorkspaceOnce(ws) === null, readOnly);
		ensureProjectIgnore(ws);
		const bus = createTelemetryHub();
		const bundle = createContextBundle({ bus, getContract: () => undefined });
		await bundle.extension.start?.();
		bus.emit("session.started", {} as never);
		bundle.contract.noteFileChanges(["src/sub.ts"], ws);
		await bundle.extension.stop?.();
	} finally {
		process.chdir(startCwd);
	}
}

const indexedSymbols = (ws: string) => (readCodewiki(ws)?.symbols ?? []).map((symbol) => symbol.name).sort();

describe("read-only mode and the project's .clio-coder/", () => {
	it("a read-only session leaves the drifted project byte-identical and every project writer refuses", async () => {
		const ws = await driftedProject("read-only");
		const bare = join(home, "never-indexed");
		mkdirSync(bare);
		const before = snapshot(ws);
		const wiki = readCodewiki(ws);
		const state = readClioState(ws);
		ok(wiki && state);
		await withReadOnlyMode(async () => {
			await session(ws, true);
			equal(await coordinateCodewikiWrite(ws, (current) => ({ kind: "ensure", cwd: ws, current, previous: null })), null);
			await rejects(
				coordinateCodewikiExclusive(ws, () => "ran"),
				/read-only/i,
			);
			throws(() => writeCodewiki(ws, wiki), /read-only/i);
			throws(() => writeClioState(ws, state), /read-only/i);
			// A project never indexed gains no `.clio-coder/` for the lease either.
			equal(
				await coordinateCodewikiWrite(bare, (current) => ({ kind: "ensure", cwd: bare, current, previous: null })),
				null,
			);
			await rejects(
				coordinateCodewikiExclusive(bare, () => "ran"),
				/read-only/i,
			);
		});
		deepEqual(snapshot(ws), before);
		deepEqual(indexedSymbols(ws), ["add"]);
		deepEqual(readdirSync(bare), []);
	});

	it("the same session outside the mode refreshes the index, the state, the ignore file and the layout", async () => {
		const ws = await driftedProject("control");
		const before = snapshot(ws);
		const lastSessionAt = readClioState(ws)?.lastSessionAt;
		await session(ws, false);
		notDeepEqual(snapshot(ws), before);
		deepEqual(indexedSymbols(ws), ["add", "sub"]);
		ok(existsSync(join(ws, ".clio-coder", ".gitignore")));
		ok(existsSync(join(ws, ".clio-coder", "playbooks", "review.yaml")));
		equal(existsSync(join(ws, ".clio-coder", "fleets")), false);
		ok((readClioState(ws)?.lastSessionAt ?? "") > (lastSessionAt ?? ""));
	});

	it("an index write or reset waiting for another holder's lease when the process turns read-only writes nothing", async () => {
		const [writing, resetting] = [await driftedProject("for-good-write"), await driftedProject("for-good-reset")];
		const [writeLock, resetLock] = [writing, resetting].map((ws) => `${legacyCodewikiPath(ws)}.lock`) as [string, string];
		const holder = (pid: number) => `${JSON.stringify({ host: hostname(), pid })}\n`;
		// Another process holds both leases, so each transaction waits for its holder.
		for (const lock of [writeLock, resetLock]) writeFileSync(lock, holder(process.pid));
		const waiting = coordinateCodewikiWrite(writing, (current) => ({
			kind: "ensure",
			cwd: writing,
			current,
			previous: null,
		}));
		const exclusive = coordinateCodewikiExclusive(resetting, (workspace) => {
			rmSync(codemapPath(workspace));
			return "reset";
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		// One synchronous step: the mode begins, one holder releases its lease, and the other exits without
		// releasing, leaving its lease for a waiter to reclaim (a pid above every platform's range is no process).
		enterReadOnlyMode();
		unlinkSync(writeLock);
		writeFileSync(resetLock, holder(2 ** 22 + 1));
		const entered = [writing, resetting].map(snapshot);
		equal(await waiting, null);
		await rejects(exclusive, /read-only/i);
		deepEqual([writing, resetting].map(snapshot), entered);
	});
});

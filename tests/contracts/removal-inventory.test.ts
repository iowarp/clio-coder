/**
 * What the two destructive commands say about what they are removing.
 *
 * `clio reset` with no scope selects `--state` and takes every transcript on the
 * machine. Its help described that root as "sessions, audit, receipts, runs,
 * install metadata", a remembered list that omitted `interviews/`, `scratch/`,
 * and every dispatch artifact added since it was written, and the default scope
 * carried none of the explanatory note `--data` carried.
 *
 * `clio uninstall` removes four roots under the home directory, so every
 * per-project `.clio/` it ever wrote survived it with no inventory, and
 * `--remove-binary` then removed the binary that runs the cleaner.
 *
 * Both fixes read from something real rather than from a second hand-written
 * list, so these cases build real directories and assert against them.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { rootContents } from "../../src/cli/reset.js";
import { projectContextInventory } from "../../src/cli/uninstall.js";

describe("contracts/removal inventory", () => {
	let scratch: string;

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-removal-inventory-"));
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("reads the state root's contents off the disk, including what no help text remembered", () => {
		const state = join(scratch, "state");
		// The skeleton core/init.ts creates, plus the artifacts written later that
		// the help text never learned about.
		for (const sub of ["sessions", "audit", "receipts", "interviews", "scratch"]) {
			mkdirSync(join(state, sub), { recursive: true });
		}
		writeFileSync(join(state, "runs.json"), "[]\n", "utf8");
		writeFileSync(join(state, "dispatch-admission.json"), "{}\n", "utf8");
		writeFileSync(join(state, "install.json"), "{}\n", "utf8");
		mkdirSync(join(state, "sessions", "hash-a", "session-1"), { recursive: true });
		mkdirSync(join(state, "sessions", "hash-b"), { recursive: true });

		const contents = rootContents(state);
		for (const expected of ["interviews/ (0)", "scratch/ (0)", "dispatch-admission.json", "runs.json"]) {
			ok(contents.includes(expected), `${expected} is enumerated: ${contents.join(", ")}`);
		}
		// The count is the entries directly inside, so a root with two projects in
		// it says two rather than reading as one line about "sessions".
		ok(contents.includes("sessions/ (2)"), contents.join(", "));
	});

	it("enumerates nothing for a path that is absent, unreadable, or a file", () => {
		const file = join(scratch, "a-file");
		writeFileSync(file, "x\n", "utf8");
		deepStrictEqual(rootContents(join(scratch, "absent")), []);
		deepStrictEqual(rootContents(file), []);
	});

	it("names every project dir the session metas recorded that still has a .clio/", () => {
		const state = join(scratch, "uninstall-state");
		const kept = join(scratch, "project-kept");
		const cleaned = join(scratch, "project-cleaned");
		mkdirSync(join(kept, ".clio"), { recursive: true });
		mkdirSync(cleaned, { recursive: true });

		const record = (hash: string, session: string, cwd: string): void => {
			const dir = join(state, "sessions", hash, session);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: session, cwd, cwdHash: hash }), "utf8");
		};
		record("hash-kept", "s1", kept);
		// A second session in the same project must not double-count it.
		record("hash-kept", "s2", kept);
		record("hash-cleaned", "s3", cleaned);
		// An unreadable meta beside a readable one still resolves the project.
		const broken = join(state, "sessions", "hash-kept", "s0");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "meta.json"), "{ not json", "utf8");

		const inventory = projectContextInventory(state);
		strictEqual(inventory.storeAbsent, false);
		strictEqual(inventory.recorded, 2, "one project per cwd hash, however many sessions it holds");
		// The project whose .clio/ is already gone has nothing to clean, so it is
		// not listed; the one that still has it is.
		deepStrictEqual(inventory.dirs, [kept]);
	});

	it("says the store was absent rather than reporting an empty inventory", () => {
		// An absent session store and a store that records no surviving .clio/ are
		// different facts with different remedies, and both used to print nothing.
		const inventory = projectContextInventory(join(scratch, "no-state-here"));
		deepStrictEqual(inventory, { recorded: 0, dirs: [], storeAbsent: true });
	});
});

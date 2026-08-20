/**
 * The exit-code and stream contract from docs/exit-codes-and-output.md, checked
 * against the built CLI one invocation at a time.
 *
 * Exit code 2 is a syntax or usage error: an unknown subcommand, an unknown
 * flag, or a missing required positional. Exit 0 is success. Usage text that
 * accompanies an error goes to stderr with it; usage text the operator asked
 * for with `--help` goes to stdout with exit 0.
 *
 * Every case here was a drift found by the v0.3.2 CLI audit. The ones worth
 * naming, because they made a script proceed on a mistake:
 *
 *   - On a home with no trace database, `trace bogus`, `trace sql` with no
 *     query, and `trace phases` with no run id all exited 0. The courtesy
 *     "no trace database yet" path ran before the command was validated, so a
 *     typo succeeded on every fresh install.
 *   - `fleet list` ignored whatever followed it, so `fleet list --bogus` exited
 *     0 with the normal table.
 *   - `extensions` and `skills` printed help and exited 0 when given no
 *     subcommand, while their four siblings exited 2.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TraceStore } from "../../src/domains/observability/trace-store.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

interface ExitCase {
	/** Argv after `clio-coder`. */
	argv: string[];
	code: number;
	/** Which stream must carry the output. The other must be empty. */
	stream: "stdout" | "stderr";
	/** Substring the named stream must contain. */
	contains?: string;
	why: string;
}

/**
 * Cases that need no state beyond an empty scratch home, and that never reach a
 * model. A fresh home is the interesting case for `trace`: it is the one where
 * the no-database path used to swallow every usage error.
 */
const CASES: ExitCase[] = [
	// trace: the command is validated before the database is consulted.
	{
		argv: ["trace", "bogus"],
		code: 2,
		stream: "stderr",
		contains: "unknown trace command: bogus",
		why: "an unknown subcommand is a usage error even with no database",
	},
	{
		argv: ["trace", "sql"],
		code: 2,
		stream: "stderr",
		contains: "requires a SELECT query",
		why: "a missing required positional is a usage error even with no database",
	},
	{
		argv: ["trace", "phases"],
		code: 2,
		stream: "stderr",
		contains: "requires a run id",
		why: "phases needs a run id before it needs a database",
	},
	{ argv: ["trace", "tail"], code: 2, stream: "stderr", contains: "requires a run id", why: "tail needs a run id" },
	{ argv: ["trace", "procs"], code: 2, stream: "stderr", contains: "requires a run id", why: "procs needs a run id" },
	{
		argv: ["trace", "runs"],
		code: 0,
		stream: "stdout",
		contains: "no trace database yet",
		why: "a well-formed command on a state tree nothing has written to is the empty state, not a failure",
	},
	{
		argv: ["trace", "--help"],
		code: 0,
		stream: "stdout",
		contains: "clio-coder trace runs",
		why: "asking for help is not a usage error",
	},

	// fleet: unknown flags are rejected per subcommand, as they are for agents and models.
	{
		argv: ["fleet", "list", "--bogus"],
		code: 2,
		stream: "stderr",
		contains: "list: unknown flag: --bogus",
		why: "list used to ignore whatever followed it",
	},
	{
		argv: ["fleet", "list", "--json"],
		code: 2,
		stream: "stderr",
		contains: "list: unknown flag: --json",
		why: "list has no JSON form, and silently printing the human table for --json is worse than saying so",
	},
	{
		argv: ["fleet", "bogus"],
		code: 2,
		stream: "stderr",
		contains: "unknown subcommand 'bogus'",
		why: "an unknown fleet subcommand",
	},

	// Bare subcommands: a missing required argument is 2, with usage on stderr.
	{ argv: ["extensions"], code: 2, stream: "stderr", contains: "clio-coder extensions", why: "no subcommand given" },
	{ argv: ["skills"], code: 2, stream: "stderr", contains: "clio-coder skills", why: "no subcommand given" },
	{ argv: ["eval"], code: 2, stream: "stderr", why: "no subcommand given" },
	{ argv: ["memory"], code: 2, stream: "stderr", contains: "clio-coder memory", why: "no subcommand given" },
	{ argv: ["evidence"], code: 2, stream: "stderr", contains: "clio-coder evidence", why: "no subcommand given" },
	{ argv: ["usage"], code: 2, stream: "stderr", contains: "clio-coder usage", why: "no subcommand given" },

	// The same six answer --help on stdout with 0, which is the other half of the rule.
	{
		argv: ["extensions", "--help"],
		code: 0,
		stream: "stdout",
		contains: "clio-coder extensions",
		why: "help is not an error",
	},
	{ argv: ["skills", "--help"], code: 0, stream: "stdout", contains: "clio-coder skills", why: "help is not an error" },
	{ argv: ["memory", "--help"], code: 0, stream: "stdout", contains: "clio-coder memory", why: "help is not an error" },
	{
		argv: ["evidence", "--help"],
		code: 0,
		stream: "stdout",
		contains: "clio-coder evidence",
		why: "help is not an error",
	},
	{ argv: ["usage", "--help"], code: 0, stream: "stdout", contains: "clio-coder usage", why: "help is not an error" },

	// Unknown flags on the commands that already got this right, held as a regression fence.
	{
		argv: ["agents", "--bogus"],
		code: 2,
		stream: "stderr",
		contains: "unknown flag: --bogus",
		why: "the shape the other commands were brought in line with",
	},
	{ argv: ["models", "--bogus"], code: 2, stream: "stderr", contains: "unknown flag: --bogus", why: "same" },
	{ argv: ["paths", "--bogus"], code: 2, stream: "stderr", contains: "unknown flag: --bogus", why: "same" },
	{
		argv: ["bogus-command"],
		code: 2,
		stream: "stderr",
		contains: "unknown subcommand",
		why: "an unknown top-level command",
	},
];

describe("contracts/cli exit codes and stream separation", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome();
	});

	afterEach(() => {
		scratch.cleanup();
	});

	for (const testCase of CASES) {
		const label = `clio-coder ${testCase.argv.join(" ")} exits ${testCase.code} on ${testCase.stream}`;
		it(`${label}: ${testCase.why}`, async () => {
			const result = await runCli(testCase.argv, { env: scratch.env });
			const chosen = testCase.stream === "stdout" ? result.stdout : result.stderr;
			const other = testCase.stream === "stdout" ? result.stderr : result.stdout;

			strictEqual(result.code, testCase.code, `stdout=${result.stdout}\nstderr=${result.stderr}`);
			ok(chosen.length > 0, `${testCase.stream} must carry the output: stdout=${result.stdout} stderr=${result.stderr}`);
			strictEqual(other.trim(), "", `the other stream must stay empty, got: ${other}`);
			if (testCase.contains !== undefined) {
				ok(chosen.includes(testCase.contains), `expected ${JSON.stringify(testCase.contains)} in: ${chosen}`);
			}
		});
	}

	describe("against a database that exists", () => {
		let dbPath: string;

		beforeEach(() => {
			// An empty but well-formed trace database. TraceStore writes the schema
			// on construction, which is all these cases need: the point is the path
			// existing, so the courtesy no-database return no longer answers first.
			dbPath = join(scratch.dir, "state", "trace.sqlite");
			const store = new TraceStore(dbPath);
			store.close();
		});

		it("answers trace runs --json with a parseable array", async () => {
			// Documented in docs/exit-codes-and-output.md and rejected by the code:
			// `--json` failed with "unknown trace flag: --json".
			const result = await runCli(["trace", "runs", "--db", dbPath, "--json"], { env: scratch.env });
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			ok(Array.isArray(JSON.parse(result.stdout)), `expected a JSON array, got: ${result.stdout}`);
		});

		it("still prints the human table for trace runs without --json", async () => {
			const result = await runCli(["trace", "runs", "--db", dbPath], { env: scratch.env });
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			ok(result.stdout.startsWith("STATUS"), `expected the table header, got: ${result.stdout}`);
		});

		for (const query of ["DELETE FROM runs", "UPDATE runs SET status='x'", "DROP TABLE runs", "SELEC 1"]) {
			it(`refuses trace sql ${JSON.stringify(query)} as a usage error`, async () => {
				// The refusal always worked and the database was never touched; it
				// exited 1, which reads as "the command failed" rather than "that is
				// not a query this accepts". The contract puts it at 2.
				const result = await runCli(["trace", "sql", "--db", dbPath, query], { env: scratch.env });
				strictEqual(result.code, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
				strictEqual(result.stdout.trim(), "", "a refused query produces no rows on stdout");
			});
		}

		it("runs a read-only trace sql query and prints its rows as JSON", async () => {
			const result = await runCli(["trace", "sql", "--db", dbPath, "SELECT 1 AS n"], { env: scratch.env });
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			deepStrictEqual(JSON.parse(result.stdout), [{ n: 1 }]);
		});
	});
});

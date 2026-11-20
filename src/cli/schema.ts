/**
 * `clio-coder schema <name>` (SPEC 6.3, 6.6, 6.15): print the JSON Schema of one machine-readable document. The
 * schemas ship in the package as `schemas/<name>.json`, so the printed text is the file a consumer can pin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { helpRequested } from "./kit/help.js";
import { writeCliFailure } from "./kit/json-out.js";
import { SCHEMA_NAMES } from "./specs/schema.js";

const SCHEMA_PATH = ["schema"] as const;

const HELP = `clio-coder schema <name>

Print the JSON Schema (draft 2020-12) of one machine-readable document on stdout:

  run-result     the run_end document of run --output-format json|stream-json (schema v2)
  run-events     one line of run --output-format stream-json
  task           the run --task-file envelope (version 1)
  help           the help --json manifest, with the closed set of error slugs
  fleet-result   the fleet_end and fleet_accepted documents of fleet run and fleet wait
`;

export async function runSchemaCommand(args: ReadonlyArray<string>): Promise<number> {
	if (helpRequested(args)) {
		process.stdout.write(HELP);
		return EXIT_CODES.success;
	}
	const flag = args.find((arg) => arg.startsWith("-"));
	if (flag !== undefined) {
		writeCliFailure({ path: SCHEMA_PATH, slug: "unknown_flag", message: `unknown option: ${flag}`, json: false });
		return EXIT_CODES.notStarted;
	}
	// C2: a bare group prints its help on stderr and exits 2.
	if (args.length === 0) {
		process.stderr.write(HELP);
		return EXIT_CODES.notStarted;
	}
	if (args.length > 1) {
		writeCliFailure({ path: SCHEMA_PATH, slug: "usage", message: "takes one schema name", json: false });
		return EXIT_CODES.notStarted;
	}
	const name = args[0] ?? "";
	if (!(SCHEMA_NAMES as ReadonlyArray<string>).includes(name)) {
		writeCliFailure({
			path: SCHEMA_PATH,
			slug: "not_found",
			message: `no schema named ${name}; one of ${SCHEMA_NAMES.join(", ")}`,
			json: false,
		});
		return EXIT_CODES.failed;
	}
	const file = join(resolvePackageRoot(), "schemas", `${name}.json`);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		writeCliFailure({
			path: SCHEMA_PATH,
			slug: "io",
			message: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
			json: false,
		});
		return EXIT_CODES.failed;
	}
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	return EXIT_CODES.success;
}

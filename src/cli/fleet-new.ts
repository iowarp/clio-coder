import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";

const BUILTINS = ["build-review", "build-test", "sdlc"] as const;
const SAFE_STEM = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function usage(message: string): number {
	process.stderr.write(`clio-coder fleet: new: ${message}\n`);
	return 2;
}

export function runFleetNew(args: ReadonlyArray<string>): number {
	const name = args[0];
	const fromIndex = args.indexOf("--from");
	const builtin = fromIndex === -1 ? undefined : args[fromIndex + 1];
	const known = BUILTINS.join(", ");
	if (name === undefined) return usage("usage: clio-coder fleet new <name> --from <builtin>");
	if (!SAFE_STEM.test(name)) return usage(`'${name}' is not a safe file stem`);
	if (fromIndex === -1 || builtin === undefined) return usage("--from <builtin> is required");
	const expected = new Set([name, "--from", builtin]);
	const unknown = args.find((arg) => !expected.has(arg));
	if (unknown !== undefined) return usage(`unknown argument: ${unknown}`);
	if (!(BUILTINS as ReadonlyArray<string>).includes(builtin)) {
		return usage(`unknown builtin '${builtin}'. Known builtins: ${known}`);
	}
	const destination = join(process.cwd(), ".clio-coder", "fleets", `${name}.md`);
	if (existsSync(destination)) return usage(`destination already exists: ${destination}`);
	const source = join(resolvePackageRoot(), "src", "domains", "agents", "fleets", `${builtin}.md`);
	mkdirSync(dirname(destination), { recursive: true });
	const sourceText = readFileSync(source, "utf8");
	const renamed = sourceText.replace(/^name:\s*[^\n]+$/mu, `name: ${name}`);
	writeFileSync(destination, renamed, { flag: "wx" });
	process.stdout.write(`${destination}\n`);
	return 0;
}

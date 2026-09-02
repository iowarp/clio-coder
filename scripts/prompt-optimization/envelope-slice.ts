/**
 * Development-only CLI: exact token cost of named slices inside one tool schema.
 *
 *   node --import tsx scripts/prompt-optimization/envelope-slice.ts \
 *     --request /tmp/clio-prompt-ab-runs/envelope/d7a7fc69-deep.main-full.request.json \
 *     --tool dispatch --url http://192.168.86.143:1234 \
 *     --slice council=properties.roster,properties.members,properties.synthesis
 *
 * `envelope-run --deep` answers "which tool costs what". This answers the next
 * question: *inside* the tool that dominates, which properties cost what. That
 * is the question progressive attachment turns on, because a property the
 * session cannot use is a description for a capability it cannot invoke.
 *
 * A slice is a named set of dotted property paths. Each is removed together and
 * the payload is re-priced, so a slice's number is the exact saving from not
 * attaching it. Slices are priced independently, never cumulatively, unless
 * `--combine` names a set to remove in one go.
 */
import { readFileSync } from "node:fs";
import { probePromptTokens } from "./envelope.js";

interface Slice {
	name: string;
	paths: string[];
}

function parseSlices(argv: readonly string[]): Slice[] {
	const slices: Slice[] = [];
	for (const [index, value] of argv.entries()) {
		if (value !== "--slice") continue;
		const spec = argv[index + 1];
		if (spec === undefined) continue;
		const split = spec.indexOf("=");
		if (split < 0) continue;
		slices.push({
			name: spec.slice(0, split),
			paths: spec
				.slice(split + 1)
				.split(",")
				.filter(Boolean),
		});
	}
	return slices;
}

function flag(argv: readonly string[], name: string, fallback: string): string {
	const at = argv.indexOf(name);
	return at >= 0 && at + 1 < argv.length ? (argv[at + 1] as string) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Delete one dotted path from a schema.
 *
 * `[]` steps into an array's every element, `anyOf[n]` into one union branch,
 * so the duplicated per-task shape inside `tasks.items.anyOf[1]` is addressable
 * separately from its top-level twin. A path that does not exist is reported
 * rather than silently costing zero: an unpriced slice that reads as free is
 * the same silent-plausible-number failure this harness keeps finding.
 */
export function deletePath(root: unknown, path: string): boolean {
	const steps = path.split(".").filter((step) => step.length > 0);
	if (steps.length === 0) return false;
	let cursor: unknown = root;
	for (const step of steps.slice(0, -1)) {
		cursor = descend(cursor, step);
		if (cursor === undefined) return false;
	}
	const last = steps[steps.length - 1] as string;
	const targets = cursor === undefined ? [] : collect(cursor, last);
	let removed = false;
	for (const { holder, key } of targets) {
		if (Array.isArray(holder)) {
			const index = Number(key);
			if (Number.isInteger(index) && index >= 0 && index < holder.length) {
				holder.splice(index, 1);
				removed = true;
			}
			continue;
		}
		if (isRecord(holder) && key in holder) {
			delete holder[key];
			removed = true;
		}
	}
	return removed;
}

function descend(value: unknown, step: string): unknown {
	if (step === "[]") return Array.isArray(value) ? value : undefined;
	const indexed = /^(.+)\[(\d+)\]$/u.exec(step);
	if (indexed !== null) {
		const inner = descend(value, indexed[1] as string);
		return Array.isArray(inner) ? inner[Number(indexed[2])] : undefined;
	}
	if (Array.isArray(value)) {
		// A step applied to an array applies to each element; used for `items`
		// unions where the branch index is not the interesting axis.
		const found = value.map((entry) => descend(entry, step)).filter((entry) => entry !== undefined);
		return found.length === 0 ? undefined : found[0];
	}
	return isRecord(value) ? value[step] : undefined;
}

function collect(cursor: unknown, key: string): Array<{ holder: unknown; key: string }> {
	const indexed = /^(.+)\[(\d+)\]$/u.exec(key);
	if (indexed !== null) {
		const holder = descend(cursor, indexed[1] as string);
		return holder === undefined ? [] : [{ holder, key: indexed[2] as string }];
	}
	if (Array.isArray(cursor)) return cursor.map((entry) => ({ holder: entry, key }));
	return [{ holder: cursor, key }];
}

function toolIn(body: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
	const tools = Array.isArray(body.tools) ? body.tools : [];
	for (const tool of tools) {
		if (!isRecord(tool)) continue;
		const fn = isRecord(tool.function) ? tool.function : tool;
		if (fn.name === name) return fn;
	}
	return undefined;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const requestPath = flag(argv, "--request", "");
	const toolName = flag(argv, "--tool", "dispatch");
	const url = flag(argv, "--url", "http://192.168.86.143:1234");
	const slices = parseSlices(argv);
	if (requestPath === "" || slices.length === 0) {
		throw new Error("usage: --request <captured.json> --tool <name> --slice <name>=<path,path>...");
	}
	const original = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
	const baseline = await probePromptTokens(url, original);
	if (baseline.tokens === null) throw new Error(`baseline probe failed: ${baseline.detail}`);
	process.stdout.write(`baseline prompt_tokens: ${baseline.tokens}\n\n`);

	const combined = argv.includes("--combine");
	const combinedPaths: string[] = [];
	for (const slice of slices) {
		const payload = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
		const fn = toolIn(payload, toolName);
		if (fn === undefined) throw new Error(`tool ${toolName} is not in the captured payload`);
		const missing: string[] = [];
		for (const path of slice.paths) {
			if (!deletePath(fn.parameters, path)) missing.push(path);
		}
		const probe = await probePromptTokens(url, payload);
		const cost = probe.tokens === null ? null : baseline.tokens - probe.tokens;
		process.stdout.write(
			`${slice.name.padEnd(22)} ${String(cost ?? "unmeasured").padStart(6)} tokens` +
				`${missing.length > 0 ? `   MISSING PATHS: ${missing.join(", ")}` : ""}\n`,
		);
		if (combined) combinedPaths.push(...slice.paths);
	}

	if (combined) {
		const payload = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
		const fn = toolIn(payload, toolName);
		if (fn !== undefined) for (const path of combinedPaths) deletePath(fn.parameters, path);
		const probe = await probePromptTokens(url, payload);
		const cost = probe.tokens === null ? null : baseline.tokens - probe.tokens;
		process.stdout.write(`\n${"ALL SLICES TOGETHER".padEnd(22)} ${String(cost ?? "unmeasured").padStart(6)} tokens\n`);
		process.stdout.write(`resulting first-turn total: ${String(probe.tokens ?? "unmeasured")}\n`);
	}
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exitCode = 1;
});

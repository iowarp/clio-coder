#!/usr/bin/env node
/**
 * Knob registry tooling.
 *
 *   node --import tsx scripts/knobs/cli.ts dump [kind]   print what the source tree exposes
 *   node --import tsx scripts/knobs/cli.ts check         hold docs/knobs.yaml against the tree
 *   node --import tsx scripts/knobs/cli.ts render        rewrite docs/knobs.md from the registry
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { checkKnobRegistry } from "./check.js";
import { loadRegistry, REGISTRY_PATH } from "./registry.js";
import { KNOBS_DOC_PATH, renderKnobsDoc } from "./render.js";
import { collectSourceKnobs, kindsInInventory } from "./sources.js";

const root = resolvePackageRoot(import.meta.url);
const [command, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
	if (command === "dump") {
		const registry = loadRegistry(root);
		const inventory = await collectSourceKnobs(root, registry);
		const only = rest.find((arg) => !arg.startsWith("--"));
		if (rest.includes("--json")) {
			process.stdout.write(
				`${JSON.stringify(
					inventory.knobs.filter((k) => !only || k.kind === only),
					null,
					1,
				)}\n`,
			);
			return;
		}
		for (const knob of inventory.knobs) {
			if (only && knob.kind !== only) continue;
			const where = knob.sites.map((s) => `${s.path}:${s.line}`).join(", ");
			const scope = knob.command ?? knob.file ?? knob.source ?? "";
			process.stdout.write(`${knob.kind}\t${scope}\t${knob.name}\t${knob.default ?? ""}\t${where}\n`);
		}
		process.stderr.write(`${JSON.stringify(kindsInInventory(inventory))}\n`);
		if (inventory.unmappedCliFiles.length > 0) {
			process.stderr.write(`unmapped cli files: ${inventory.unmappedCliFiles.join(", ")}\n`);
		}
		return;
	}
	if (command === "check") {
		const errors = await checkKnobRegistry(root);
		for (const error of errors) process.stderr.write(`${error}\n`);
		process.exit(errors.length > 0 ? 1 : 0);
	}
	if (command === "render") {
		const registry = loadRegistry(root);
		const inventory = await collectSourceKnobs(root, registry);
		writeFileSync(join(root, KNOBS_DOC_PATH), renderKnobsDoc(root, registry, inventory));
		process.stdout.write(`wrote ${KNOBS_DOC_PATH} from ${REGISTRY_PATH}\n`);
		return;
	}
	process.stderr.write("usage: knobs/cli.ts dump [kind] | check | render\n");
	process.exit(2);
}

await main();

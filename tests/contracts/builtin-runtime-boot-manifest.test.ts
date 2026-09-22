import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BUILTIN_RUNTIME_BOOT_MANIFEST,
	type RuntimeBootMetadata,
} from "../../src/domains/providers/runtimes/boot-manifest.js";
import { BUILTIN_RUNTIMES } from "../../src/domains/providers/runtimes/builtins.js";

// The boot manifest is a hand-copied projection of the canonical descriptors,
// read before the providers domain is hydrated. The TUI classifies the chat
// target against it, so a runtime missing from the manifest is refused as the
// main agent while headless `run`, which hydrates the full registry, accepts
// it. v0.5.3 shipped `inception` and `typesafe-jev` in exactly that state.
// This test is the drift guard the manifest's own header promised.

function projection(descriptor: {
	id: string;
	aliases?: ReadonlyArray<string>;
	kind: RuntimeBootMetadata["kind"];
	tier?: RuntimeBootMetadata["tier"];
	auth: RuntimeBootMetadata["auth"];
	credentialsEnvVar?: string;
	oauthProviderId?: string;
}): RuntimeBootMetadata {
	const entry: RuntimeBootMetadata = { id: descriptor.id, kind: descriptor.kind, auth: descriptor.auth };
	if (descriptor.aliases && descriptor.aliases.length > 0) entry.aliases = [...descriptor.aliases];
	if (descriptor.tier !== undefined) entry.tier = descriptor.tier;
	if (descriptor.credentialsEnvVar !== undefined) entry.credentialsEnvVar = descriptor.credentialsEnvVar;
	if (descriptor.oauthProviderId !== undefined) entry.oauthProviderId = descriptor.oauthProviderId;
	return entry;
}

function byId(entries: ReadonlyArray<RuntimeBootMetadata>): Map<string, RuntimeBootMetadata> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

describe("builtin runtime boot manifest", () => {
	it("lists every builtin runtime descriptor with the same boot fields", () => {
		const expected = byId(BUILTIN_RUNTIMES.map(projection));
		const actual = byId(BUILTIN_RUNTIME_BOOT_MANIFEST);

		deepStrictEqual(
			[...actual.keys()].sort(),
			[...expected.keys()].sort(),
			"boot manifest ids must match the registered builtin runtime ids",
		);
		for (const [id, descriptor] of expected) {
			deepStrictEqual(actual.get(id), descriptor, `boot manifest entry for ${id} drifted from its descriptor`);
		}
	});

	it("names each runtime once", () => {
		const ids = BUILTIN_RUNTIME_BOOT_MANIFEST.map((entry) => entry.id);
		deepStrictEqual(ids.length, new Set(ids).size);
	});
});

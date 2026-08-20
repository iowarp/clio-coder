import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_RUNTIME_BOOT_MANIFEST } from "../../src/domains/providers/runtimes/boot-manifest.js";
import { BUILTIN_RUNTIMES } from "../../src/domains/providers/runtimes/builtins.js";

describe("the lightweight boot runtime manifest", () => {
	it("is an exact projection of every canonical built-in runtime", () => {
		const project = ({
			id,
			aliases,
			kind,
			tier,
			auth,
			credentialsEnvVar,
			oauthProviderId,
		}: (typeof BUILTIN_RUNTIMES)[number]) => ({
			id,
			...(aliases === undefined ? {} : { aliases }),
			kind,
			...(tier === undefined ? {} : { tier }),
			auth,
			...(credentialsEnvVar === undefined ? {} : { credentialsEnvVar }),
			...(oauthProviderId === undefined ? {} : { oauthProviderId }),
		});
		deepStrictEqual(BUILTIN_RUNTIME_BOOT_MANIFEST, BUILTIN_RUNTIMES.map(project));
	});
});

import { arch, platform, release } from "node:os";
import type { ClientIdentity, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { mergeClientIdentity } from "@earendil-works/pi-ai";
import { readClioVersion } from "../core/package-root.js";

let identity: ClientIdentity | undefined;

/**
 * How Clio introduces itself to providers. Pi 1.4 sends its own `pi/<version>` User-Agent unless a request names
 * an identity, and its Agent attributes OpenRouter, NVIDIA NIM and OpenCode requests to pi. The User-Agent matches
 * the one the openai-codex runtime already sends. Anthropic subscription OAuth keeps Pi's Claude Code headers.
 */
export function clioClientIdentity(): ClientIdentity {
	identity ??= {
		userAgent: { custom: `clio-coder/${readClioVersion()} (${platform()} ${release()}; ${arch()})` },
		attribution: { name: "Clio Coder", url: "https://github.com/iowarp/clio-coder", categories: ["cli-agent"] },
	};
	return identity;
}

/** Clio's identity under a request's own, which still wins field by field. */
export function withClioIdentity<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T {
	return {
		...options,
		identity: mergeClientIdentity(clioClientIdentity(), options?.identity) ?? clioClientIdentity(),
	} as T;
}

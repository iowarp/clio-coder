import type { McpClient, McpTeardownOutcome, McpToolListing } from "./client.js";
import { McpError } from "./protocol.js";

export interface McpConnection {
	readonly ready: Promise<{ client: McpClient; listing: McpToolListing }>;
	close(): Promise<McpTeardownOutcome>;
}

/** PERF W3: retain the connection after discovery and settle only after native group cleanup. */
export function createMcpConnection(options: {
	acquire(): McpClient;
	onAcquired(client: McpClient): void;
	signal: AbortSignal;
}): McpConnection {
	const lifetime = new AbortController();
	let resolveReady!: (value: { client: McpClient; listing: McpToolListing }) => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<{ client: McpClient; listing: McpToolListing }>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const abort = (): void => {
		lifetime.abort();
		release();
	};
	if (options.signal.aborted) abort();
	else options.signal.addEventListener("abort", abort, { once: true });
	const settled = (async (): Promise<McpTeardownOutcome> => {
		let client: McpClient | null = null;
		let failure: unknown;
		let failed = false;
		try {
			if (lifetime.signal.aborted) throw new McpError("aborted", "MCP discovery aborted");
			client = options.acquire();
			options.onAcquired(client);
			await client.initialize(lifetime.signal);
			const listing = await client.listTools(lifetime.signal);
			if (lifetime.signal.aborted) throw new McpError("aborted", "MCP discovery aborted");
			resolveReady({ client, listing });
			await released;
		} catch (error) {
			failed = true;
			failure = error;
		} finally {
			options.signal.removeEventListener("abort", abort);
		}
		const outcome = (await client?.close()) ?? { complete: true };
		// PERF W3: failed readiness cannot report completion before its server is gone.
		if (failed) rejectReady(failure);
		return outcome;
	})();
	return {
		ready,
		close() {
			abort();
			return settled;
		},
	};
}

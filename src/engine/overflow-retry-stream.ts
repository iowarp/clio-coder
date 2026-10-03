import {
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	isContextOverflow,
} from "@earendil-works/pi-ai";

/**
 * Give a request that the server rejected as too large one more attempt. Only
 * an overflow that arrives before any content is retried, since the caller has
 * seen nothing yet; a stream that already produced output is passed through.
 * `recover` builds the retry stream, or returns null when there is nothing to
 * change and the original error should surface instead of a repeated request.
 */
export function retryStreamOnceOnOverflow(
	source: AssistantMessageEventStream,
	recover: () => AssistantMessageEventStream | null,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			let held: AssistantMessageEvent[] | null = [];
			for await (const event of source) {
				if (held === null) {
					output.push(event);
					continue;
				}
				if (event.type === "start") {
					held.push(event);
					continue;
				}
				if (event.type === "error" && isContextOverflow(event.error)) {
					const retry = safeRecover(recover);
					if (retry) {
						for await (const next of retry) output.push(next);
						output.end(await retry.result());
						return;
					}
				}
				for (const pending of held) output.push(pending);
				held = null;
				output.push(event);
			}
			if (held) for (const pending of held) output.push(pending);
			output.end(await source.result());
		} catch {
			// The wrapped streams settle through result(); a defect here must still
			// end the output so the agent loop never waits on a stream nobody closes.
			output.end(await source.result().catch(() => undefined));
		}
	})();
	return output;
}

function safeRecover(recover: () => AssistantMessageEventStream | null): AssistantMessageEventStream | null {
	try {
		return recover();
	} catch {
		// A failed projection leaves the original overflow as the run's error.
		return null;
	}
}

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/**
 * Give a request the provider rejected for an expired credential one more
 * attempt with a refreshed one (#427). Only a rejection that arrives before any
 * content is retried, since the caller has seen nothing yet. `recover` performs
 * the refresh and builds the retry stream; it returns null when no refreshable
 * credential was sent, so the original rejection surfaces, and it throws when
 * the refresh itself failed, in which case its message replaces the provider
 * text so the run ends with the remedy instead of the raw rejection.
 */
export function retryStreamOnceOnAuthRejection(
	source: AssistantMessageEventStream,
	isAuthRejection: (error: AssistantMessage) => boolean,
	recover: () => Promise<AssistantMessageEventStream | null>,
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
				if (event.type === "error" && event.reason === "error" && isAuthRejection(event.error)) {
					let retry: AssistantMessageEventStream | null;
					try {
						retry = await recover();
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						const failed: AssistantMessage = { ...event.error, stopReason: "error", errorMessage };
						for (const pending of held) output.push(pending);
						output.push({ type: "error", reason: "error", error: failed });
						await source.result().catch(() => undefined);
						output.end(failed);
						return;
					}
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

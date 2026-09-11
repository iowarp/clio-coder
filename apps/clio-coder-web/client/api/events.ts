import type { QueryClient } from "@tanstack/react-query";
import type { Event } from "../../contracts/events.js";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/routes.js";

export function subscribe(token: string, queries: QueryClient, connection: (state: string) => void) {
	const stream = new EventSource(`${routes.events.path}?token=${encodeURIComponent(token)}`);
	let epoch: string | undefined;
	const receive = (message: MessageEvent<string>) => {
		const event = JSON.parse(message.data) as Event;
		if ((epoch && epoch !== event.epoch) || event.type === "resync") {
			queries.removeQueries({ queryKey: ["operation"] });
			void queries.invalidateQueries();
		}
		epoch = event.epoch;
		if (event.type === "hello") connection("Connected");
		if (event.type === "operation.finished") {
			queries.setQueryData<Operation>(["operation", event.payload.resource], (current) =>
				current && current.revision > event.payload.revision ? current : event.payload.operation,
			);
			void queries.invalidateQueries({ queryKey: ["tools"] });
		}
		if (event.type === "operation.progress")
			void queries.invalidateQueries({ queryKey: ["operation", event.payload.resource] });
		if (event.type === "toolchain.changed") void queries.invalidateQueries({ queryKey: ["tools"] });
	};
	for (const type of ["hello", "resync", "operation.progress", "operation.finished", "toolchain.changed"])
		stream.addEventListener(type, receive as EventListener);
	stream.onerror = () => connection("Reconnecting…");
	return () => stream.close();
}

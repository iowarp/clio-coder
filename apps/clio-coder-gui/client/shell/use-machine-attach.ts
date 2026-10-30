import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { MachineAttachment, MachineAttachments } from "../../contracts/machines.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { attachmentsSettling, pendingOutcome } from "./machine-switcher-model.js";

/**
 * The attachments the app on this machine holds to registered nodes, and the way to open one. An
 * Open waits for its node to become ready, then leaves for the node's own view in this window.
 */
export function useMachineAttach(local: Client, enabled = true) {
	const queries = useQueryClient();
	const [pending, setPending] = useState<string | null>(null);
	const attachments = useQuery({
		queryKey: ["machine-attachments"],
		queryFn: ({ signal }) => local.call(routes.machineAttachments, emptyInput, undefined, signal),
		enabled: enabled && !!local.token,
		staleTime: 5_000,
		retry: false,
		refetchInterval: (query) =>
			pending !== null || attachmentsSettling(query.state.data?.attachments ?? []) ? 2_000 : false,
		meta: { errorSurface: "inline" },
	});
	const attach = useMutation({
		mutationFn: (id: string) => local.call(routes.machineAttach, { ...emptyInput, params: { id } }),
		onSuccess: (attachment: MachineAttachment) => {
			queries.setQueryData<MachineAttachments>(["machine-attachments"], (current) =>
				current
					? {
							attachments: current.attachments.some((row) => row.id === attachment.id)
								? current.attachments.map((row) => (row.id === attachment.id ? attachment : row))
								: [...current.attachments, attachment],
						}
					: { attachments: [attachment] },
			);
		},
		onError: () => setPending(null),
	});
	const rows = attachments.data?.attachments ?? [];
	useEffect(() => {
		const outcome = pendingOutcome(rows, pending);
		if (outcome.kind === "go") {
			setPending(null);
			window.location.assign(outcome.destination);
		} else if (outcome.kind === "stop" && pending !== null) setPending(null);
	}, [rows, pending]);
	return {
		attachments: rows,
		error: attachments.error,
		loading: attachments.isPending,
		pending,
		open: (id: string) => {
			if (pending !== null) return;
			setPending(id);
			attach.mutate(id);
		},
	};
}

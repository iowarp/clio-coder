import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import type { ProjectLaunch } from "../pages/project-open.js";
import { ClioPulse, PULSE_SIZE } from "./ClioMark.js";
import { PathField } from "./PathField.js";

/** A path box with completion, the OS folder dialog one click away, and the recent workspaces. */
export function OpenWorkspaceDialog({
	client,
	launch,
	onClose,
}: {
	client: Client;
	launch: ProjectLaunch;
	onClose: () => void;
}) {
	const [path, setPath] = useState("");
	const field = useRef<HTMLInputElement>(null);
	const pathId = useId();
	const recents = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const open = (target: string) => {
		if (target.trim()) launch.open(target.trim(), true);
	};
	return (
		<Dialog title="Open workspace" eyebrow="A folder on this machine" onClose={onClose} initialFocus={field}>
			<form
				className="wb-open"
				onSubmit={(event) => {
					event.preventDefault();
					open(path);
				}}
			>
				<label className="sr-only" htmlFor={pathId}>
					Project folder
				</label>
				<PathField client={client} id={pathId} value={path} onChange={setPath} onPicked={open} inputRef={field} />
				<button className="primary" type="submit" disabled={launch.busy || path.trim() === ""}>
					{launch.busy ? <ClioPulse size={PULSE_SIZE.row} /> : null}
					{launch.busy ? "Opening…" : "Open"}
				</button>
			</form>
			{launch.error ? <p role="alert">{launch.error.message}</p> : null}
			{path.trim() === "" && (recents.data?.length ?? 0) > 0 ? (
				<section className="wb-open__recents" aria-label="Recent workspaces">
					<h3>Recent</h3>
					<ul>
						{[...(recents.data ?? [])]
							.sort((a, b) => b.openedAt.localeCompare(a.openedAt))
							.slice(0, 6)
							.map((workspace) => (
								<li key={workspace.id}>
									<button type="button" onClick={() => open(workspace.path)} disabled={launch.busy}>
										<strong>{workspace.name}</strong>
										<small>{workspace.path}</small>
									</button>
								</li>
							))}
					</ul>
				</section>
			) : null}
		</Dialog>
	);
}

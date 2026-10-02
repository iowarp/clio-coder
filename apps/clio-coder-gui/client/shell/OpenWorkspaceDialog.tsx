import { useId, useRef, useState } from "react";
import type { Client } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import type { ProjectLaunch } from "../pages/project-open.js";
import { WorkspaceBrowser } from "../pages/workspace-browser.js";
import { ClioPulse, PULSE_SIZE } from "./ClioMark.js";

/**
 * The server owns paths, so this is the browser's stand-in for a native folder dialog: type or paste
 * an absolute path, or walk the folders of the machine running Clio Coder.
 */
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
	return (
		<Dialog title="Open workspace" eyebrow="A folder on this machine" size="wide" onClose={onClose} initialFocus={field}>
			<form
				className="wb-open"
				onSubmit={(event) => {
					event.preventDefault();
					if (path.trim()) launch.open(path.trim(), true);
				}}
			>
				<label className="sr-only" htmlFor={pathId}>
					Project folder
				</label>
				<input
					id={pathId}
					ref={field}
					value={path}
					onChange={(event) => setPath(event.target.value)}
					placeholder="/absolute/path/to/project"
					autoComplete="off"
					spellCheck={false}
				/>
				<button className="primary" type="submit" disabled={launch.busy || path.trim() === ""}>
					{launch.busy ? <ClioPulse size={PULSE_SIZE.row} /> : null}
					{launch.busy ? "Opening…" : "Open"}
				</button>
			</form>
			{launch.error ? <p role="alert">{launch.error.message}</p> : null}
			<WorkspaceBrowser
				client={client}
				embedded
				initialPath={path}
				onChoose={setPath}
				onStart={(selected) => launch.open(selected, true)}
				onClose={onClose}
			/>
		</Dialog>
	);
}

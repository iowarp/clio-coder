import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";

/** The server owns paths. A browser file picker cannot give a usable local path to the ACP host. */
export function WorkspaceBrowser({
	client,
	initialPath,
	onChoose,
	onStart,
	onClose,
}: {
	client: Client;
	initialPath: string;
	onChoose: (path: string) => void;
	onStart: (path: string) => void;
	onClose: () => void;
}) {
	const [path, setPath] = useState<string | null>(initialPath.trim() || null);
	const [hidden, setHidden] = useState(false);
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), []);
	const folders = useQuery({
		queryKey: ["workspace-folders", path, hidden],
		queryFn: () =>
			client.call(routes.workspaceFolders, {
				params: {},
				query: { ...(path === null ? {} : { path }), ...(hidden ? { hidden: true } : {}) },
				body: {},
			}),
		retry: false,
	});
	const view = folders.error ? undefined : folders.data;
	return (
		<section className="workspace-browser" aria-label="Choose a project folder">
			<div className="workspace-browser__head">
				<div>
					<p className="eyebrow">On the machine running Clio Coder</p>
					<h2 ref={heading} tabIndex={-1}>
						Choose a project folder
					</h2>
				</div>
				<button type="button" onClick={onClose} aria-label="Close folder browser">
					Close
				</button>
			</div>
			<div className="workspace-browser__navigation">
				<button type="button" disabled={!view?.parent} onClick={() => view?.parent && setPath(view.parent)}>
					↑ Parent
				</button>
				<button
					type="button"
					disabled={!view || view.path === view.homePath}
					onClick={() => view && setPath(view.homePath)}
				>
					Home folder
				</button>
				<button
					type="button"
					disabled={!view || view.path === view.launchPath}
					onClick={() => view && setPath(view.launchPath)}
				>
					Launch folder
				</button>
				<label className="workspace-browser__hidden">
					<input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
					Show hidden folders
				</label>
			</div>
			{folders.isPending && <p role="status">Reading folders…</p>}
			{folders.error && (
				<div role="alert">
					<p>{folders.error.message}</p>
					<button type="button" onClick={() => setPath(null)}>
						Return to launch folder
					</button>
					<button type="button" onClick={() => void folders.refetch()}>
						Try again
					</button>
				</div>
			)}
			{view && (
				<>
					<div className="workspace-browser__current">
						<code>{view.path}</code>
						<div className="workspace-browser__actions">
							<button type="button" onClick={() => onChoose(view.path)}>
								Use this path
							</button>
							<button type="button" className="primary" onClick={() => onStart(view.path)}>
								Start conversation here
							</button>
						</div>
					</div>
					{view.directories.length > 0 ? (
						<ul className="workspace-browser__folders">
							{view.directories.map((directory) => (
								<li key={directory.path}>
									<button type="button" onClick={() => setPath(directory.path)}>
										<span aria-hidden="true">▣</span>
										<span>{directory.name}</span>
										<span aria-hidden="true">→</span>
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="workspace-browser__empty">No subfolders are visible here. You can select this folder or go up.</p>
					)}
					{view.truncated && (
						<p className="workspace-browser__empty">Showing the first 200 folders. Enter a path directly to reach another.</p>
					)}
				</>
			)}
		</section>
	);
}

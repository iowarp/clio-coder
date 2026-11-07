import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import type { PathTarget } from "../render/Markdown.js";
import { CopyButton } from "../render/Markdown.js";
import { previewView } from "./file-preview-model.js";
import "./file-preview.css";

/**
 * A read-only look at a file a turn named. The server answers only for files inside the workspace that are
 * not secrets; anything it refuses shows its reason here instead of the bytes.
 */
export function FilePreviewDialog({
	client,
	workspaceId,
	target,
	onClose,
}: {
	client: Client;
	workspaceId: string;
	target: PathTarget;
	onClose: () => void;
}) {
	const body = useRef<HTMLDivElement>(null);
	const read = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["workspace-file", workspaceId, target.path],
		queryFn: () =>
			client.call(routes.workspaceFile, { params: { id: workspaceId }, query: { path: target.path }, body: {} }),
		staleTime: 2_000,
		retry: false,
	});
	const preview = read.data;
	const view = useMemo(
		() => (preview?.status === "text" ? previewView(preview, target.line) : null),
		[preview, target.line],
	);
	useEffect(() => {
		if (view?.focus == null) return;
		body.current?.querySelector('[data-focus="true"]')?.scrollIntoView({ block: "center" });
	}, [view]);
	const title = target.line === null ? target.path : `${target.path}:${target.line}`;
	return (
		<Dialog title={title} eyebrow="File preview, read only" size="wide" onClose={onClose} initialFocus={body}>
			<div className="file-preview" ref={body} tabIndex={-1}>
				{read.isPending ? <p className="file-preview__status">Reading…</p> : null}
				{read.error ? (
					<p className="file-preview__status" role="alert">
						{read.error.message}
					</p>
				) : null}
				{preview && preview.status !== "text" ? <p className="file-preview__status">{preview.reason}</p> : null}
				{preview?.status === "text" && view ? (
					<>
						<div className="file-preview__bar">
							{view.notes.map((note) => (
								<span key={note}>{note}</span>
							))}
							<CopyButton text={preview.text} label="Copy file" short="Copy" />
						</div>
						{view.lines.length === 0 ? (
							<p className="file-preview__status">This file is empty.</p>
						) : (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus so the keyboard can scroll it.
							<pre className="file-preview__code" tabIndex={0}>
								{view.lines.map((line) => (
									<span key={line.number} className="file-preview__line" data-focus={line.focus || undefined}>
										<span className="file-preview__number" aria-hidden="true">
											{line.number}
										</span>
										<span>{line.text || " "}</span>
									</span>
								))}
							</pre>
						)}
					</>
				) : null}
			</div>
		</Dialog>
	);
}

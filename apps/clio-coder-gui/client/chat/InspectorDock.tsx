import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { useShortcutLayer } from "../interaction/use-shortcut.js";
import { ArtifactInspector } from "./ArtifactInspector.js";
import "./inspector-dock.css";

export function InspectorDock({
	open,
	onClose,
	client,
	session,
	workspaceRoot,
}: {
	open: boolean;
	onClose: () => void;
	client: Client;
	session: SessionSnapshot;
	workspaceRoot?: string | undefined;
}) {
	const [wide, setWide] = useState(() => typeof window === "undefined" || matchMedia("(min-width: 1200px)").matches);
	const dialog = useRef<HTMLDialogElement>(null);
	const dock = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const query = matchMedia("(min-width: 1200px)");
		const change = () => setWide(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	useShortcutLayer("dialog", open && !wide);
	useEffect(() => {
		const node = dock.current;
		if (!open || !wide || !node) return;
		const dismissKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		node.addEventListener("keydown", dismissKey);
		return () => node.removeEventListener("keydown", dismissKey);
	}, [open, wide, onClose]);
	useEffect(() => {
		const node = dialog.current;
		if (!open || wide || !node) return;
		node.showModal();
		return () => node.close();
	}, [open, wide]);
	if (!open) return null;
	const content = (
		<ArtifactInspector client={client} session={session} workspaceRoot={workspaceRoot} onClose={onClose} />
	);
	if (wide)
		return (
			<div className="inspector-dock" ref={dock}>
				{content}
			</div>
		);
	return createPortal(
		<dialog
			ref={dialog}
			className="inspector-dialog"
			aria-label="Conversation artifacts"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			{content}
		</dialog>,
		document.body,
	);
}

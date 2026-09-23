// A `<details>` used as a small menu closes the way a menu does: on a press anywhere outside it, and
// on Escape pressed inside it, which also hands focus back to its summary. Session tools and the
// composer's route picker share this, so the two disclosures cannot drift apart.

import { type RefObject, useEffect } from "react";

export function useDetailsDismiss(panel: RefObject<HTMLDetailsElement | null>, open: boolean): void {
	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (panel.current && event.target instanceof Node && !panel.current.contains(event.target))
				panel.current.open = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
			event.preventDefault();
			panel.current.open = false;
			panel.current.querySelector("summary")?.focus();
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [panel, open]);
}

import DOMPurify from "dompurify";
import { useEffect, useRef } from "react";
import type { MathToken } from "./markdown-model.js";
import { typesetMath } from "./math.js";
import { SANITIZE_CONFIG } from "./sanitize-policy.js";

export default function MathContent({ token }: { token: MathToken }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		root.textContent = token.raw;
		let cancelled = false;
		void typesetMath(token.text, token.displayMode)
			.then((markup) => {
				if (cancelled) return;
				const clean = DOMPurify.sanitize(markup, {
					...SANITIZE_CONFIG,
					USE_PROFILES: { mathMl: true },
					ADD_TAGS: ["semantics", "annotation"],
				});
				const document = new DOMParser().parseFromString(clean, "text/html");
				root.replaceChildren(...Array.from(document.body.childNodes, (node) => root.ownerDocument.importNode(node, true)));
			})
			.catch(() => {
				// Keep the original TeX readable if the lazy renderer cannot load.
			});
		return () => {
			cancelled = true;
		};
	}, [token.raw, token.text, token.displayMode]);
	const scrolling = token.displayMode
		? ({ role: "group", "aria-label": "Mathematical expression", tabIndex: 0 } as const)
		: {};
	return <span className={token.displayMode ? "md-math md-math--display" : "md-math"} ref={ref} {...scrolling} />;
}

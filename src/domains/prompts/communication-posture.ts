import { loadFragments } from "./fragment-loader.js";

export type CommunicationPosture = "quick" | "rigorous" | "recovery";

export interface CommunicationPostureSnapshot {
	operatorText: string;
	continuation: boolean;
	recentToolFailures: number;
	highRigor: boolean;
	testsFirst: boolean;
}

/** The three source-controlled fragments are read once by the composition root. */
export function loadCommunicationPostures(): Readonly<Record<CommunicationPosture, string>> {
	const fragments = loadFragments().byId;
	const body = (name: CommunicationPosture): string => {
		const fragment = fragments.get(`communication.${name}`);
		if (!fragment) throw new Error(`missing communication.${name} prompt fragment`);
		return fragment.body.trim();
	};
	return { quick: body("quick"), rigorous: body("rigorous"), recovery: body("recovery") };
}

/** A presentation hint only; it never changes tool admission or the validation gate. */
export function selectCommunicationPosture(snapshot: CommunicationPostureSnapshot): CommunicationPosture | null {
	if (snapshot.continuation) return null;
	const text = snapshot.operatorText.trim();
	if (text.length === 0 || /^(?:\{|\[|```)/u.test(text)) return null;
	if (
		snapshot.recentToolFailures >= 2 ||
		/\b(?:that's wrong|you were wrong|you missed|incorrect|that failed)\b/iu.test(text)
	)
		return "recovery";
	if (snapshot.highRigor || snapshot.testsFirst) return "rigorous";
	if (text.length <= 140 && (/\b(?:quick|brief|one line|short answer)\b/iu.test(text) || /\?\s*$/u.test(text)))
		return "quick";
	return null;
}

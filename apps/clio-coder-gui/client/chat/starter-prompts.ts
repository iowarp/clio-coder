// The three ways to start a task. Apart from chat-turn.ts so the new-task screen does not load the
// transcript's presentation code just to print them.
export const STARTER_PROMPTS = [
	"Map this project and explain how its parts fit together.",
	"Run the existing checks and summarize what the evidence shows.",
	"Help me plan a careful change without editing anything yet.",
] as const;

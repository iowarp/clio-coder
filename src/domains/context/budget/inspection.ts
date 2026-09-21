import type { LiveBudgetView } from "./live-view.js";

/** A native-session accounting port, never inherited by a dispatched worker. */
export type BudgetInspection =
	| { status: "available"; capability: "native"; view: LiveBudgetView }
	| { status: "unavailable" | "unsupported"; reason: string };

/** Refreshes accounting only: no runtime initialization, model calls or I/O. */
export type BudgetProvider = () => BudgetInspection;

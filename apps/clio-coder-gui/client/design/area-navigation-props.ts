import type { Client } from "../api/client.js";

export interface AreaNavigationProps {
	client: Client;
	close?: (() => void) | undefined;
	workspaceId?: string | undefined;
	conversationPath?: string | undefined;
}

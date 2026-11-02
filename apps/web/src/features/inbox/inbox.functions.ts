import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { readInbox } from "../../server/inbox-read.server";
import { type InboxQuery, inboxQuerySchema } from "./contracts";

/**
 * Inbox read (wave 23). GET + `private, no-store`: the page is tenant-scoped
 * and must never be cached by a shared proxy.
 */
export const listInbox = createServerFn({ method: "GET" })
	.validator((input: InboxQuery | unknown) => {
		const parsed = inboxQuerySchema.safeParse(input ?? {});
		if (!parsed.success) throw new Error("Invalid inbox request.");
		return parsed.data ?? {};
	})
	.handler(async ({ data }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return readInbox(data);
	});

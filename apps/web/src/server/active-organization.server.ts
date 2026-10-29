import "@tanstack/react-start/server-only";
import { asOrganizationId, type OrganizationId } from "@isolate/shared";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";

/**
 * The active organization is a preference, not a permission. It is stored in
 * an http-only cookie and only ever selects between organizations the caller
 * already belongs to.
 */
export const ACTIVE_ORGANIZATION_COOKIE = "isolate_active_organization";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function readActiveOrganizationPreference(): OrganizationId | undefined {
	try {
		const raw = getCookie(ACTIVE_ORGANIZATION_COOKIE);
		if (!raw) return undefined;
		const parsed = z.uuid().safeParse(raw);
		return parsed.success
			? asOrganizationId(parsed.data.toLowerCase())
			: undefined;
	} catch {
		// Outside a request context there is no preference to read.
		return undefined;
	}
}

export function writeActiveOrganizationPreference(
	organizationId: OrganizationId,
): void {
	setCookie(ACTIVE_ORGANIZATION_COOKIE, organizationId, {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		maxAge: ONE_YEAR_SECONDS,
	});
}

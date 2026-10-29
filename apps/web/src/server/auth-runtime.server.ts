import "@tanstack/react-start/server-only";
import {
	type MembershipRepository,
	type PgSql,
	PostgresMembershipRepository,
	PostgresOrganizationRepository,
	PostgresUserRepository,
} from "@isolate/db";
import {
	createNeonAuthSessionResolver,
	ensurePlatformTenancy,
	type PlatformIdentity,
} from "./auth-session.server";
import type { MembershipReader, SessionResolver } from "./caller-scope.server";
import { createPostgresMembershipReader } from "./membership-reader.server";
import { getNeonAuthServer, type NeonAuthSettings } from "./neon-auth.server";

export type AuthRuntime = {
	settings: NeonAuthSettings;
	session: SessionResolver;
	memberships: MembershipReader;
	membershipRepository: MembershipRepository;
	organizationRepository: PostgresOrganizationRepository;
	userRepository: PostgresUserRepository;
	/** Mirror an authenticated identity into the platform tenancy tables. */
	ensureTenancy(identity: PlatformIdentity): Promise<void>;
};

/**
 * Bind the Neon Auth server to the platform's tenancy tables. The session
 * resolver may only say who is calling; the membership reader may only say
 * which organization is active.
 */
export function createAuthRuntime(
	sql: PgSql,
	settings: NeonAuthSettings,
): AuthRuntime {
	const server = getNeonAuthServer(settings);
	const membershipRepository = new PostgresMembershipRepository(sql);
	const organizationRepository = new PostgresOrganizationRepository(sql);
	const userRepository = new PostgresUserRepository(sql);
	const ensureTenancy = (identity: PlatformIdentity) =>
		ensurePlatformTenancy(
			{
				users: userRepository,
				memberships: membershipRepository,
				organizations: organizationRepository,
			},
			identity,
		);
	return {
		settings,
		membershipRepository,
		organizationRepository,
		userRepository,
		ensureTenancy,
		session: createNeonAuthSessionResolver({
			server,
			users: userRepository,
			memberships: membershipRepository,
			organizations: organizationRepository,
		}),
		memberships: createPostgresMembershipReader(membershipRepository),
	};
}

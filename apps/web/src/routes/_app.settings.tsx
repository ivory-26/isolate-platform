import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { RoleBadge } from "@/components/auth/RoleBadge";
import { useSession } from "@/components/auth/SessionProvider";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { DetailList } from "@/components/console/detail-list";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { LogoutIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { signOut } from "@/features/auth/auth.functions";
import { requireSession } from "@/features/auth/guard";
import { authStateKeys, authStateOptions } from "@/features/auth/queries";
import {
	canManageMembers,
	EXECUTION_POLICY,
} from "@/features/settings/contracts";
import {
	workspaceMembersOptions,
	workspaceSummaryOptions,
} from "@/features/settings/queries";

export const Route = createFileRoute("/_app/settings")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		requireSession(state);
		await Promise.all([
			context.queryClient.ensureQueryData(workspaceSummaryOptions()),
			context.queryClient.ensureQueryData(workspaceMembersOptions()),
		]);
	},
	component: SettingsPage,
});

function SettingsPage() {
	const summaryQuery = useSuspenseQuery(workspaceSummaryOptions());
	const membersQuery = useSuspenseQuery(workspaceMembersOptions());
	const summary = summaryQuery.data.ok ? summaryQuery.data.value : null;

	return (
		<PageContainer>
			<PageHeader
				title="Settings"
				description="Workspace identity, membership roles, the enforced execution policy and account controls for the active organization."
			/>

			<div className="flex flex-col gap-10">
				<ConsoleSection
					id="workspace"
					title="Workspace"
					description="Resolved from your active organization membership on the server."
				>
					{summary ? (
						<DetailList
							items={[
								{ label: "Organization", value: summary.name },
								{ label: "Address", value: summary.slug, mono: true },
								{
									label: "Your role",
									value: <RoleBadge role={summary.role} />,
								},
								{
									label: "Members",
									value: (
										<span className="tabular-nums">{summary.memberCount}</span>
									),
								},
							]}
						/>
					) : (
						<ErrorState
							message={
								summaryQuery.data.ok ? "" : summaryQuery.data.error.message
							}
							onRetry={() => void summaryQuery.refetch()}
						/>
					)}
				</ConsoleSection>

				<ConsoleSection
					id="members"
					title="Members"
					description="Everyone with a membership in this organization. Inviting and removing members is not implemented yet, so no controls are shown."
				>
					{!membersQuery.data.ok ? (
						membersQuery.data.error.code === "FORBIDDEN" ? (
							<ConsoleNote role="note">
								Member names and emails are visible to owners and admins. You
								can still see the workspace summary and execution policy.
							</ConsoleNote>
						) : (
							<ErrorState
								title="Member details are not available"
								message={membersQuery.data.error.message}
								onRetry={() => void membersQuery.refetch()}
							/>
						)
					) : membersQuery.data.value.length === 0 ? (
						<EmptyRow
							title="No members found"
							description="This organization has no membership rows yet."
						/>
					) : (
						<div className="border-y border-line-subtle">
							<Table>
								<caption className="sr-only">
									Members of the active organization
								</caption>
								<TableHeader>
									<TableRow className="border-line-subtle hover:bg-transparent">
										<TableHead scope="col">Name</TableHead>
										<TableHead scope="col">Email</TableHead>
										<TableHead scope="col" className="w-[140px]">
											Role
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{membersQuery.data.value.map((member) => (
										<TableRow
											key={member.email}
											className="h-12 border-line-subtle"
										>
											<TableCell className="text-ink">
												{member.displayName}
											</TableCell>
											<TableCell className="font-mono text-xs text-ink-secondary">
												{member.email}
											</TableCell>
											<TableCell>
												<RoleBadge role={member.role} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
					{summary && canManageMembers(summary.role) ? (
						<p className="mt-3 text-xs text-ink-muted">
							Owner and admin roles hold the member capability. This page does
							not expose invite or remove controls.
						</p>
					) : null}
				</ConsoleSection>

				<ConsoleSection
					id="execution-policy"
					title="Execution policy"
					description="Enforced by the control plane, worker and tool registry. These rules are read-only."
				>
					<ol className="divide-y divide-line-subtle border-y border-line-subtle">
						{EXECUTION_POLICY.map((rule) => (
							<li
								key={rule.id}
								className="grid gap-1 py-4 md:grid-cols-[240px_minmax(0,1fr)] md:gap-6"
							>
								<p className="text-sm font-medium text-ink">{rule.title}</p>
								<p className="text-sm leading-6 text-ink-secondary">
									{rule.detail}
								</p>
							</li>
						))}
					</ol>
				</ConsoleSection>

				<AccountSection />
			</div>
		</PageContainer>
	);
}

function AccountSection() {
	const state = useSession();
	const queryClient = useQueryClient();
	const router = useRouter();
	const navigate = useNavigate();
	const mutation = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async (result) => {
			if (!result.ok) return;
			await queryClient.invalidateQueries({ queryKey: authStateKeys.all });
			await router.invalidate();
			void navigate({ to: "/login" });
		},
	});
	const user = state.mode === "authenticated" ? state.session.user : null;

	return (
		<ConsoleSection
			id="account"
			title="Account"
			description="Organization membership and the way out of this session."
		>
			<div className="flex flex-col gap-4 border-y border-line-subtle py-4 md:flex-row md:items-center md:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="text-sm font-medium text-ink">
						{user?.name ?? "Local demo identity"}
					</p>
					<p className="font-mono text-xs text-ink-muted">
						{user?.email ?? "Fixed development workspace"}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button asChild variant="ghost" size="sm">
						<Link to="/organizations">Organizations</Link>
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={mutation.isPending}
						onClick={() => mutation.mutate()}
					>
						<LogoutIcon />
						{mutation.isPending ? "Signing out…" : "Sign out"}
					</Button>
				</div>
			</div>
			{mutation.isSuccess && !mutation.data.ok ? (
				<p role="alert" className="mt-3 text-xs text-danger">
					{mutation.data.error.message}
				</p>
			) : null}
			{mutation.isError ? (
				<p role="alert" className="mt-3 text-xs text-danger">
					Sign-out could not be confirmed. Try again.
				</p>
			) : null}
		</ConsoleSection>
	);
}

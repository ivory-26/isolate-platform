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
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { KeyValue } from "@/components/common/key-value";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { Section } from "@/components/common/section";
import {
	LogoutIcon,
	PolicyIcon,
	SettingsIcon,
	ShieldCheckIcon,
	UsersIcon,
} from "@/components/icons";
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
				eyebrow="Manage"
				title="Settings"
				description="Workspace identity, membership roles, the enforced execution policy and account controls for the active organization."
			/>

			<Section
				title="Workspace"
				description="Resolved from your active organization membership on the server."
				action={<SettingsIcon size={16} className="text-ink-muted" />}
			>
				{summary ? (
					<KeyValue
						columns={2}
						items={[
							{ label: "Organization", value: summary.name },
							{ label: "Address", value: summary.slug, mono: true },
							{
								label: "Your role",
								value: <RoleBadge role={summary.role} />,
							},
							{
								label: "Members",
								value: String(summary.memberCount),
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
			</Section>

			<Section
				title="Members"
				description="Everyone with a membership in this organization. Inviting and removing members is not implemented yet, so no controls are shown."
				action={<UsersIcon size={16} className="text-ink-muted" />}
			>
				{!membersQuery.data.ok ? (
					membersQuery.data.error.code === "FORBIDDEN" ? (
						<div className="flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs text-ink-secondary">
							<UsersIcon size={14} className="mt-0.5 shrink-0 text-ink-muted" />
							<p className="leading-5">
								Member names and emails are visible to owners and admins. You
								can still see the workspace summary and execution policy.
							</p>
						</div>
					) : (
						<ErrorState
							title="Member details are not available"
							message={membersQuery.data.error.message}
							onRetry={() => void membersQuery.refetch()}
						/>
					)
				) : membersQuery.data.value.length === 0 ? (
					<EmptyState
						icon={UsersIcon}
						title="No members found"
						description="This organization has no membership rows yet."
					/>
				) : (
					<div className="overflow-x-auto rounded-lg border border-line-subtle">
						<Table>
							<caption className="sr-only">
								Members of the active organization
							</caption>
							<TableHeader>
								<TableRow className="border-line-subtle hover:bg-transparent">
									<TableHead>Name</TableHead>
									<TableHead>Email</TableHead>
									<TableHead className="w-[140px]">Role</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{membersQuery.data.value.map((member) => (
									<TableRow key={member.email} className="border-line-subtle">
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
						Owner and admin roles hold the member capability. This page does not
						expose invite or remove controls.
					</p>
				) : null}
			</Section>

			<Section
				title="Execution policy"
				description="Enforced by the control plane, worker and tool registry. These rules are read-only."
				action={<PolicyIcon size={16} className="text-ink-muted" />}
			>
				<ol className="space-y-4">
					{EXECUTION_POLICY.map((rule) => (
						<li key={rule.id} className="flex gap-3">
							<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-elevated text-brand">
								<ShieldCheckIcon size={16} />
							</span>
							<div className="min-w-0 space-y-1">
								<p className="text-sm font-medium text-ink">{rule.title}</p>
								<p className="text-sm leading-6 text-ink-secondary">
									{rule.detail}
								</p>
							</div>
						</li>
					))}
				</ol>
			</Section>

			<AccountSection />
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
		<Section
			title="Account"
			description="Organization membership and the way out of this session."
			action={<UsersIcon size={16} className="text-ink-muted" />}
		>
			<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="text-sm font-medium text-ink">
						{user?.name ?? "Local demo identity"}
					</p>
					<p className="font-mono text-xs text-ink-muted">
						{user?.email ?? "Fixed development workspace"}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button asChild variant="outline" size="sm">
						<Link to="/organizations">
							<UsersIcon />
							Organizations
						</Link>
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
		</Section>
	);
}

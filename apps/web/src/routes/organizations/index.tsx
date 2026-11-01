import { createFileRoute, Link } from "@tanstack/react-router";
import { RoleBadge } from "@/components/auth/RoleBadge";
import { useSession } from "@/components/auth/SessionProvider";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { CheckIcon, PlusIcon, UsersIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/organizations/")({
	component: OrganizationsPage,
});

function OrganizationsPage() {
	const state = useSession();
	if (state.mode !== "authenticated") return null;
	const { organizations, activeOrganizationId } = state.session;
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Manage"
				title="Your organizations"
				description="You only see organizations where you hold a membership. Every task, run, device and connector belongs to exactly one of them."
				actions={
					<Button asChild size="sm">
						<Link to="/organizations/new">
							<PlusIcon />
							Create organization
						</Link>
					</Button>
				}
			/>

			{organizations.length === 0 ? (
				<EmptyState
					icon={UsersIcon}
					title="No organizations yet"
					description="Create an organization to queue tasks, register devices and connect vendors."
					action={
						<Button asChild size="sm">
							<Link to="/organizations/new">
								<PlusIcon />
								Create organization
							</Link>
						</Button>
					}
				/>
			) : (
				<div className="overflow-x-auto rounded-lg border border-line-subtle">
					<Table>
						<caption className="sr-only">Your organization memberships</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead>Organization</TableHead>
								<TableHead>Address</TableHead>
								<TableHead className="w-[140px]">Your role</TableHead>
								<TableHead className="w-[140px]">Active</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{organizations.map((organization) => {
								const active = organization.id === activeOrganizationId;
								return (
									<TableRow
										key={organization.id}
										className="border-line-subtle"
									>
										<TableCell className="text-sm font-medium text-ink">
											{organization.name}
										</TableCell>
										<TableCell className="font-mono text-xs text-ink-secondary">
											{organization.slug}
										</TableCell>
										<TableCell>
											<RoleBadge role={organization.role} />
										</TableCell>
										<TableCell className="text-xs">
											{active ? (
												<span className="inline-flex items-center gap-1.5 text-success">
													<CheckIcon />
													Active
												</span>
											) : (
												<span className="text-ink-muted">Inactive</span>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}
		</PageContainer>
	);
}

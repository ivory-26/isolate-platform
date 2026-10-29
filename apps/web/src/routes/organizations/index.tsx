import { createFileRoute, Link } from "@tanstack/react-router";
import { RoleBadge } from "../../components/auth/RoleBadge";
import { useSession } from "../../components/auth/SessionProvider";

export const Route = createFileRoute("/organizations/")({
	component: OrganizationsPage,
});

function OrganizationsPage() {
	const state = useSession();
	if (state.mode !== "authenticated") return null;
	const { organizations, activeOrganizationId } = state.session;
	return (
		<main>
			<p className="eyebrow">Tenants</p>
			<h1>Your organizations</h1>
			<p>
				You only see the organizations you hold a membership in. Every task, run
				and workflow belongs to exactly one of them.
			</p>
			{organizations.length === 0 ? (
				<p>
					No organizations yet. <Link to="/organizations/new">Create one</Link>.
				</p>
			) : (
				<div className="table-scroll">
					<table>
						<caption>Memberships</caption>
						<thead>
							<tr>
								<th scope="col">Organization</th>
								<th scope="col">Address</th>
								<th scope="col">Your role</th>
								<th scope="col">Active</th>
							</tr>
						</thead>
						<tbody>
							{organizations.map((organization) => (
								<tr key={organization.id}>
									<td>{organization.name}</td>
									<td>
										<code>{organization.slug}</code>
									</td>
									<td>
										<RoleBadge role={organization.role} />
									</td>
									<td>
										{organization.id === activeOrganizationId ? "Yes" : "No"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<p>
				<Link to="/organizations/new">Create an organization</Link>
			</p>
		</main>
	);
}

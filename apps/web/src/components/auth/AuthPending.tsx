import { Skeleton } from "@/components/ui/skeleton";
import { AuthLayout } from "./AuthLayout";

const COPY = {
	"sign-in": {
		title: "Access your organization",
		description:
			"Your organization and role are resolved on the server from your membership, never from this form.",
	},
	"sign-up": {
		title: "Join the platform",
		description:
			"Create a credential, then an organization. You become its owner; organization and role are resolved on the server.",
	},
} as const;

/**
 * Pending state for the credential routes. It reuses the real {@link AuthLayout}
 * chrome (same grid, brand panel, card and copy) so resolving the loader cannot
 * shift the page; only the form fields are placeholders.
 */
export function AuthPending({ mode }: { mode: "sign-in" | "sign-up" }) {
	const copy = COPY[mode];
	return (
		<AuthLayout
			title={copy.title}
			description={copy.description}
			footer={<Skeleton className="mx-auto h-3 w-32" />}
		>
			<output aria-busy="true" className="block space-y-4">
				<span className="sr-only">Loading the credential form</span>
				{mode === "sign-up" ? (
					<div className="space-y-1.5">
						<Skeleton className="h-4 w-12" />
						<Skeleton className="h-9 w-full" />
					</div>
				) : null}
				<div className="space-y-1.5">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-9 w-full" />
				</div>
				<div className="space-y-1.5">
					<Skeleton className="h-4 w-16" />
					<Skeleton className="h-9 w-full" />
					{mode === "sign-up" ? <Skeleton className="h-3 w-64" /> : null}
				</div>
				<Skeleton className="h-9 w-full" />
			</output>
		</AuthLayout>
	);
}

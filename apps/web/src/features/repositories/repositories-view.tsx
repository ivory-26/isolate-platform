import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	Pagination,
	useClientPagination,
} from "@/components/common/pagination";
import { RelativeTime } from "@/components/common/relative-time";
import { DataTable } from "@/components/console/data-table";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import {
	ChevronDownIcon,
	PlusIcon,
	RepositoriesIcon,
	SearchIcon,
	WarningIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { onboardingKeys } from "@/features/onboarding/queries";
import { formatDurationMs } from "@/lib/format";
import type {
	GitHubSetupResult,
	InstallationRepositoriesReadModel,
	RegisterRepositoryInput,
	RepositoriesSearch,
	RepositoryProvider,
	RepositorySummary,
} from "./contracts";
import { registerRepositorySchema } from "./contracts";
import {
	canImport,
	isImportChoiceDisabled,
	MAX_IMPORT_SELECTION,
	pruneImportSelection,
	toggleImportSelection,
} from "./import-selection";
import { repositoryKeys } from "./queries";
import {
	importRepositories,
	listInstallationRepositories,
	registerRepository,
} from "./repositories.functions";

const PROVIDER_LABEL: Record<RepositoryProvider, string> = {
	github: "GitHub",
};

const SKELETON_ROWS = ["one", "two", "three", "four", "five"];

/** One table page for the repository list (the server caps at 200 rows). */
export const REPOSITORY_PAGE_SIZE = 25;

export function RepositoryFilters({
	search,
	count,
	filtered,
	onQueryChange,
	onProviderChange,
}: {
	search: RepositoriesSearch;
	count: number;
	filtered: boolean;
	onQueryChange: (value: string) => void;
	onProviderChange: (value: RepositoryProvider | undefined) => void;
}) {
	const [value, setValue] = useState(search.q);
	const searchId = useId();
	const providerId = useId();

	// The URL is the source of truth; keep the local field in sync when the
	// caller navigates (back/forward, cleared search).
	useEffect(() => setValue(search.q), [search.q]);
	useEffect(() => {
		if (value === search.q) return;
		const timer = window.setTimeout(() => onQueryChange(value), 300);
		return () => window.clearTimeout(timer);
	}, [value, search.q, onQueryChange]);

	return (
		<div className="flex flex-col gap-3 border-y border-line-subtle py-3 sm:flex-row sm:items-center">
			<div className="relative min-w-0 flex-1">
				<Label htmlFor={searchId} className="sr-only">
					Search repositories by full name
				</Label>
				<SearchIcon
					size={15}
					className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-muted"
				/>
				<Input
					id={searchId}
					value={value}
					maxLength={100}
					placeholder="Search owner/repository"
					autoComplete="off"
					spellCheck={false}
					className="pl-8"
					onChange={(event) => setValue(event.target.value)}
				/>
			</div>
			<div className="sm:w-48">
				<Label htmlFor={providerId} className="sr-only">
					Filter by provider
				</Label>
				<Select
					value={search.provider ?? "all"}
					onValueChange={(next) =>
						onProviderChange(next === "github" ? "github" : undefined)
					}
				>
					<SelectTrigger id={providerId} className="w-full">
						<SelectValue placeholder="All providers" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All providers</SelectItem>
						<SelectItem value="github">GitHub</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<p className="shrink-0 text-xs text-ink-muted tabular-nums sm:ml-2">
				{filtered ? `${count} matching` : `${count} registered`}
			</p>
		</div>
	);
}

const TABLE_COLUMNS = [
	{ key: "repository", header: "Repository", className: "min-w-[240px]" },
	{ key: "branch", header: "Default branch", className: "w-[150px]" },
	{ key: "validation", header: "Validation gate", className: "min-w-[260px]" },
	{ key: "registered", header: "Registered", className: "w-[150px]" },
];

export function RepositoriesTable({
	repositories,
	truncated,
	page,
	onPageChange,
}: {
	repositories: RepositorySummary[];
	truncated: boolean;
	page: number;
	onPageChange: (page: number) => void;
}) {
	const paged = useClientPagination({
		items: repositories,
		pageSize: REPOSITORY_PAGE_SIZE,
		page,
		onPageChange,
	});

	return (
		<DataTable
			caption="Repositories imported for the active organization, including provider, default branch, validation policy and registration time."
			columns={TABLE_COLUMNS}
			isEmpty={paged.pageItems.length === 0}
			empty="No repositories registered yet."
			pagination={
				<>
					<Pagination
						page={paged.page}
						pageCount={paged.pageCount}
						onPageChange={onPageChange}
						label="Repository pages"
					/>
					{truncated ? (
						<p className="text-[11px] text-ink-muted">
							Showing the first 200 repositories. Narrow the search to see the
							rest.
						</p>
					) : null}
				</>
			}
		>
			{paged.pageItems.map((repository) => (
				<TableRow key={repository.id} className="border-line-subtle">
					<TableCell className="py-2 align-top">
						<span className="block truncate font-mono text-xs text-ink">
							{repository.externalFullName}
						</span>
						<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
							<span>{PROVIDER_LABEL[repository.provider]}</span>
							<span aria-hidden="true">·</span>
							<span className="font-mono">{repository.id.slice(0, 8)}…</span>
						</div>
					</TableCell>
					<TableCell className="py-2 align-top">
						<span className="font-mono text-xs text-ink-secondary">
							{repository.defaultBranch}
						</span>
					</TableCell>
					<TableCell className="max-w-[320px] py-2 align-top whitespace-normal">
						{repository.validationCommand ? (
							<div className="space-y-1">
								<code
									className="line-clamp-2 font-mono text-[11px] leading-5 break-all text-ink-secondary"
									title={repository.validationCommand}
								>
									{repository.validationCommand}
								</code>
								<p className="text-[11px] text-ink-muted tabular-nums">
									Timeout {formatDurationMs(repository.validationTimeoutMs)}
								</p>
							</div>
						) : (
							<span className="text-xs text-ink-muted">
								No validation gate configured
							</span>
						)}
					</TableCell>
					<TableCell className="py-2 align-top text-xs text-ink-secondary">
						<RelativeTime value={repository.createdAt} />
					</TableCell>
				</TableRow>
			))}
		</DataTable>
	);
}

/* -------------------------------------------------------------------------- */
/* GitHub App connect + repository picker                                     */
/* -------------------------------------------------------------------------- */

const installationKeys = ["repositories", "installation"] as const;

function failureHint(result: GitHubSetupResult<unknown>): string | null {
	if (result.ok) return null;
	switch (result.error.code) {
		case "GITHUB_APP_NOT_CONFIGURED":
			return "This deployment has no Isolate GitHub App configured. An operator must set the App id, slug, private key and state secret before any organization can install it.";
		case "GITHUB_INSTALLATION_REQUIRED":
			return "Install the Isolate App on the account that owns your repositories, then return here.";
		case "FORBIDDEN":
			return "Only an owner or admin can install the App or import repositories.";
		case "RATE_LIMITED":
			return "GitHub is rate limiting Isolate. Wait a moment and refresh the list.";
		case "NOT_FOUND":
			return "The stored GitHub installation is no longer available. Reinstall the Isolate App, then refresh this list.";
		default:
			return "The installation repository list could not be read. Try again shortly.";
	}
}

/**
 * Primary repository path: install the Isolate GitHub App, then pick from the
 * installation's own repositories. Manual registration stays available as an
 * advanced form below; it is never the main path.
 */
export function ConnectGitHubPanel({
	canManage,
	autoExpand = false,
}: {
	canManage: boolean;
	/** Open the picker immediately, e.g. after GitHub redirects back. */
	autoExpand?: boolean;
}) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(autoExpand);
	const [selected, setSelected] = useState<string[]>([]);
	const [notice, setNotice] = useState<string | null>(null);

	const installation = useQuery({
		queryKey: installationKeys,
		queryFn: () => listInstallationRepositories(),
		enabled: expanded && canManage,
		staleTime: 30_000,
		retry: false,
	});

	// The install runs in a new tab. When the user returns to this tab, refresh
	// the installation list so a repository installed meanwhile appears without
	// a manual click.
	const { refetch: refetchInstallation } = installation;
	useEffect(() => {
		if (!expanded) return;
		const refresh = () => {
			if (document.visibilityState === "visible") void refetchInstallation();
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [expanded, refetchInstallation]);

	const importMutation = useMutation({
		mutationFn: (fullNames: string[]) =>
			importRepositories({ data: { fullNames } }),
		onSuccess: async (result) => {
			if (!result.ok) {
				setNotice(failureHint(result));
				return;
			}
			const { imported, skipped } = result.value;
			setNotice(
				`Imported ${imported.length} ${
					imported.length === 1 ? "repository" : "repositories"
				}${skipped.length > 0 ? `; ${skipped.length} skipped (already imported or not visible)` : ""}.`,
			);
			setSelected([]);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: repositoryKeys.all }),
				queryClient.invalidateQueries({ queryKey: onboardingKeys.setup }),
			]);
		},
		onError: () => setNotice("The import request could not be completed."),
	});

	const repositories: InstallationRepositoriesReadModel["repositories"] =
		installation.data?.ok ? installation.data.value.repositories : [];
	const installationError =
		installation.data !== undefined && !installation.data.ok
			? failureHint(installation.data)
			: installation.isError
				? "The installation repository list is unavailable."
				: null;

	const offered = useMemo(
		() => repositories.map((repository) => repository.fullName),
		[repositories],
	);
	useEffect(() => {
		setSelected((current) => pruneImportSelection(current, offered));
	}, [offered]);

	const toggle = (fullName: string) => {
		setSelected((current) => {
			const result = toggleImportSelection(current, fullName);
			if (result.blocked) {
				toast.error(
					`Import at most ${MAX_IMPORT_SELECTION} repositories at a time.`,
				);
			}
			return result.selected;
		});
		setNotice(null);
	};

	return (
		<ConsoleSection
			id="connect-github"
			title="Connect GitHub"
			description="Install the Isolate App, then choose the repositories it may work on. Tasks get a repository and default branch from this list."
			action={
				canManage ? (
					<Button asChild size="sm">
						{/* New tab: the GitHub round trip must not replace the app. */}
						<a
							href="/api/github/install"
							target="_blank"
							rel="noopener noreferrer"
						>
							<RepositoriesIcon size={14} />
							Install GitHub App
						</a>
					</Button>
				) : null
			}
		>
			{!canManage ? (
				<ConsoleNote role="note">
					Your role is read-only. An owner or admin installs the GitHub App and
					imports repositories.
				</ConsoleNote>
			) : null}

			<div className="space-y-3">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-expanded={expanded}
					onClick={() => setExpanded((current) => !current)}
				>
					<ChevronDownIcon
						className={
							expanded
								? "rotate-180 transition-transform"
								: "transition-transform"
						}
					/>
					{expanded
						? "Hide installation repositories"
						: "Choose from installed repositories"}
				</Button>

				{notice ? (
					<ConsoleNote
						role="status"
						tone={importMutation.isSuccess ? "neutral" : "warning"}
					>
						{notice}
					</ConsoleNote>
				) : null}

				{expanded ? (
					<div className="space-y-3">
						{installation.isLoading ? (
							<div className="divide-y divide-line-subtle border-y border-line-subtle">
								{SKELETON_ROWS.map((row) => (
									<Skeleton key={row} className="h-11 w-full" />
								))}
							</div>
						) : installationError !== null ? (
							<ConsoleNote role="alert" tone="warning">
								{installationError}
							</ConsoleNote>
						) : repositories.length === 0 ? (
							<EmptyRow
								title="No repositories visible to this installation"
								description="Install the App on a repository or grant it access to more repositories in GitHub, then refresh."
								action={
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => void installation.refetch()}
									>
										Refresh list
									</Button>
								}
							/>
						) : (
							<>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<p className="text-xs text-ink-muted tabular-nums">
										{selected.length} of {MAX_IMPORT_SELECTION} selected
									</p>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										onClick={() => void installation.refetch()}
									>
										Refresh list
									</Button>
								</div>
								<ul className="max-h-80 divide-y divide-line-subtle overflow-y-auto border-y border-line-subtle">
									{repositories.map((repository) => {
										const checked = selected.includes(repository.fullName);
										const disabled = isImportChoiceDisabled(
											selected,
											repository.fullName,
										);
										return (
											<li
												key={repository.fullName}
												className="flex items-center justify-between gap-3 px-1 py-2.5"
											>
												<label className="flex min-w-0 items-center gap-2.5 text-xs text-ink-secondary">
													<input
														type="checkbox"
														checked={checked}
														disabled={disabled}
														onChange={() => toggle(repository.fullName)}
														className="size-3.5 rounded border-line accent-[var(--color-electric-blue)]"
													/>
													<span className="min-w-0">
														<span className="block truncate font-mono text-[11px] text-ink">
															{repository.fullName}
														</span>
														<span className="text-[10px] text-ink-muted">
															{repository.defaultBranch}
															{repository.private ? " · private" : ""}
														</span>
													</span>
												</label>
												<StatusMark
													status={repository.private ? "offline" : "active"}
													label={repository.private ? "Private" : "Public"}
												/>
											</li>
										);
									})}
								</ul>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										size="sm"
										disabled={
											!canImport(selected) ||
											importMutation.isPending ||
											installation.data?.ok !== true
										}
										onClick={() => importMutation.mutate(selected)}
									>
										<PlusIcon />
										{importMutation.isPending
											? "Importing…"
											: `Import ${selected.length || ""} selected`.trim()}
									</Button>
									{selected.length > 0 ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => setSelected([])}
										>
											Clear selection
										</Button>
									) : null}
								</div>
							</>
						)}
					</div>
				) : null}
			</div>
		</ConsoleSection>
	);
}

/* -------------------------------------------------------------------------- */
/* Manual registration (advanced)                                             */
/* -------------------------------------------------------------------------- */

type FieldErrors = Partial<
	Record<keyof RegisterRepositoryInput | "form", string>
>;

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
	const errors: FieldErrors = {};
	for (const issue of issues) {
		const key = String(issue.path[0] ?? "form") as keyof FieldErrors;
		if (errors[key] === undefined) errors[key] = issue.message;
	}
	return errors;
}

export function RegisterRepositoryDialog({
	compact = false,
}: {
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [errors, setErrors] = useState<FieldErrors>({});
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (input: RegisterRepositoryInput) =>
			registerRepository({ data: input }),
		onSuccess: async (result) => {
			if (!result.ok) return;
			toast.success(`Registered ${result.value.repository.externalFullName}`);
			setOpen(false);
			setErrors({});
			await queryClient.invalidateQueries({ queryKey: repositoryKeys.all });
		},
	});

	function handleOpenChange(next: boolean) {
		setOpen(next);
		if (!next) {
			setErrors({});
			mutation.reset();
		}
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const parsed = registerRepositorySchema.safeParse({
			provider: form.get("provider"),
			externalFullName: String(form.get("externalFullName") ?? ""),
			defaultBranch: String(form.get("defaultBranch") ?? ""),
			validationCommand: String(form.get("validationCommand") ?? ""),
			validationTimeoutMs: Number(form.get("validationTimeoutMs")),
		});
		if (!parsed.success) {
			setErrors(fieldErrorsFrom(parsed.error.issues));
			return;
		}
		setErrors({});
		mutation.mutate(parsed.data);
	}

	const resultError =
		mutation.isSuccess && !mutation.data.ok ? mutation.data.error : null;
	const busy = mutation.isPending;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button
					type="button"
					size="sm"
					variant={compact ? "outline" : "default"}
				>
					<PlusIcon />
					Register by full name
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Register repository</DialogTitle>
					<DialogDescription>
						Add one repository by owner/name. This path skips the GitHub App
						installation check, so use it only for a repository you have already
						verified. Validation runs argv-only; shell metacharacters are
						refused.
					</DialogDescription>
				</DialogHeader>
				<form className="space-y-4" onSubmit={handleSubmit} noValidate>
					<input type="hidden" name="provider" value="github" />
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="register-provider">Provider</Label>
							<Input
								id="register-provider"
								value="GitHub"
								readOnly
								disabled
								aria-describedby="register-provider-hint"
							/>
							<p
								id="register-provider-hint"
								className="text-[11px] text-ink-muted"
							>
								Only GitHub repositories are supported.
							</p>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="register-full-name">Full name</Label>
							<Input
								id="register-full-name"
								name="externalFullName"
								placeholder="owner/repository"
								autoComplete="off"
								spellCheck={false}
								maxLength={200}
								required
								aria-invalid={Boolean(errors.externalFullName)}
								aria-describedby={
									errors.externalFullName
										? "register-full-name-error"
										: undefined
								}
							/>
							{errors.externalFullName ? (
								<p
									id="register-full-name-error"
									className="text-[11px] text-danger"
								>
									{errors.externalFullName}
								</p>
							) : null}
						</div>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="register-branch">Default branch</Label>
							<Input
								id="register-branch"
								name="defaultBranch"
								defaultValue="main"
								autoComplete="off"
								spellCheck={false}
								maxLength={255}
								required
								aria-invalid={Boolean(errors.defaultBranch)}
								aria-describedby={
									errors.defaultBranch ? "register-branch-error" : undefined
								}
							/>
							{errors.defaultBranch ? (
								<p
									id="register-branch-error"
									className="text-[11px] text-danger"
								>
									{errors.defaultBranch}
								</p>
							) : null}
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="register-timeout">Validation timeout (ms)</Label>
							<Input
								id="register-timeout"
								name="validationTimeoutMs"
								type="number"
								inputMode="numeric"
								min={1_000}
								max={900_000}
								step={1_000}
								defaultValue={300_000}
								aria-invalid={Boolean(errors.validationTimeoutMs)}
								aria-describedby={
									errors.validationTimeoutMs
										? "register-timeout-error"
										: "register-timeout-hint"
								}
							/>
							{errors.validationTimeoutMs ? (
								<p
									id="register-timeout-error"
									className="text-[11px] text-danger"
								>
									{errors.validationTimeoutMs}
								</p>
							) : (
								<p
									id="register-timeout-hint"
									className="text-[11px] text-ink-muted"
								>
									1,000 to 900,000 ms.
								</p>
							)}
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="register-command">
							Validation command (optional)
						</Label>
						<Input
							id="register-command"
							name="validationCommand"
							placeholder="bun run validate"
							autoComplete="off"
							spellCheck={false}
							maxLength={512}
							aria-invalid={Boolean(errors.validationCommand)}
							aria-describedby={
								errors.validationCommand
									? "register-command-error"
									: "register-command-hint"
							}
						/>
						{errors.validationCommand ? (
							<p
								id="register-command-error"
								className="text-[11px] text-danger"
							>
								{errors.validationCommand}
							</p>
						) : (
							<p
								id="register-command-hint"
								className="text-[11px] text-ink-muted"
							>
								Leave empty to register with no validation gate.
							</p>
						)}
					</div>
					{resultError ? (
						<div
							role="alert"
							className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger"
						>
							<WarningIcon size={14} className="mt-0.5 shrink-0" />
							<span>
								{resultError.message}
								{resultError.code === "INVALID_INPUT"
									? " Check the fields; a full name can be registered once per organization."
									: ""}
							</span>
						</div>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={busy}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>
							{busy ? "Registering…" : "Register"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Collapsed home for the manual path; the GitHub panel is the primary one. */
export function AdvancedRegistration({ canManage }: { canManage: boolean }) {
	if (!canManage) return null;
	return (
		<details className="border-t border-line-subtle pt-4">
			<summary className="cursor-pointer list-none text-xs text-ink-muted hover:text-ink-secondary">
				Advanced: register by full name
			</summary>
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<p className="max-w-[70ch] text-[11px] leading-5 text-ink-muted">
					Only needed when the GitHub App cannot be installed, for example on a
					repository owned by another account. The manual path does not verify
					installation access.
				</p>
				<RegisterRepositoryDialog compact />
			</div>
		</details>
	);
}

export function RepositoriesSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<div className="space-y-2 border-b border-line-subtle pb-6">
				<Skeleton className="h-7 w-48" />
				<Skeleton className="h-4 w-full max-w-xl" />
			</div>
			<div className="flex gap-3 border-y border-line-subtle py-3">
				<Skeleton className="h-9 flex-1" />
				<Skeleton className="h-9 w-48" />
			</div>
			<div className="divide-y divide-line-subtle border-y border-line-subtle">
				{SKELETON_ROWS.map((row) => (
					<Skeleton key={row} className="h-12 w-full" />
				))}
			</div>
		</div>
	);
}

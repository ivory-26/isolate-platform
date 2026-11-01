import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/common/relative-time";
import { PlusIcon, SearchIcon, WarningIcon } from "@/components/icons";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatDurationMs } from "@/lib/format";
import type {
	RegisterRepositoryInput,
	RepositoriesSearch,
	RepositoryProvider,
	RepositorySummary,
} from "./contracts";
import { registerRepositorySchema } from "./contracts";
import { repositoryKeys } from "./queries";
import { registerRepository } from "./repositories.functions";

const PROVIDER_LABEL: Record<RepositoryProvider, string> = {
	github: "GitHub",
};

const SKELETON_ROWS = ["one", "two", "three", "four", "five"];

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

export function RepositoriesTable({
	repositories,
	truncated,
}: {
	repositories: RepositorySummary[];
	truncated: boolean;
}) {
	return (
		<div className="space-y-2">
			<div className="border-y border-line-subtle">
				<Table>
					<caption className="sr-only">
						Repositories registered for the active organization, including
						provider, default branch, validation policy and registration time.
					</caption>
					<TableHeader>
						<TableRow className="border-line-subtle hover:bg-transparent">
							<TableHead scope="col" className="min-w-[240px]">
								Repository
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Default branch
							</TableHead>
							<TableHead scope="col" className="min-w-[260px]">
								Validation gate
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Registered
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{repositories.map((repository) => (
							<TableRow key={repository.id} className="h-11 border-line-subtle">
								<TableCell className="py-1 align-top">
									<span className="block truncate font-mono text-xs text-ink">
										{repository.externalFullName}
									</span>
									<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
										<span>{PROVIDER_LABEL[repository.provider]}</span>
										<span aria-hidden="true">·</span>
										<span className="font-mono">
											{repository.id.slice(0, 8)}…
										</span>
									</div>
								</TableCell>
								<TableCell className="py-1 align-top">
									<span className="font-mono text-xs text-ink-secondary">
										{repository.defaultBranch}
									</span>
								</TableCell>
								<TableCell className="max-w-[320px] py-1 align-top whitespace-normal">
									{repository.validationCommand ? (
										<div className="space-y-1">
											<code
												className="line-clamp-2 font-mono text-[11px] leading-5 break-all text-ink-secondary"
												title={repository.validationCommand}
											>
												{repository.validationCommand}
											</code>
											<p className="text-[11px] text-ink-muted tabular-nums">
												Timeout{" "}
												{formatDurationMs(repository.validationTimeoutMs)}
											</p>
										</div>
									) : (
										<span className="text-xs text-ink-muted">
											No validation gate configured
										</span>
									)}
								</TableCell>
								<TableCell className="py-1 align-top text-xs text-ink-secondary">
									<RelativeTime value={repository.createdAt} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{truncated ? (
				<p className="text-xs text-ink-muted">
					Showing the first 200 repositories. Narrow the search to see the rest.
				</p>
			) : null}
		</div>
	);
}

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

export function RegisterRepositoryDialog() {
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
				<Button type="button" size="sm">
					<PlusIcon />
					Register repository
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Register repository</DialogTitle>
					<DialogDescription>
						Add one repository to this organization. Validation runs argv-only;
						shell metacharacters are refused.
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

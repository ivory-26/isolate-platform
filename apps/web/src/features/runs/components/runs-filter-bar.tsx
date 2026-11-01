import { SearchIcon, XIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { statusLabel } from "@/lib/format";
import {
	RUN_SORTS,
	RUN_STATUS_FILTERS,
	type RunRepositoryOption,
	type RunsSearch,
} from "../contracts";

/**
 * URL-driven runs filters. Every control writes one typed search patch; the
 * route owns navigation so the URL stays the single source of truth.
 */

const SORT_LABELS: Record<(typeof RUN_SORTS)[number], string> = {
	created: "Newest first",
	updated: "Recently updated",
	status: "Status",
};

export function RunsFilterBar({
	repositories,
	search,
	onSearchChange,
	onReset,
	disabled = false,
}: {
	repositories: RunRepositoryOption[];
	search: RunsSearch;
	onSearchChange: (patch: Partial<RunsSearch>) => void;
	onReset: () => void;
	disabled?: boolean;
}) {
	const filtered =
		search.status !== "all" ||
		search.repo !== "" ||
		search.q !== "" ||
		search.sort !== "created";
	const repoOptions =
		search.repo !== "" && !repositories.some((repo) => repo.id === search.repo)
			? [...repositories, { id: search.repo, fullName: search.repo }]
			: repositories;

	return (
		<div className="flex flex-wrap items-end gap-3 rounded-lg border border-line-subtle bg-surface/40 px-4 py-3">
			<form
				key={search.q}
				className="flex min-w-[220px] flex-1 items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					const value = new FormData(event.currentTarget).get("q");
					onSearchChange({ q: typeof value === "string" ? value : "" });
				}}
			>
				<div className="min-w-0 flex-1 space-y-1">
					<Label htmlFor="runs-q" className="text-xs text-ink-muted">
						Search task id or branch
					</Label>
					<Input
						id="runs-q"
						name="q"
						defaultValue={search.q}
						placeholder="Task id or branch"
						autoComplete="off"
						spellCheck={false}
						disabled={disabled}
						className="font-mono text-xs"
					/>
				</div>
				<Button
					type="submit"
					variant="outline"
					size="icon-sm"
					aria-label="Apply search"
					title="Apply search"
					disabled={disabled}
				>
					<SearchIcon />
				</Button>
				{search.q !== "" ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Clear search"
						title="Clear search"
						disabled={disabled}
						onClick={() => onSearchChange({ q: "" })}
					>
						<XIcon />
					</Button>
				) : null}
			</form>

			<div className="space-y-1">
				<Label htmlFor="runs-status" className="text-xs text-ink-muted">
					Status
				</Label>
				<Select
					value={search.status}
					onValueChange={(value) =>
						onSearchChange({ status: value as RunsSearch["status"] })
					}
					disabled={disabled}
				>
					<SelectTrigger
						id="runs-status"
						size="sm"
						className="h-8 min-w-[150px]"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RUN_STATUS_FILTERS.map((status) => (
							<SelectItem key={status} value={status}>
								{status === "all" ? "All statuses" : statusLabel(status)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-1">
				<Label htmlFor="runs-repo" className="text-xs text-ink-muted">
					Repository
				</Label>
				<Select
					value={search.repo === "" ? "all" : search.repo}
					onValueChange={(value) =>
						onSearchChange({ repo: value === "all" ? "" : value })
					}
					disabled={disabled || repoOptions.length === 0}
				>
					<SelectTrigger id="runs-repo" size="sm" className="h-8 min-w-[190px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All repositories</SelectItem>
						{repoOptions.map((repo) => (
							<SelectItem key={repo.id} value={repo.id}>
								{repo.fullName}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-1">
				<Label htmlFor="runs-sort" className="text-xs text-ink-muted">
					Sort
				</Label>
				<Select
					value={search.sort}
					onValueChange={(value) =>
						onSearchChange({ sort: value as RunsSearch["sort"] })
					}
					disabled={disabled}
				>
					<SelectTrigger id="runs-sort" size="sm" className="h-8 min-w-[170px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RUN_SORTS.map((sort) => (
							<SelectItem key={sort} value={sort}>
								{SORT_LABELS[sort]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{filtered ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onReset}
					disabled={disabled}
				>
					<XIcon />
					Clear filters
				</Button>
			) : null}
		</div>
	);
}

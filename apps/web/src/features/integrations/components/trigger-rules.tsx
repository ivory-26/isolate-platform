import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ErrorState } from "@/components/common/error-state";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { EditIcon, PlusIcon, TrashIcon } from "@/components/icons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { repositoriesOptions } from "@/features/repositories/queries";
import type { IntegrationCatalogEntry } from "../catalog";
import {
	AUTONOMY_LABELS,
	formatEnvironmentList,
	type IntegrationSubscription,
	parseEnvironmentList,
	SEVERITIES,
	saveSubscriptionSchema,
} from "../contracts";
import {
	deleteSubscription,
	saveSubscription,
	setSubscriptionEnabled,
} from "../integrations.functions";
import { integrationKeys } from "../queries";

const SELECT_CLASS =
	"h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * Trigger rules for one connector. The form is the only write path; existing
 * rules can be edited, toggled or deleted in place. A2/A3 require a mapped
 * repository because the worker clones it.
 */
export function TriggerRulesPanel({
	entry,
	subscriptions,
	canManage,
	onChanged,
}: {
	entry: IntegrationCatalogEntry;
	subscriptions: readonly IntegrationSubscription[];
	canManage: boolean;
	onChanged: () => void;
}) {
	const [editing, setEditing] = useState<IntegrationSubscription | null>(null);
	const [deleteTarget, setDeleteTarget] =
		useState<IntegrationSubscription | null>(null);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const toggle = useMutation({
		mutationFn: (input: { id: string; enabled: boolean }) =>
			setSubscriptionEnabled({ data: input }),
		onSuccess: (result) => {
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			onChanged();
		},
		onError: () => setError("The rule could not be updated."),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteSubscription({ data: { id } }),
		onSuccess: (result) => {
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			setDeleteTarget(null);
			if (editing !== null) setEditing(null);
			onChanged();
			void queryClient.invalidateQueries({
				queryKey: integrationKeys.detail(entry.id),
			});
		},
		onError: () => setError("The rule could not be deleted."),
	});

	return (
		<ConsoleSection
			id="trigger-rules"
			title="Trigger rules"
			description="An event creates a task only when it matches an enabled rule. Production critical/high at A2 is the safe default."
		>
			{!canManage ? (
				<ConsoleNote role="note" className="mb-3">
					Your role can read rules but not change them. Owners and admins manage
					triggers.
				</ConsoleNote>
			) : (
				<TriggerForm
					key={editing?.id ?? "new"}
					entry={entry}
					editing={editing}
					onCancelEdit={() => setEditing(null)}
					onSaved={() => {
						setEditing(null);
						setError(null);
						onChanged();
					}}
					onError={setError}
				/>
			)}

			{error ? (
				<p
					role="alert"
					className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			) : null}

			{subscriptions.length === 0 ? (
				<EmptyRow
					title="No trigger rules"
					description="Events are recorded in the delivery ledger but create no task until a rule matches."
				/>
			) : (
				<div className="mt-4 border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Trigger rules for {entry.label}
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col" className="min-w-[180px]">
									Rule
								</TableHead>
								<TableHead scope="col" className="min-w-[150px]">
									Events
								</TableHead>
								<TableHead scope="col" className="w-[110px]">
									Min severity
								</TableHead>
								<TableHead scope="col" className="min-w-[180px]">
									Repository
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Autonomy
								</TableHead>
								<TableHead scope="col" className="w-[90px]">
									Enabled
								</TableHead>
								<TableHead scope="col" className="w-[130px] text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{subscriptions.map((rule) => (
								<TableRow key={rule.id} className="h-12 border-line-subtle">
									<TableCell className="py-2">
										<span className="text-sm text-ink">{rule.displayName}</span>
										<p className="mt-0.5 text-[11px] text-ink-muted">
											{formatEnvironmentList(rule.environmentAllowlist) ||
												"all"}
										</p>
									</TableCell>
									<TableCell className="py-2 text-xs text-ink-secondary">
										{rule.eventKinds.length === 0
											? "Connector default"
											: rule.eventKinds.join(", ")}
									</TableCell>
									<TableCell className="py-2 text-xs text-ink-secondary">
										{rule.minSeverity}
									</TableCell>
									<TableCell className="py-2 text-xs text-ink-secondary">
										{rule.repositoryName ?? (
											<span className="text-ink-muted">Unmapped</span>
										)}
										{rule.baseBranch ? (
											<span className="ml-1 font-mono text-[11px] text-ink-muted">
												@{rule.baseBranch}
											</span>
										) : null}
									</TableCell>
									<TableCell className="py-2 text-xs text-ink-secondary">
										{AUTONOMY_LABELS[rule.autonomyLevel]}
									</TableCell>
									<TableCell className="py-2">
										<Switch
											checked={rule.enabled}
											disabled={!canManage || toggle.isPending}
											aria-label={`Enable ${rule.displayName}`}
											onCheckedChange={(enabled) =>
												toggle.mutate({ id: rule.id, enabled })
											}
										/>
									</TableCell>
									<TableCell className="py-2 text-right">
										{canManage ? (
											<div className="flex items-center justify-end gap-1">
												<Button
													type="button"
													variant="ghost"
													size="xs"
													onClick={() => setEditing(rule)}
												>
													<EditIcon size={14} />
													Edit
													<span className="sr-only"> {rule.displayName}</span>
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="xs"
													className="text-danger hover:text-danger"
													onClick={() => setDeleteTarget(rule)}
												>
													<TrashIcon size={14} />
													Delete
													<span className="sr-only"> {rule.displayName}</span>
												</Button>
											</div>
										) : (
											<span className="text-xs text-ink-muted">—</span>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this trigger?</AlertDialogTitle>
						<AlertDialogDescription>
							New matching events stop creating tasks. Existing deliveries and
							tasks keep their history.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={remove.isPending}>
							Keep rule
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={remove.isPending || deleteTarget === null}
							onClick={(event) => {
								event.preventDefault();
								if (deleteTarget === null) return;
								remove.mutate(deleteTarget.id);
							}}
						>
							<TrashIcon />
							{remove.isPending ? "Deleting…" : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</ConsoleSection>
	);
}

function TriggerForm({
	entry,
	editing,
	onCancelEdit,
	onSaved,
	onError,
}: {
	entry: IntegrationCatalogEntry;
	editing: IntegrationSubscription | null;
	onCancelEdit: () => void;
	onSaved: () => void;
	onError: (message: string) => void;
}) {
	const [enabled, setEnabled] = useState(editing?.enabled ?? true);
	const repositories = useQuery(repositoriesOptions({ q: "" }));
	const save = useMutation({
		mutationFn: saveSubscription,
		onSuccess: (result) => {
			if (!result.ok) {
				onError(result.error.message);
				return;
			}
			onSaved();
		},
		onError: () => onError("The rule could not be saved."),
	});
	const options = repositories.data?.ok
		? repositories.data.value.repositories
		: [];

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (save.isPending) return;
		const form = new FormData(event.currentTarget);
		const environments = parseEnvironmentList(
			String(form.get("environmentAllowlist") ?? ""),
		);
		if (!environments.ok) {
			onError(environments.error);
			return;
		}
		const parsed = saveSubscriptionSchema.safeParse({
			...(editing === null ? {} : { id: editing.id }),
			connectorId: entry.id,
			displayName: String(form.get("displayName") ?? ""),
			eventKinds: form.getAll("eventKinds").map(String),
			environmentAllowlist: environments.values,
			minSeverity: String(form.get("minSeverity") ?? "high"),
			repositoryId: String(form.get("repositoryId") ?? "") || null,
			baseBranch: String(form.get("baseBranch") ?? "").trim() || null,
			autonomyLevel: String(form.get("autonomyLevel") ?? "A2"),
			enabled,
		});
		if (!parsed.success) {
			onError(
				parsed.error.issues[0]?.message ??
					"Check the rule fields and try again.",
			);
			return;
		}
		save.mutate({ data: parsed.data });
	}

	return (
		<form
			onSubmit={onSubmit}
			className="space-y-4 border-y border-line-subtle py-4"
			noValidate
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<p className="text-xs font-medium text-ink">
					{editing === null ? "New rule" : `Edit ${editing.displayName}`}
				</p>
				{editing !== null ? (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={onCancelEdit}
					>
						Cancel edit
					</Button>
				) : null}
			</div>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<div className="space-y-1.5">
					<Label htmlFor="rule-name">Rule name</Label>
					<Input
						id="rule-name"
						name="displayName"
						required
						maxLength={100}
						autoComplete="off"
						defaultValue={editing?.displayName ?? "Production critical/high"}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="rule-environments">Environments</Label>
					<Input
						id="rule-environments"
						name="environmentAllowlist"
						autoComplete="off"
						defaultValue={formatEnvironmentList(
							editing?.environmentAllowlist ?? ["production"],
						)}
						aria-describedby="rule-environments-hint"
					/>
					<p id="rule-environments-hint" className="text-[11px] text-ink-muted">
						Comma separated. Production only is the safe default.
					</p>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="rule-severity">Minimum severity</Label>
					<select
						id="rule-severity"
						name="minSeverity"
						className={SELECT_CLASS}
						defaultValue={editing?.minSeverity ?? "high"}
					>
						{SEVERITIES.map((severity) => (
							<option key={severity} value={severity}>
								{severity}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="rule-repository">Repository</Label>
					<select
						id="rule-repository"
						name="repositoryId"
						className={SELECT_CLASS}
						defaultValue={editing?.repositoryId ?? ""}
					>
						<option value="">Unmapped (A0 only)</option>
						{options.map((repository) => (
							<option key={repository.id} value={repository.id}>
								{repository.externalFullName}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="rule-branch">Base branch</Label>
					<Input
						id="rule-branch"
						name="baseBranch"
						maxLength={255}
						autoComplete="off"
						defaultValue={editing?.baseBranch ?? ""}
						placeholder="main"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="rule-autonomy">Autonomy</Label>
					<select
						id="rule-autonomy"
						name="autonomyLevel"
						className={SELECT_CLASS}
						defaultValue={
							editing?.autonomyLevel === "A1"
								? "A2"
								: (editing?.autonomyLevel ?? "A2")
						}
					>
						<option value="A0">A0 Observe</option>
						<option value="A2">A2 Prepare fix</option>
						<option value="A3">A3 Propose PR</option>
						<option value="A1" disabled>
							A1 Investigate (unsupported)
						</option>
					</select>
				</div>
			</div>

			<fieldset className="space-y-2">
				<legend className="text-xs font-medium text-ink">Event kinds</legend>
				<p className="text-[11px] text-ink-muted">
					Nothing selected means the connector's default event set, capped at 16
					kinds.
				</p>
				<div className="flex flex-wrap gap-x-5 gap-y-2">
					{entry.eventKinds.map((kind) => (
						<label
							key={kind}
							className="flex items-center gap-2 text-xs text-ink-secondary"
						>
							<input
								type="checkbox"
								name="eventKinds"
								value={kind}
								defaultChecked={editing?.eventKinds.includes(kind) ?? false}
								className="size-3.5 rounded border-line accent-[var(--color-electric-blue)]"
							/>
							<span className="font-mono text-[11px]">{kind}</span>
						</label>
					))}
				</div>
			</fieldset>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<label
					htmlFor="rule-enabled"
					className="flex items-center gap-2 text-xs text-ink-secondary"
				>
					<Switch
						id="rule-enabled"
						checked={enabled}
						onCheckedChange={setEnabled}
					/>
					Enabled
				</label>
				<Button type="submit" disabled={save.isPending}>
					<PlusIcon />
					{save.isPending
						? "Saving…"
						: editing === null
							? "Create rule"
							: "Save rule"}
				</Button>
			</div>

			{repositories.error ? (
				<ErrorState
					title="Repositories could not be loaded"
					message="A2 and A3 rules need a repository; retry before saving one."
					onRetry={() => void repositories.refetch()}
				/>
			) : null}
			{repositories.isPending ? null : options.length === 0 ? (
				<ConsoleNote role="note" tone="warning">
					No repository is imported. You can still create an A0 Observe rule;
					A2/A3 will be refused until a repository exists.
				</ConsoleNote>
			) : null}
		</form>
	);
}

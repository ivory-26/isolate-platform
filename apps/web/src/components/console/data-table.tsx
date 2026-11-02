import type { ReactNode } from "react";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type DataTableColumn = {
	/** Stable key for React; defaults to the column index. */
	key?: string;
	header: ReactNode;
	/** Align the header with right-aligned numeric cells. */
	align?: "left" | "right";
	/** Extra classes for the header cell only. */
	className?: string;
};

export type DataTableProps = {
	/** Accessible description, rendered as the table caption. */
	caption: ReactNode;
	columns: readonly DataTableColumn[];
	/** Body rows (`TableRow` elements); ignored when `isEmpty`. */
	children?: ReactNode;
	/** Render the empty state instead of body rows. */
	isEmpty?: boolean;
	/** Empty state content; a plain sentence is enough. */
	empty?: ReactNode;
	/** Optional pagination footer, e.g. `<Pagination … />`. */
	pagination?: ReactNode;
	/** Optional footnote rendered under the table. */
	footer?: ReactNode;
	className?: string;
};

/**
 * A console table built from the shared Table primitives: caption, generated
 * column headers, body rows, an explicit empty row and an optional pagination
 * footer. Vertical growth is always the page scroll; the table only scrolls
 * horizontally when its columns genuinely cannot fit.
 */
export function DataTable({
	caption,
	columns,
	children,
	isEmpty = false,
	empty,
	pagination,
	footer,
	className,
}: DataTableProps) {
	return (
		<div className={cn("space-y-2", className)}>
			<div className="border-y border-line-subtle">
				<Table>
					<TableCaption className="sr-only">{caption}</TableCaption>
					<TableHeader>
						<TableRow className="border-line-subtle hover:bg-transparent">
							{columns.map((column, index) => (
								<TableHead
									key={column.key ?? `column-${index}`}
									scope="col"
									className={cn(
										column.align === "right" && "text-right",
										column.className,
									)}
								>
									{column.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{isEmpty ? (
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableCell
									colSpan={columns.length}
									className="py-10 text-center text-xs whitespace-normal text-ink-muted"
								>
									{empty ?? "No rows to show."}
								</TableCell>
							</TableRow>
						) : (
							children
						)}
					</TableBody>
				</Table>
			</div>
			{pagination ? <div>{pagination}</div> : null}
			{footer ? <div>{footer}</div> : null}
		</div>
	);
}

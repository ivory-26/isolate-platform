import { CopyButton } from "@/components/common/copy-button";
import { WarningIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/format";
import type { IssuedDeviceToken } from "../contracts";

/**
 * One-time device token display.
 *
 * The token lives only in the caller's component state. It is never written to
 * storage or a query cache; closing the dialog discards it.
 */
export function TokenReveal({ issued }: { issued: IssuedDeviceToken }) {
	return (
		<div className="space-y-3">
			<div
				role="alert"
				className="flex items-start gap-2 rounded-md border border-warning/35 bg-warning/10 p-3 text-warning"
			>
				<WarningIcon size={16} className="mt-0.5 shrink-0" />
				<p className="text-xs leading-5">
					This token is shown once and cannot be recovered. Copy it into the
					device daemon now; closing this dialog clears it.
				</p>
			</div>
			<div className="space-y-1.5">
				<p className="text-xs font-medium text-ink-muted">Device token</p>
				<div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5">
					<code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-ink">
						{issued.token}
					</code>
					<CopyButton value={issued.token} label="Copy device token" />
				</div>
			</div>
			<p className="text-xs leading-5 text-ink-muted">
				Expires{" "}
				<time dateTime={issued.expiresAt} className="tabular-nums text-ink">
					{formatDateTime(issued.expiresAt)}
				</time>
				. Rotate before it expires; the server stores only its hash.
			</p>
		</div>
	);
}

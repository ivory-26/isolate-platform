import { RelativeTime } from "@/components/common/relative-time";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	type ConnectorVerificationResult,
	isVerifiableStatus,
	isVerificationReasonCode,
	verificationFailureMessage,
	verificationIncompleteMessage,
	verificationRejectionMessage,
	verificationStatusCopy,
} from "../verification";

/**
 * Pure verification controls.
 *
 * The panel only receives a stored status, the last verification time and the
 * latest bounded result. It renders exactly what the server reported: only an
 * active result is described as connected, an invalid result keeps the
 * reconnect path visible, and an unanswered relay keeps the prior status.
 */
export function VerificationControls({
	status,
	storedVerifiedAt,
	outcome,
	isPending,
	onVerify,
}: {
	status: string;
	storedVerifiedAt: string | null;
	outcome: ConnectorVerificationResult | null;
	isPending: boolean;
	onVerify: () => void;
}) {
	const resultStatus = outcome?.ok === true ? outcome.value.status : null;
	const displayStatus = resultStatus ?? status;
	const copy = verificationStatusCopy(displayStatus);
	const verifiedAt =
		(outcome?.ok === true ? outcome.value.verifiedAt : null) ??
		storedVerifiedAt;
	const canVerify = isVerifiableStatus(displayStatus);
	const retryAfter =
		outcome?.ok === false ? outcome.error.retryAfterSeconds : undefined;

	return (
		<ConsoleSection
			id="verification"
			title="Verification"
			description="Verification asks the relay for exactly one cheap authenticated read. Only a successful read marks the connection active."
			action={
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onVerify}
					disabled={isPending || !canVerify}
					aria-busy={isPending}
				>
					<RefreshIcon />
					{isPending ? "Verifying…" : "Verify connection"}
				</Button>
			}
		>
			<div className="space-y-3 border-y border-line-subtle py-4">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<StatusMark status={displayStatus} label={copy.label} />
					{displayStatus === "active" ? (
						<span className="text-xs text-ink-secondary">
							{verifiedAt ? (
								<>
									Verified <RelativeTime value={verifiedAt} />
								</>
							) : (
								"Verified time not recorded"
							)}
						</span>
					) : null}
					{outcome?.ok === true && outcome.value.status === "active" ? (
						<span className="font-mono text-[11px] text-ink-muted">
							Reason OK
						</span>
					) : null}
				</div>

				<p className="max-w-[70ch] text-xs leading-5 text-ink-secondary">
					{copy.description}
				</p>

				{isPending ? (
					<output className="block text-xs leading-5 text-ink-secondary">
						Waiting for the relay to answer a bounded read. The connection is
						not verified until this completes.
					</output>
				) : null}

				{outcome?.ok === false ? (
					<ConsoleNote tone="danger" role="alert">
						{verificationFailureMessage(outcome.error.code)}
						{typeof retryAfter === "number" && retryAfter > 0
							? ` Try again in ${Math.min(Math.ceil(retryAfter), 3_600)} seconds.`
							: null}
					</ConsoleNote>
				) : null}

				{outcome?.ok === true && outcome.value.status === "active" ? (
					<ConsoleNote role="status">
						Verification succeeded. The relay completed one bounded
						authenticated read and the connection is now active.
					</ConsoleNote>
				) : null}

				{outcome?.ok === true && outcome.value.status === "invalid" ? (
					<ConsoleNote tone="danger" role="alert">
						{verificationRejectionMessage(outcome.value.reasonCode)} Reconnect
						from the Connection section, then verify again.
					</ConsoleNote>
				) : null}

				{outcome?.ok === true &&
				outcome.value.status === "pending_validation" ? (
					<ConsoleNote tone="warning" role="status">
						{verificationIncompleteMessage(outcome.value.reasonCode)}
					</ConsoleNote>
				) : null}

				{!canVerify && !isPending ? (
					<ConsoleNote role="note">
						{displayStatus === "revoked"
							? "A revoked connection cannot be verified. Pair it again from the Connection section first."
							: "This connection cannot be verified in its current state. Pair it again from the Connection section first."}
					</ConsoleNote>
				) : null}

				{outcome?.ok === true &&
				outcome.value.status === "invalid" &&
				!isVerificationReasonCode(outcome.value.reasonCode) ? (
					<ConsoleNote role="note">
						The relay returned a reason code this client does not recognise; the
						connection is still reported as failed.
					</ConsoleNote>
				) : null}
			</div>
		</ConsoleSection>
	);
}

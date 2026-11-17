import type { ReactNode } from "react";
import { ApprovalPayload, PrHandoff } from "./illustrations/approval-payload";
import { AuditRecord } from "./illustrations/audit-record";
import {
	SandboxBoundary,
	ValidationGate,
} from "./illustrations/sandbox-boundary";

export type FeatureKey = "sandbox" | "approval" | "record";

type Feature = {
	primary: ReactNode;
	inset?: ReactNode;
};

const FEATURES: Record<FeatureKey, Feature> = {
	sandbox: {
		primary: <SandboxBoundary />,
		inset: <ValidationGate />,
	},
	approval: {
		primary: <ApprovalPayload />,
		inset: <PrHandoff />,
	},
	record: {
		primary: <AuditRecord />,
	},
};

export function FeatureVisual({ feature }: { feature: FeatureKey }) {
	const config = FEATURES[feature];
	return (
		<figure className="wf-figure">
			{config.primary}
			{config.inset ? (
				<div className="wf-figure-inset">{config.inset}</div>
			) : null}
		</figure>
	);
}

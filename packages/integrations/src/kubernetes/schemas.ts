import { z } from "zod";

/**
 * Allowlisted Kubernetes wire schemas.
 *
 * Kubernetes returns far more fields than the connector may use (`spec`,
 * `managedFields`, status details, environment variables). These schemas are
 * plain `z.object`s on purpose: Zod strips unknown keys, so only the fields
 * declared here survive into context. Rejecting the whole object because the
 * API added a field would turn harmless provider drift into missing evidence.
 *
 * Every string, map and array is bounded. Constructed tool input schemas live
 * in `tools.ts` and are `strictObject`s: an unknown argument such as
 * `follow=true` must be rejected, not ignored.
 */

export const KUBERNETES_MAX_NAME_CHARS = 253;
export const KUBERNETES_MAX_NAMESPACE_CHARS = 63;
export const KUBERNETES_MAX_UID_CHARS = 64;
export const KUBERNETES_MAX_TIMESTAMP_CHARS = 64;
export const KUBERNETES_MAX_REASON_CHARS = 128;
export const KUBERNETES_MAX_MESSAGE_CHARS = 4096;
export const KUBERNETES_MAX_CONTAINERS = 64;
export const KUBERNETES_MAX_CONDITIONS = 32;
export const KUBERNETES_MAX_ITEMS = 50;
export const KUBERNETES_MAX_LABELS = 64;
export const KUBERNETES_MAX_OWNER_REFERENCES = 16;

const boundedName = z.string().min(1).max(KUBERNETES_MAX_NAME_CHARS);
const boundedNamespace = z.string().max(KUBERNETES_MAX_NAMESPACE_CHARS);
const boundedUid = z.string().min(1).max(KUBERNETES_MAX_UID_CHARS);
const boundedTimestamp = z
	.string()
	.max(KUBERNETES_MAX_TIMESTAMP_CHARS)
	.nullable()
	.optional();
const boundedReason = z.string().max(KUBERNETES_MAX_REASON_CHARS);
const boundedMessage = z.string().max(KUBERNETES_MAX_MESSAGE_CHARS);

const boundedLabelMap = z
	.record(
		z.string().min(1).max(KUBERNETES_MAX_NAME_CHARS),
		z.string().max(1024),
	)
	.refine(
		(record) => Object.keys(record).length <= KUBERNETES_MAX_LABELS,
		"too many labels",
	);

const boundedOwnerReference = z.object({
	apiVersion: z.string().max(64).optional(),
	kind: z.string().max(64),
	name: boundedName,
	uid: boundedUid.optional(),
	controller: z.boolean().optional(),
});

export const kubernetesOwnerReferenceSchema = boundedOwnerReference;

/** Shared `metadata` projection; `managedFields` and friends are stripped. */
export const kubernetesObjectMetaSchema = z.object({
	name: boundedName,
	namespace: boundedNamespace.optional(),
	uid: boundedUid.optional(),
	generation: z.number().int().nonnegative().optional(),
	resourceVersion: z.string().max(64).optional(),
	creationTimestamp: boundedTimestamp,
	labels: boundedLabelMap.optional(),
	annotations: boundedLabelMap.optional(),
	ownerReferences: z
		.array(boundedOwnerReference)
		.max(KUBERNETES_MAX_OWNER_REFERENCES)
		.optional(),
});
export type KubernetesObjectMeta = z.output<typeof kubernetesObjectMetaSchema>;

export const kubernetesInvolvedObjectSchema = z.object({
	apiVersion: z.string().max(64).optional(),
	kind: z.string().min(1).max(64),
	name: boundedName,
	namespace: boundedNamespace.optional(),
	uid: boundedUid.optional(),
	resourceVersion: z.string().max(64).optional(),
	fieldPath: z.string().max(512).optional(),
});
export type KubernetesInvolvedObject = z.output<
	typeof kubernetesInvolvedObjectSchema
>;

/** core/v1 Event, as fetched for one involved object. */
export const kubernetesEventSchema = z.object({
	metadata: kubernetesObjectMetaSchema,
	involvedObject: kubernetesInvolvedObjectSchema,
	reason: boundedReason.optional(),
	message: boundedMessage.optional(),
	type: z.string().max(32).optional(),
	count: z.number().int().nonnegative().nullable().optional(),
	firstTimestamp: boundedTimestamp,
	lastTimestamp: boundedTimestamp,
	eventTime: boundedTimestamp,
	reportingComponent: z.string().max(128).optional(),
	reportingInstance: z.string().max(128).optional(),
	source: z
		.object({
			component: z.string().max(128).optional(),
			host: z.string().max(253).optional(),
		})
		.optional(),
});
export type KubernetesEvent = z.output<typeof kubernetesEventSchema>;

export const kubernetesEventListSchema = z.object({
	metadata: z
		.object({
			resourceVersion: z.string().max(64).optional(),
			continue: z.string().max(1024).optional(),
			remainingItemCount: z.number().int().nonnegative().optional(),
		})
		.optional(),
	items: z.array(kubernetesEventSchema).max(KUBERNETES_MAX_ITEMS),
});
export type KubernetesEventList = z.output<typeof kubernetesEventListSchema>;

export const kubernetesResourceRequirementsSchema = z.object({
	limits: boundedLabelMap.optional(),
	requests: boundedLabelMap.optional(),
});

export const kubernetesContainerStateSchema = z.object({
	waiting: z
		.object({
			reason: boundedReason.optional(),
			message: boundedMessage.optional(),
		})
		.optional(),
	running: z
		.object({
			startedAt: boundedTimestamp,
		})
		.optional(),
	terminated: z
		.object({
			reason: boundedReason.optional(),
			message: boundedMessage.optional(),
			exitCode: z.number().int().optional(),
			signal: z.number().int().optional(),
			startedAt: boundedTimestamp,
			finishedAt: boundedTimestamp,
		})
		.optional(),
});
export type KubernetesContainerState = z.output<
	typeof kubernetesContainerStateSchema
>;

export const kubernetesContainerStatusSchema = z.object({
	name: boundedName,
	ready: z.boolean().optional(),
	restartCount: z.number().int().nonnegative().optional(),
	image: z.string().max(512).optional(),
	imageID: z.string().max(512).optional(),
	state: kubernetesContainerStateSchema.optional(),
	lastState: kubernetesContainerStateSchema.optional(),
});
export type KubernetesContainerStatus = z.output<
	typeof kubernetesContainerStatusSchema
>;

export const kubernetesConditionSchema = z.object({
	type: z.string().max(64),
	status: z.string().max(16),
	reason: boundedReason.optional(),
	message: boundedMessage.optional(),
	lastTransitionTime: boundedTimestamp,
	lastProbeTime: boundedTimestamp,
});
export type KubernetesCondition = z.output<typeof kubernetesConditionSchema>;

export const kubernetesPodSchema = z.object({
	metadata: kubernetesObjectMetaSchema,
	spec: z
		.object({
			containers: z
				.array(
					z.object({
						name: boundedName,
						image: z.string().max(512).optional(),
						resources: kubernetesResourceRequirementsSchema.optional(),
					}),
				)
				.max(KUBERNETES_MAX_CONTAINERS)
				.optional(),
		})
		.optional(),
	status: z
		.object({
			phase: z.string().max(32).optional(),
			reason: boundedReason.optional(),
			message: boundedMessage.optional(),
			conditions: z
				.array(kubernetesConditionSchema)
				.max(KUBERNETES_MAX_CONDITIONS)
				.optional(),
			containerStatuses: z
				.array(kubernetesContainerStatusSchema)
				.max(KUBERNETES_MAX_CONTAINERS)
				.optional(),
			initContainerStatuses: z
				.array(kubernetesContainerStatusSchema)
				.max(KUBERNETES_MAX_CONTAINERS)
				.optional(),
		})
		.optional(),
});
export type KubernetesPod = z.output<typeof kubernetesPodSchema>;

export const kubernetesDeploymentSchema = z.object({
	metadata: kubernetesObjectMetaSchema,
	spec: z
		.object({
			replicas: z.number().int().nonnegative().optional(),
			selector: z
				.object({ matchLabels: boundedLabelMap.optional() })
				.optional(),
		})
		.optional(),
	status: z
		.object({
			observedGeneration: z.number().int().nonnegative().optional(),
			replicas: z.number().int().nonnegative().optional(),
			updatedReplicas: z.number().int().nonnegative().optional(),
			readyReplicas: z.number().int().nonnegative().optional(),
			availableReplicas: z.number().int().nonnegative().optional(),
			unavailableReplicas: z.number().int().nonnegative().optional(),
			conditions: z
				.array(kubernetesConditionSchema)
				.max(KUBERNETES_MAX_CONDITIONS)
				.optional(),
		})
		.optional(),
});
export type KubernetesDeployment = z.output<typeof kubernetesDeploymentSchema>;

export const kubernetesReplicaSetSchema = z.object({
	metadata: kubernetesObjectMetaSchema,
	spec: z
		.object({
			replicas: z.number().int().nonnegative().optional(),
			template: z
				.object({
					spec: z
						.object({
							containers: z
								.array(
									z.object({
										name: boundedName,
										image: z.string().max(512).optional(),
									}),
								)
								.max(KUBERNETES_MAX_CONTAINERS)
								.optional(),
						})
						.optional(),
				})
				.optional(),
		})
		.optional(),
	status: z
		.object({
			replicas: z.number().int().nonnegative().optional(),
			readyReplicas: z.number().int().nonnegative().optional(),
			availableReplicas: z.number().int().nonnegative().optional(),
		})
		.optional(),
});
export type KubernetesReplicaSet = z.output<typeof kubernetesReplicaSetSchema>;

export const kubernetesReplicaSetListSchema = z.object({
	metadata: z.object({ continue: z.string().max(1024).optional() }).optional(),
	items: z.array(kubernetesReplicaSetSchema).max(20),
});
export type KubernetesReplicaSetList = z.output<
	typeof kubernetesReplicaSetListSchema
>;

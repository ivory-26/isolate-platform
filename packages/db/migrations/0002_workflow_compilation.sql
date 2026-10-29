-- Workflow compilation persistence (ARCHITECTURE.md §6, W3-D).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001;
-- migration application belongs to the coordinator, never to repositories.
-- Plans are insert-only through the repository: duplicate pins are conflicts,
-- not updates. Rejections are append-only history, not a mutable last error.
--
-- Both composite foreign keys matter: separate organization/definition FKs
-- would allow a tenant to attach data to another tenant's definition, and a
-- definition FK alone would permit artifacts for nonexistent versions.

-- ---------------------------------------------------------------------------
-- Tenant ownership key -------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS workflow_definitions_org_id_unique
	ON workflow_definitions (organization_id, id);

-- ---------------------------------------------------------------------------
-- Compiled plans (one immutable artifact per authored version) ----------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS compiled_plans (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	workflow_definition_id uuid NOT NULL,
	workflow_version integer NOT NULL CHECK (workflow_version >= 1),
	-- CompiledWorkflow: workflowId, versionPinned, planId, entries, steps, edges.
	plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT compiled_plans_org_definition_fk
		FOREIGN KEY (organization_id, workflow_definition_id)
		REFERENCES workflow_definitions (organization_id, id),
	CONSTRAINT compiled_plans_definition_version_fk
		FOREIGN KEY (workflow_definition_id, workflow_version)
		REFERENCES workflow_versions (definition_id, version),
	CONSTRAINT compiled_plans_org_definition_version_unique
		UNIQUE (organization_id, workflow_definition_id, workflow_version),
	CONSTRAINT compiled_plans_plan_pin_check CHECK (
		plan ->> 'workflowId' IS NOT NULL
		AND plan ->> 'workflowId' = workflow_definition_id::text
		AND plan -> 'versionPinned' IS NOT NULL
		AND plan -> 'versionPinned' = to_jsonb(workflow_version)
	)
);

-- ---------------------------------------------------------------------------
-- Workflow rejection history -------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rejection_issues (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	workflow_definition_id uuid NOT NULL,
	workflow_version integer NOT NULL CHECK (workflow_version >= 1),
	-- Compiler issues are {path, code, message}.
	issues jsonb NOT NULL CHECK (
		CASE WHEN jsonb_typeof(issues) = 'array'
			THEN jsonb_array_length(issues) > 0 ELSE false END
	),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT rejection_issues_org_definition_fk
		FOREIGN KEY (organization_id, workflow_definition_id)
		REFERENCES workflow_definitions (organization_id, id),
	CONSTRAINT rejection_issues_definition_version_fk
		FOREIGN KEY (workflow_definition_id, workflow_version)
		REFERENCES workflow_versions (definition_id, version)
);

CREATE INDEX IF NOT EXISTS rejection_issues_org_definition_version_created_idx
	ON rejection_issues (organization_id, workflow_definition_id, workflow_version, created_at DESC, id DESC);

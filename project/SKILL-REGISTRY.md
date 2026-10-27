# Skill registry

Installed/considered skills with source, owner, and review status. Policy lives in `SKILLS.md`.

## Active in harness (2026-10-27, reviewed by coordinator)

| Skill | Source | Used by | Review status |
|---|---|---|---|
| context7-mcp | Available harness skill | All sprint agents (library docs: Mastra, tanstack, postgres, zod) | Approved for read-only doc lookups; agents must still verify against installed d.ts (recorded lesson: docs drift) |
| Neon MCP (`tools.Neon.*`) | Available MCP server | Coordinator only (migration application, SQL verification). Write/destructive tools require explicit user approval | Approved with guardrails: `delete_project` never called autonomously |
| mastra-docs MCP | Available MCP server | SB2 (Mastra API orientation) | Approved; biased-review: treat docs as orientation, d.ts as authority (2026-10-25 entry) |
| opencode MCP | Available MCP server | Coordinator session management/worktrees | Approved |
| find-skills | Available harness skill | Coordinator, on demand | Used 2026-10-27 to discover `deckardger/tanstack-agent-skills`; installed 3 skills below and reviewed per SKILLS.md checklist |

## Installed wave-3 (2026-10-27, coordinator-reviewed)

| Skill | Source | Used by | Review status |
|---|---|---|---|
| tanstack-start-best-practices | `deckardger/tanstack-agent-skills` (skills.sh), user-level `~/.agents/skills` | W3-U (web scaffold agent) | Approved: guidance-only rules (server functions, secrets-server-side, CSRF). No policy-bypass or secret-disclosure content found in review |
| tanstack-router-best-practices | Same source | W3-U | Approved (same review) |
| tanstack-query-best-practices | Same source | W3-U | Approved (same review) |

## Deliberately not installed this sprint

Skills for CI/CD, threat modeling, and per-provider SDKs were NOT installed — sprint gates run via repository scripts (`bun run validate`), and the sprint briefs encode required security behavior directly in agent instructions. Add candidates via this registry when a concrete need appears, applying the `SKILLS.md` review checklist.

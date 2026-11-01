# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Platform engineers, SRE/DevSecOps engineers, and engineering leads at small teams who submit coding tasks to autonomous agents, review the resulting changes, and approve sensitive actions. They work in a desktop browser during incident response and routine maintenance, often under time pressure.

## Product Purpose

Isolate is an autonomous DevSecOps control plane. It accepts engineering tasks, runs a coding agent in an isolated sandbox, validates the change, and pauses at human approval gates before pushing branches or opening pull requests. It ingests incidents from connected tools — GitHub plus nine device-held connectors — and acts on them. Success means a developer can see what is running, what needs attention, what is safe to approve, and what action to take next.

## Positioning

Connectors execute on the user's device with device-held credentials; the platform server stores only token hashes and connector metadata, never vendor keys. Execution is sandboxed, and every sensitive action is approval-gated with a payload-bound decision and a durable audit trail.

## Operating Context

Primary use is a desktop browser at 1280px or wider; the interface must remain usable when stacked on mobile. Incident response is time-pressured and approvals happen in short sessions. Data flows through task submission → workflow compilation → worker execution → run events and artifacts (diffs, logs, reports) → approvals → branch push and PR creation, with usage records and connector device calls alongside.

## Capabilities and Constraints

Implemented and server-authoritative: Neon Managed Better Auth with Google sign-in; organizations and memberships (`viewer` through `owner`); task submission, runs list, task lifecycle; run events, artifacts, approvals, retry; GitHub App reads and scoped writes; ten connectors through the device daemon; trace read API; usage records; device register/rotate/revoke; connector connect/list/revoke.

Constraints: database, provider, sandbox, worker, MCP, and credential-bearing logic stay server-side; the browser consumes safe server projections only. Never present an unimplemented capability as live. No arbitrary `eval` or user-authored script execution. The visual workflow canvas builder is deferred beyond this wave. Charts appear only where measured data exists. Secrets never enter query parameters or client code.

## Brand Commitments

Product name: Isolate. Core palette is fixed: Midnight Black `#02070A`, Electric Blue `#0297DE`, Cantaloupe Orange `#FC734D`. The binding design system of record is `project/design.md`. Iconography follows the Reicon duotone language; because the Reicon MCP is unavailable this session, one documented duotone fallback family is used rather than mixing icon libraries. Fireworks, Baseten, and Modal are directional references, not material to reproduce.

## Evidence on Hand

Real server-backed data through Neon (organizations, users, repositories, workflow definitions, tasks, runs, approvals, artifacts, usage records). A seeded workspace exists for `ivory-26/agent-bank` (recorded in `project/STATUS.md`, wave 7). Historical acceptance PRs #1 and #2 exist as evidence. There are no testimonials, customers, benchmarks, or published pricing claims; future work must not fabricate them.

## Product Principles

1. Truthful UI: never imply that an agent is running, a provider is healthy, a sandbox exists, or a task completed unless the server reports it.
2. Operational clarity: status, ownership, current stage, risk, and next action must be legible at a glance.
3. Trust is inspectable: approvals show exact scope and consequences, and audit history is durable.
4. Calm under failure: errors, denials, and degraded states are explicit and actionable.
5. Restraint: neutral dark surfaces dominate; brand color is concentrated on action and focus.

## Accessibility & Inclusion

WCAG AA contrast for text and meaningful boundaries. Full keyboard operation for navigation, forms, dialogs, menus, tables, and workflow views. Visible focus ring. Status never conveyed by color alone. Reduced-motion support. Usable at 1280px desktop and when stacked on mobile.

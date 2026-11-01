# Image provenance

These images are shipping marketing assets. They are screenshots of the actual
Isolate UI rendered with **synthetic** data, not live tenant data.

| File | Source | Capture |
|---|---|---|
| `dashboard-overview.png` | Temporary `/dashboard-preview` route rendering the real Overview components (`PageHeader`, `MetricStrip`, `ActiveRunsSection`, `PendingApprovalsPreview`, `ActivityFeed`, `DeviceHealthSection`) inside the real `AppShell` | 1600×1200 CSS px at device scale 1, 2026-11-01 |
| `dashboard-active-runs.png` | Clip of the `Active runs` section from the same preview | 777×290 CSS px at device scale 2 (1554×580 px) |
| `dashboard-approvals.png` | Clip of the `Pending approvals` section from the same preview | 486×290 CSS px at device scale 2 (972×580 px) |

Synthetic identities and records: organization "Demo workspace" / repository
"ivory-26/agent-bank", task ids and run events. No real user, repository secret,
token, or provider credential appears in these images. The preview route is
removed after capture; the images are labeled "Illustrative product view. Data
is synthetic." on the landing page.

The dashboard shell in the screenshot reflects the product UI at capture time;
small styling refinements after capture do not change the represented features.

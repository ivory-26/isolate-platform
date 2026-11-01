# Image provenance

These images are shipping marketing assets. They are screenshots of the actual
Isolate UI rendered with **synthetic** data, not live tenant data.

| File | Source | Capture |
|---|---|---|
| `dashboard-overview.png` | Temporary `/dashboard-preview` route rendering the real Overview components (`PageHeader`, `MetricStrip`, `ActiveRunsSection`, `PendingApprovalsPreview`, `ActivityFeed`, `DeviceHealthSection`) inside the real `AppShell` | 1600×1200 CSS px at device scale 1.5 (2400×1800 px), 2026-11-01 |
| `dashboard-active-runs.png` | Clip of the `Active runs` section from the same preview | 773×265 CSS px at device scale 2 |
| `dashboard-approvals.png` | Clip of the `Pending approvals` section from the same preview | 499×265 CSS px at device scale 2 |

Synthetic identities and records: organization "Agent Bank", user "Maya Chen",
task ids and run events. No real user, repository secret, token, or provider
credential appears in these images. The preview route was removed after capture;
the images are labeled "Illustrative product view. Data is synthetic." on the
landing page.

The dashboard shell in the screenshot reflects the product UI at capture time;
small styling refinements after capture do not change the represented features.

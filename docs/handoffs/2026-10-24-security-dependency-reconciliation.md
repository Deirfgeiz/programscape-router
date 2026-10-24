# 2026-10-24 — Dependency security follow-up

Dave authorized completing Programscape's security reconciliation with two independent reviews and merging clean fixes after CI passes, without installing anything locally.

The existing dependency graph permits patched Body Parser 2.4.0 and Fast URI 3.1.9. Refresh their npm lock entries within their upstream ranges and pin the test framework to Vitest 4.1.12, including its matching mocker. No application code, provider behavior, key handling or package version changes. No package-root overrides are required, and none are used to claim protection for downstream consumers.

The affected ranges were checked against the public GitHub advisories GHSA-27r3-jxmh-p828, GHSA-wjr9-j795-jxcr, GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp, GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp on 2026-10-24. The lockfile was refreshed in metadata-only mode with lifecycle scripts disabled and no local packages installed. Existing CI must validate the frozen graph, tests, build and package-consumer smoke checks.

This updates the repository's reproducible dependency graph. It does not publish a new npm release, upgrade anyone's installed router, or attest to a founder's local environment. User keys and private local state remain untouched.

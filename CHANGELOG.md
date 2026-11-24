# Changelog

Notable changes to Radar, newest first. Source releases are tagged `vX.Y.Z`.

## 0.5.6 (2026-11-24)

### Fixed

- The **Sources** settings section uses stable source IDs as row keys, so custom labels can match without collisions. When a source is off, the section shows its default name instead of a label from the last board refresh.
- The **Sources** setup instructions match BB’s settings layout and no longer point to fields below the section.

This version matches the Shopify Marketplace Radar 0.5.6 release.

## 0.5.5 (2026-11-19)

### Added

- AI overrides carry an optional reasoning level. Radar passes it to the BB completion call, and to the fallback endpoint as `reasoning_effort`.

### Changed

- Radar builds on Plugin SDK 0.6.132 and needs BB 0.49 or newer. The source repository continues to use `tsc` for typechecking.
- Mention scans fetch the item body and its comment collections in parallel. Radar scans up to four items at a time and applies the results in the original order.
- Slack thread summaries refresh with the same bounded concurrency as lane refreshes. Slack calls keep their spacing, so the rate limit does not change.

### Fixed

- The Focus token input and the "Describe what to track" box no longer submit when Enter confirms an IME composition.
- Zod schemas no longer use the deprecated `.finite()` and `.passthrough()`.
- A React hook dependency list no longer includes an unused callback.

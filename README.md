# Thymer Self Destruct

Self Destruct is a Thymer app plugin that expires tagged lines and their subtrees. Version 0.1.0 is the engine-only release: it includes discovery, safety verdicts, dry-run/acting sweeps, defusing, logging, and forensic globals. It intentionally does not include the dashboard, caret-tagging actions, status item, or settings panel planned for GOAL-2.

## Tag grammar

Hashtag segment text includes the leading `#`. Tokens after `#sd` are slash-separated and order-independent.

| Tag | Behavior |
|---|---|
| `#sd` | Delete the line and its whole subtree after the default delay. |
| `#sd/7d`, `#sd/12h`, `#sd/2w`, `#sd/30m` | Use an explicit delay from the line creation timestamp. |
| `#sd/empty` | At expiry, delete only when every descendant is empty; otherwise remove all `#sd*` tags and keep the subtree. |
| `#sd/empty/3d` | Combine the empty-subtree condition with an explicit delay. Token order may be reversed. |
| `#sd/now` | Become eligible on the next sweep. |
| `#keep` | Veto deletion when present on the tagged line, an ancestor, or any descendant. |

Durations use `\d+(m|h|d|w)`. An unknown or malformed token makes that tag inert; it never falls back to the default timer. With multiple valid `#sd` tags on one line, `empty` is ORed and the latest deadline wins. Defusing removes every strict `#sd` hashtag while leaving all other content intact.

## Settings

GOAL-1 has no settings UI. Settings are stored per device/origin in the `self-destruct-settings-v1` localStorage key:

```json
{
  "defaultDelay": "3d",
  "lineWriteBudget": 100,
  "dryRun": true,
  "logEnabled": true,
  "contentLog": true,
  "logCollection": "1G8F9FFY4XFXKA2MBGE2FN39B3"
}
```

`dryRun` defaults to `true`. `defaultDelay` must pass the same duration grammar. `lineWriteBudget` is clamped to 1–300. The default log collection is Scratchpad. Settings are read on plugin load; reload after changing the localStorage value.

Two palette commands are registered:

- **Self Destruct: Sweep now** respects the saved `dryRun` setting.
- **Self Destruct: Dry-run sweep** always performs a zero-write preview.

The same operations are available as `window.__SD_SWEEP()` and `window.__SD_DRY()`.

## Safety model

- Search results are strictly re-filtered to hashtag segments matching `^#sd(/|$)`; fuzzy `#sdk` matches are ignored. A 4,000-result cap is surfaced in the sweep report.
- Templates, the Self-Destruct Log, and trashed records are exempt. Unknown age bases and creation timestamps more than one year in the future are never deleted.
- Lines with children are deleted bottom-up. Every destructive write re-reads the live record and re-runs tag, expiry, `#keep`, subtree-emptiness, and caret checks.
- The active caret subtree is skipped. A line seen in a `lineitem.undeleted` event is defused instead of re-deleted.
- The default line-write budget is 100 and admits subtrees whole. One oversized subtree may run only when it is the first action. A hard breaker stops at 300 write attempts or 10 consecutive delete failures.
- Sweeps wait for two seconds of editor quiet before discovery and between batches of ten. Native overlays hard-block the gate. Scheduled acting clients defer when the log shows another sweep within 15 minutes.
- Acting sweeps append explicit line items to `Self-Destruct Log`, retain 50 sweep blocks, and optionally capture at most 50 deleted lines of 120 characters each. Dry runs write nothing, including no log.

Forensics live at `window.__SD_STATS` (20-report ring plus totals) and `window.__SD_LAST_ERROR`. Sweep reports and verdicts use the frozen schema documented in `plugin.js` so the GOAL-2 dashboard can consume them without guessing.

## Tests

Run the dependency-free pure-core suite with:

```sh
node tests/run.js
```

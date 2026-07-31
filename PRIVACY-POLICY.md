# Privacy Policy for Corral

**Last updated:** 31 July 2026

## Summary

Corral does not collect, transmit, or share any of your data. Everything the extension
needs stays on your own device, inside Chrome's local storage. There is no server, no
account, and no analytics.

## What Corral accesses

To do its job, Corral reads the following from your browser:

- **Tab URLs.** Corral needs the domain of each tab in order to decide which group it
  belongs to. For example, a tab at `https://github.com/foo/bar` is identified as
  belonging to `github.com`.
- **Tab titles.** Shown in the stale-tab review list so you can recognise a tab.
- **Tab activity times.** Corral records when each tab was last active, so it can tell
  which tabs you have stopped using.

## What Corral stores, and where

Corral stores two things using Chrome's own extension storage API:

1. **Your settings** — whether grouping is enabled, how many tabs form a group, how many
   idle hours count as stale, and whether notifications are on.
2. **A local activity map** — for each open tab, its last-active timestamp, URL, and title,
   plus a record of which tab groups Corral created.

This data lives on your computer. Settings sync through your Chrome profile only if you
have Chrome Sync enabled, which is Google's feature and under your control. The activity
map never leaves your device at all.

When you close a tab, its record is deleted. When you uninstall Corral, all of its stored
data is removed by Chrome.

## What Corral does NOT do

- Does not send your URLs, titles, browsing history, or any other data to any server
- Does not use analytics, telemetry, crash reporting, or tracking of any kind
- Does not include third-party code, libraries, SDKs, or remote scripts
- Does not require an account or collect any personal information
- Does not sell or transfer data to third parties, because it does not collect any
- Does not use any AI or external API

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `tabs` | Read tab URLs to determine each tab's domain, and track when tabs were last used |
| `tabGroups` | Create and update Chrome tab groups |
| `storage` | Save settings and the local activity map on your device |
| `alarms` | Periodically check for stale tabs in the background |
| `notifications` | Show the optional notification when tabs have gone stale |

## Changes to this policy

If this policy changes, the updated version will be published at this same location with a
revised date above.

## Contact

Questions about this policy or the extension: please open an issue at
https://github.com/shaz2k/corral/issues

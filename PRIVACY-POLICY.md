# Privacy Policy for Corral

**Last updated:** 2 September 2026

## Summary

Corral has no server, no analytics, and nothing to sign up for. Everything it needs stays
on your own device inside Chrome's storage.

There is one exception, and it is entirely your choice: if you connect your GitHub account,
Corral talks directly to GitHub's public API to find out whether your pull requests are
still open, and to check whether anyone has asked you to review one. Those requests go from
your browser straight to `api.github.com`. They do not pass through any server of ours,
because there isn't one.

## What Corral accesses

To do its job, Corral reads the following from your browser:

- **Tab URLs.** Corral needs the domain of each tab in order to decide which group it
  belongs to. For example, a tab at `https://github.com/foo/bar` is identified as
  belonging to `github.com`.
- **Tab titles.** Shown in the stale-tab review list so you can recognise a tab.
- **Tab activity times.** Corral records when each tab was last active, so it can tell
  which tabs you have stopped using.

## What Corral stores, and where

Corral stores the following using Chrome's own extension storage API:

1. **Your settings** — whether grouping is enabled, how many tabs form a group, how many
   idle hours count as stale, and whether notifications are on.
2. **A local activity map** — for each open tab, its last-active timestamp, URL, and title,
   plus a record of which tab groups Corral created.
3. **If you connect GitHub:** your GitHub access token, your GitHub username, the last
   known status of the pull requests you have open in a tab (title, repository, number,
   author, whether you are a requested reviewer, and whether it is open, draft, merged, or
   closed), and a list of which review requests Corral has already shown you — so that a tab
   you closed is not opened again.

This data lives on your computer. Settings sync through your Chrome profile only if you
have Chrome Sync enabled, which is Google's feature and under your control. The activity
map, your GitHub token, and the pull request data are stored in local storage only —
deliberately never in synced storage — so the token stays on the one machine where you
authorised it and is not copied to your other devices.

When you close a tab, its record is deleted. When you uninstall Corral, all of its stored
data is removed by Chrome.

## The optional GitHub connection

This feature is off until you turn it on. Nothing below happens unless you connect an account.

- **Signing in.** Corral uses GitHub's OAuth **device flow**. You are shown a short code and
  you type it into `github.com/login/device` yourself. You never enter your GitHub password,
  or any other credential, into Corral.
- **Permission is requested late.** Access to `github.com` is an *optional* host permission.
  Chrome only asks for it at the moment you press Connect — not when you install Corral.
- **What Corral asks GitHub.** The status of pull requests you already have open in a tab,
  and a list of the pull requests you authored or have been asked to review. While connected
  it repeats the review-request query every few minutes so newly assigned reviews can be
  surfaced. Read-only.
- **Opening tabs.** By default, a new PR awaiting your review is opened in a background tab.
  This uses only the PR's public GitHub URL. You can turn tab-opening off and keep the
  notification, or stop the checking entirely, from the extension popup.
- **What Corral never does on GitHub.** It never posts, comments, approves, merges, closes,
  or changes anything. It only reads.
- **Where the token goes.** To `api.github.com`, as GitHub requires, and nowhere else. It is
  never transmitted to us or to any third party.
- **Disconnecting.** Pressing Disconnect deletes the token, your username, and all stored
  pull request data from your device immediately. You can also revoke Corral's access at any
  time from GitHub's own settings, under Authorised OAuth Apps.

## What Corral does NOT do

- Does not send your URLs, titles, browsing history, or any other data to any server of ours
- Does not contact any third party other than GitHub, and only when you have connected it
- Does not use analytics, telemetry, crash reporting, or tracking of any kind
- Does not include third-party code, libraries, SDKs, or remote scripts
- Does not require an account for the tab grouping and stale tab features
- Does not sell or transfer data to third parties
- Does not use any AI service
- Does not write to, or modify anything in, your GitHub account

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `tabs` | Read tab URLs to determine each tab's domain, and track when tabs were last used |
| `tabGroups` | Create and update Chrome tab groups |
| `storage` | Save settings and the local activity map on your device |
| `alarms` | Periodically check for stale tabs, and for pull request status and new review requests if GitHub is connected |
| `notifications` | Show the optional notifications for stale tabs, merged pull requests, and new review requests |
| `github.com`, `api.github.com` | Optional. Requested only when you connect GitHub, used to sign in, read pull request status, and check for new review requests. Removed when you disconnect. |

## Changes to this policy

If this policy changes, the updated version will be published at this same location with a
revised date above.

## Contact

Questions about this policy or the extension: [add your contact email or GitHub issues URL]

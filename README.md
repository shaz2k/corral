# Corral — Automatic Tab Groups

A lightweight Chrome extension that groups your tabs by site automatically, keeps your
GitHub pull requests together, and helps you review the ones you have stopped using.

Corral never closes a tab without asking first. Nothing closes automatically unless you
turn it on yourself.

## What it does

- **Automatic domain grouping.** Open a few tabs from the same site and Corral files them
  into a Chrome tab group, named and coloured by domain. Subdomains stay together —
  `github.com` and `gist.github.com` land in the same group.
- **Adopts your existing groups.** If you already have a "Github" group, new GitHub tabs
  join it rather than starting a duplicate. Groups you named yourself are never touched.
- **Stale tab review.** Tabs you have not used in a while are gathered in one list with how
  long they have been idle. Unload them to free memory, or close them — with undo.
- **Light and dark mode.**

## Pull request tracking (optional)

Connect a GitHub account and Corral keeps every pull request tab in its own "Pull requests"
group, separate from ordinary `github.com` tabs, and labels each one Open, Draft, Merged, or
Closed. Once a PR lands, its tab is flagged **safe to close** and pre-selected on the review
page, so clearing finished work is one click.

You can also see the PRs you authored or have been asked to review, and open any that do not
have a tab yet.

Sign-in uses GitHub's OAuth **device flow** — you type a short code into
`github.com/login/device`, so no password or token is ever entered into the extension.
Access is read-only; Corral never posts, comments, approves, or merges anything.

**Auto-close** is off by default. Turn it on and merged PR tabs close themselves, with a
seven-day undo. It never closes the tab you are looking at or a pinned tab, and only acts
when a PR *becomes* merged — so a tab you deliberately reopened stays open.

## Privacy

No analytics, no tracking, no backend of ours, and nothing to sign up for. Tab data stays in
Chrome's storage on your device.

If you connect GitHub, requests go directly from your browser to `api.github.com` and nowhere
else. Your access token is stored in local storage only — never synced to your other
machines — and disconnecting erases it along with all cached PR data.

See [PRIVACY-POLICY.md](PRIVACY-POLICY.md) for the full policy.

## Building it yourself

The pull request feature needs a GitHub OAuth App client ID. If you are running your own
build, register one at <https://github.com/settings/applications/new>, tick **Enable Device
Flow** on the app's settings page, and put the client ID in `CLIENT_ID` at the top of
`github.js`. Device flow uses no client secret.

To load it unpacked: open `chrome://extensions`, enable Developer mode, and choose **Load
unpacked** on this directory.

## Support

Found a bug or have a suggestion? [Open an issue](https://github.com/shaz2k/corral/issues).

# Corral — Automatic Tab Groups

A lightweight Chrome extension that groups your tabs by site automatically, sorts your
GitHub pull requests by whether they need your review, and helps you review the ones you
have stopped using.

Corral never closes a tab without asking first — nothing closes automatically unless you turn
it on yourself. It does *open* a tab on its own for each new PR awaiting your review, which
you can switch off.

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

Connect a GitHub account and Corral sorts your pull request tabs by what each one wants from
you, into three groups:

| Group | Colour | Holds |
|---|---|---|
| **Review** | orange | PRs waiting on your review |
| **My PRs** | blue | PRs you authored |
| **Pull requests** | purple | Everyone else's, that you happen to have open |

Each tab is labelled Open, Draft, Merged, or Closed. Once a PR lands, its tab is flagged
**safe to close** and pre-selected on the review page, so clearing finished work is one click.

**Review requests find you.** Corral checks every five minutes for PRs that have been
assigned to you, opens each new one in a background tab in the Review group, and tells you.
Turn off *Open review requests in a tab* to be notified without the tab, or turn off *Watch
for review requests* to stop checking entirely.

A PR stays in Review after you submit your review — GitHub drops you from the reviewer list
at that point, but the tab stays put rather than hopping groups mid-task, and is relabelled
*reviewed by you*. It leaves only when the PR merges or closes.

There are two ways to connect. Pasting a **personal access token** you create yourself is the
default, because organisations often block unapproved OAuth apps from private repos — use a
*classic* token with the `repo` scope, since fine-grained tokens cannot call GitHub's search API
and so cannot discover review requests. Alternatively, sign in with GitHub's OAuth **device
flow** by typing a short code into `github.com/login/device`. Either way no password is entered
into the extension, access is read-only, and Corral never posts, comments, approves, or merges.

If your organisation enforces SAML single sign-on, the token must be authorised for that org
from your GitHub token settings. Corral detects this and links straight to the authorisation
page rather than showing an empty list.

**Sync now** does both halves of the job: it refreshes the status of every PR tab you already
have, then opens a tab for any of your PRs — authored or awaiting your review — that doesn't
have one yet. Matching is on the pull request itself rather than the URL, so a tab already
sitting on the *Files changed* view is never duplicated.

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

Nothing extra is needed for the token path — it works in any build. Only "sign in with GitHub"
depends on an OAuth App: to use that, register one at
<https://github.com/settings/applications/new>, tick **Enable Device Flow** on the app's
settings page, and put its client ID in `CLIENT_ID` at the top of `github.js`. Device flow uses
no client secret, so that value is safe to commit.

To load it unpacked: open `chrome://extensions`, enable Developer mode, and choose **Load
unpacked** on this directory.

## Support

Found a bug or have a suggestion? [Open an issue](https://github.com/shaz2k/corral/issues).

# Security Policy

Media Catcher is a Firefox extension plus a Windows native helper. Because the
helper runs local tools and the extension has broad host access, security
reports are taken seriously and handled quickly.

## Supported versions

Media Catcher auto-updates: the extension updates itself through Firefox
(AMO-signed builds), and the native helper updates itself from GitHub Releases
— backed up, verified, and reverted on failure by the update guardian. Only the
**latest release** is supported; please update before reporting.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Older releases | ❌        |

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security problem.**

Use GitHub's private reporting: on this repository's **Security** tab, click
**Report a vulnerability** (Security Advisories). That opens a thread visible
only to the maintainers.

Helpful details to include:

- the affected component — extension, native helper, update guardian, or casting;
- versions — the extension version from `about:addons`, and the helper version
  shown in the extension's **Settings** diagnostics;
- steps to reproduce, and the impact you observed.

You'll get an acknowledgement, and we'll coordinate a fix and disclosure with
you. There is no bug-bounty program (this is a personal project), but reporters
are credited in the release notes unless you'd rather stay anonymous.

## Scope and security model

**In scope:** the code in this repository — the extension (`media-catcher/`),
the native messaging helper (`media-catcher-host/`), and the update guardian.

A few notes on how the pieces are trusted, so reports can be aimed well:

- **Permissions.** The extension requests broad host access (`<all_urls>`,
  `webRequest`, `downloads`, `nativeMessaging`) so it can detect and save media
  on any site. It does not send page contents or browsing activity anywhere.
- **The native helper** downloads its tools (ffmpeg, yt-dlp, deno) from their
  official release sources over HTTPS and runs them locally. For downloads it
  may read **your own Firefox cookies, on your own machine** (via yt-dlp's
  `--cookies-from-browser`) solely to fetch media you requested — cookies are
  never transmitted anywhere else.
- **Casting** starts a small media server bound to your LAN so a TV can fetch
  the file. It serves only the one file/stream you chose to cast, behind an
  unguessable per-cast token, for the duration of the session. DLNA itself is an
  unencrypted LAN protocol.
- **Auto-update** installs only signed (extension) or verified (helper) builds;
  the guardian backs up, verifies, and reverts on failure.

**Out of scope:** vulnerabilities in the third-party tools themselves (ffmpeg,
yt-dlp, deno, pyatv), in Firefox / addons.mozilla.org, or in GitHub — please
report those to their respective projects.

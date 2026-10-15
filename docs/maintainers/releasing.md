# Releasing Desktop HUD

For maintainers. Users want [Getting started](../getting-started.md).

## The build

Releases come from CI only (`.github/workflows/release.yml`). Never attach an
installer built on your own PC to a release.

1. Push to `master`. CI type-checks, runs the unit tests, and runs
   `npm run dist:public`. That builds without private add-ons, runs the smoke
   test and runs `release:check` strictly.
2. Tag a version: `git tag v0.9.0 && git push origin v0.9.0`. CI builds the
   tag and **drafts** a GitHub release with the installer, `latest.yml` and
   `SHA256SUMS.txt`.
3. Check the draft: download the installer, compare its hash with
   `SHA256SUMS.txt`, install it on a clean Windows account, and run through
   [Getting started](../getting-started.md). Then publish.

The repository secret `RELEASE_CHECK_PERSONAL` holds the maintainer's personal
strings (one per line) for `release:check`. It is never printed. Locally the
same list lives in the git-ignored `release-check.local.txt`.

Before a release, also run `npm run pack` and then `npm run matrix`. That
launches the built app in seven setups on throwaway profiles and checks each
for console errors and the right state.

## SmartScreen

The installer isn't code-signed yet, so Windows SmartScreen warns on first run
("Windows protected your PC" → **More info** → **Run anyway**). The warning
fades as a release builds download reputation. Signing (for example through the
SignPath Foundation's free programme for open-source projects) is planned
after v1.0.

## If antivirus flags the app

The likeliest target is `resources/app.asar.unpacked/electron/bin/smtc-reader.exe`.
It's a small unsigned helper (compiled from `native/smtc-reader.cs`) that reads
Windows' media controls for the Now playing bubble. Small unsigned programs that
watch other apps sometimes trip heuristics.

1. **Confirm it's ours.** Rebuild from the tagged source. The file should match
   the one in the release (same SHA-256), and CI's build log shows the hash in
   `SHA256SUMS.txt` for the installer.
2. **Check VirusTotal** with the file's hash (don't upload private builds).
   Note which engines flag it and their detection names.
3. **Report it as a false positive** to each vendor that flags it:
   - Microsoft Defender: <https://www.microsoft.com/wdsi/filesubmission>
     (choose "Software developer", "Incorrectly detected as malware").
   - Others link a false-positive form from their detection pages.

   Include the release URL, the source link for `native/smtc-reader.cs`, and
   what it does: it reads the title, artist, cover and progress from
   `GlobalSystemMediaTransportControlsSessionManager`. It writes nothing and
   makes no network connections.
4. **Tell users** in the release notes and the issue tracker while it's open.
   Now playing is the only feature that needs the helper. If the file is
   quarantined, everything else keeps working, and the bubble shows nothing.

## Security reports

See `SECURITY.md` (added with the public repository).

# Releasing Desktop HUD

For maintainers. Users want [Getting started](../getting-started.md).

## The build

Releases come from CI only (`.github/workflows/release.yml`). Never attach an
installer built on your own PC to a release.

1. Push to `master`. CI audits the full dependency tree, checks the tracked
   source and third-party notices in separate steps, type-checks, runs the unit
   tests, and runs `npm run dist:public`. That builds without private add-ons,
   runs the smoke test and runs `release:check` strictly. Contributor pull
   requests and ordinary branch builds may run the generic source check without
   the private personal list.
2. Tag a version: `git tag v0.9.0 && git push origin v0.9.0`. CI builds the
   tag, requires a non-empty `RELEASE_CHECK_PERSONAL` repository secret for the
   source scan, and **drafts** a GitHub release with the installer, `latest.yml`
   and `SHA256SUMS.txt`.
3. Check the draft: download the installer, compare its hash with
   `SHA256SUMS.txt`, install it on a clean Windows account, and run through
   [Getting started](../getting-started.md). Then publish.

The repository secret `RELEASE_CHECK_PERSONAL` holds the maintainer's personal
strings (one per line) for `release:check`. A version-tag build fails closed if
the secret is missing or blank. The script reports file and rule numbers, never
the matched text. Local runs can use the git-ignored `release-check.local.txt`.

CI audits development and production dependencies together. This covers tools
used to build the installer as well as packages shipped in it; a high-severity
issue in a build tool can block a release even when it is not present at
runtime. Review the advisory and dependency path before choosing a remediation.

Before a release, also run `npm run pack` and then `npm run matrix`. That
launches the packaged app in throwaway profiles and checks each for console
errors and the right state, including that a profile left mid-onboarding resumes
the wizard and a read-only notes folder refuses a write. To exercise current
public source through Electron without packaging, first run `npm run build`,
then `node scripts/matrix.mjs --source`. This source harness still runs the
public-source assertion; it does not replace the packaged-app check.

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

## Local candidate review

Before staging new files, run `node scripts/release-check.mjs --source --include-untracked`.
Tag builds additionally require the personal denylist secret. Keep that list out of source control.
The matrix's interrupted-onboarding case launches a fresh profile twice; it must remain
unfinished until the user finishes or skips setup. Read-only cases attempt a write and
compare the synthetic note's bytes afterwards.

Review the migration boundary when changing Notes settings: `vault.scopeVersion: 1`
marks Settings as authoritative for scan folders. Older profiles inherit their effective
skeleton scope once. An empty weekly-folder setting intentionally means the notes root.
Do not restore the old "config exists means onboarding is finished" heuristic.

A passing automated suite is not release approval. Record clean-machine install, upgrade,
uninstall with both data choices, reinstall, mixed-DPI hot-plug, keyboard-only setup,
lock/unlock and AC/battery observations. Re-measure idle memory and CPU after settling.
Keep performance exceptions explicit, and complete the planned daily-driver trial before tagging.

The dependency audit includes build tools. The current compatible update uses Vite 6.4.4;
eight moderate findings remain in the electron-builder / @electron/get / global-agent /
roarr / sprintf-js chain. No high or critical findings remained at the candidate check.
Re-audit before release; do not force a packaging-tool downgrade solely to suppress the report.

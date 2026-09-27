# Releasing Considered

GoReleaser OSS builds `considered` and `considered-scc` together for macOS, Linux,
and Windows, on amd64 and arm64. Archives retain the existing
`considered_vVERSION_OS_ARCH` filenames and enclosing directory. Each archive
contains both binaries, the README, and both project and scc licenses.

## One-time publishing credentials

Configure these Actions secrets on `quitepicky/considered`:

- `HOMEBREW_TAP_TOKEN`: a fine-grained GitHub token with Quite Picky as resource
  owner, only `homebrew-tap` selected, and Contents read/write. It publishes the
  generated cask to the tap. The workflow's `GITHUB_TOKEN` cannot write to a
  different repository.
- `WINGET_TOKEN`: a GitHub credential that can write branches in
  `quitepicky/winget-pkgs` and open pull requests against `microsoft/winget-pkgs`.
  GoReleaser's documented cross-repository route uses a classic PAT with
  `public_repo`. Fine-grained tokens scoped only to Quite Picky cannot authorize
  the Microsoft-owned repository. Choose an expiration and store it only in
  Actions secrets; do not commit it.

The release workflow checks both credentials before uploading a release. It uses
the built-in, repository-scoped `GITHUB_TOKEN` for the actual GitHub Release.
No GoReleaser Pro license is needed.

## Validate without publishing

Use GoReleaser OSS v2.18.0 and initialize submodules first:

```sh
git submodule update --init --recursive
go test ./...
goreleaser check
HOMEBREW_TAP_TOKEN='' WINGET_TOKEN='' goreleaser release --snapshot --clean
```

Inspect the generated cask and WinGet manifests in `dist/`. In particular, both
Windows executables must appear under `NestedInstallerFiles`, and both binaries
must be installed by the Homebrew cask.

## Publish

### Required Windows package gate

For our WinGet checklist, "local" means a local manifest tested on a GitHub-hosted
Windows runner controlled by this repository. Both ordinary CI and every Release
invocation call `windows-package.yml`. It builds a non-published GoReleaser
candidate, then requires native x64 and ARM64 jobs to validate the original
three-file schema-1.12 manifest set, run `winget install --manifest`, verify both
portable aliases and the installed version, exercise the bundled provider,
check `winget list`, and uninstall. Command failures fail the job; WinGet's
explicit success-with-warning validation status is retained as a warning.

The install test changes only the URLs in a manifest copy to a loopback-only
server serving the candidate ZIPs. Original SHA256 values and nested paths stay
unchanged and enforced. This allows testing before public download URLs exist;
it does not claim those URLs are live or replace Microsoft's upstream scans.
No Defender exclusions or scan bypasses are added. The runner's inherited
Defender settings are not evidence of a comprehensive malware assessment.

The publishing job depends on the entire gate succeeding and rejects tag changes
after validation. Archive timestamps are pinned to the source commit so the
publishing rebuild is reproducible. Before exposing the draft, the workflow
compares both Windows ZIPs and generated manifests against the tested candidate,
and checks GitHub's uploaded asset digests. Only the manifest's build-date field
may differ. A mismatch leaves the release in draft and fails the workflow.
This gate applies to stable releases, prereleases, tag pushes, and manual release
dispatches. It is a workflow dependency, not merely an optional PR status check.
Old tags without reproducible archive settings may fail the equality check;
do not bypass it or retag a release to hide the failure.

Each run retains `windows-candidate-*` and per-architecture `windows-evidence-*`
artifacts for 14 days, including original/local manifests, transcript, WinGet logs,
and a success record written only after all tests pass. Link that run when
checking the WinGet validation/install checkboxes. CLA and duplicate-PR/issue
checks remain submission-specific and are not inferred from a Windows CI pass.

### Release procedure

After CI and review pass, choose the next unused version. Garden calls the
existing `Prepare Release` workflow with `version=vMAJOR.MINOR.PATCH`; this tags
the selected branch and dispatches `Release` with that tag. Manual tag pushes
also trigger `Release`. Manual dispatch accepts an existing version tag only.

Stable releases update `quitepicky/homebrew-tap` and open a version-specific PR
from `quitepicky/winget-pkgs` to Microsoft. GoReleaser leaves the GitHub release
in draft until `scripts/verify-publication.mjs` verifies all seven assets, the
matching Homebrew cask, and the upstream WinGet PR and installer manifest. A
missing or rejected submission fails the workflow instead of relying on
GoReleaser's warning behavior. Only then does the workflow publish the release,
allowing Garden to mark its GitHub-release delivery complete. Prereleases verify
GitHub assets but skip the package registries. WinGet is reported as submitted,
not installable, until Microsoft accepts it.

To check downstream acceptance and detect submissions stalled for over seven
days, run `node scripts/verify-publication.mjs --monitor` with the same three
tokens. It defaults to the latest GitHub release, or accepts `RELEASE_TAG`.
The daily/manual `Publication health` workflow runs this check automatically,
opens a deduplicated Garden attention item and Better Stack escalation on a new
failure, and resolves the item after recovery. `GARDEN_PUBLICATION_KEY` is a
dedicated Bitting-issued key with `garden:read`, `garden:run`, and `garden:elevate`
permissions, not `garden:admin`; it cannot change Garden's maintenance policies.
The release workflow also reports failures immediately. Renew publishing tokens
before their expiry (currently December 4, 2026); monitor failures also detect
expired credentials even when no new release is attempted.
Keep failed releases in draft while repairing publication, then rerun the
existing tag's Release workflow; do not create a new version to hide a failure.

The monitor also reports failed upstream WinGet checks, without waiting for the
seven-day acceptance deadline. Its protected main-only job needs GitHub Contents
write permission to see drafts: GitHub hides draft releases from read-only
tokens. Release recovery uses reviewed publication scripts from the workflow
commit, but always builds binaries from the original release tag; do not retag
an interrupted release just to fix its publication tooling.

## Install

```sh
brew install --cask quitepicky/tap/considered
```

After the first WinGet submission is accepted:

```powershell
winget install --exact --id QuitePicky.Considered
```

Both installers include `considered-scc` alongside `considered`. The CLI needs
both executables on `PATH`. Existing release assets continue to work through
GitHub's redirect from the old `agorischek/considered` repository URL.

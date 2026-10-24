<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-light.svg">
  <img src="assets/wordmark.svg" alt="Considered" width="320">
</picture>

# Considered

Considered is a CLI that lets you set codebase standards (e.g. file line counts) 
and explicitly document exceptions.

It collects metrics from one or more providers, evaluates them against declared
standards, and reports violations. Intentional departures are documented as
**variances**: reviewed, visible exceptions with a reason.

The goal is not merely to enforce limits. It is to make architectural decisions
explicit and preserve the rationale behind unusual structures.

## Quick Start

Install on macOS with Homebrew:

```sh
brew install --cask quitepicky/tap/considered
```

Or install on Windows x64 or ARM64 with WinGet:

```powershell
winget install --id QuitePicky.Considered --exact --source winget
```

Both packages install `considered` and `considered-scc`. On Windows, open a new
terminal if needed, then run `considered --version` to verify installation.
See the [Windows installation guide](https://considered.quitepicky.dev/quick-start/#windows)
for upgrade, uninstall, and troubleshooting instructions. Release archives are
also available from [GitHub Releases](https://github.com/quitepicky/considered/releases).

### Build from source

Requires Go 1.26+. This repository vendors [`scc`](https://github.com/boyter/scc)
as a git submodule, so clone with submodules:

```sh
git clone --recurse-submodules https://github.com/quitepicky/considered.git
cd considered
go build -o bin/considered ./cmd/considered
go build -o bin/considered-scc ./cmd/considered-scc
```

Put both binaries on your `PATH`, then initialize and check a repository:

```sh
considered init
considered check
```

## Documentation

The full guide is at [considered.quitepicky.dev](https://considered.quitepicky.dev).
The Astro documentation source lives under [`docs/`](docs/):

```sh
cd docs
npm install
npm run dev
```

The docs cover configuration, variances, exclusions, providers, CI output, and
the CLI reference.

## Releases

GitHub Releases are published from version tags:

```sh
git tag v0.1.1
git push origin v0.1.1
```

GoReleaser builds `considered` and `considered-scc` together for
Linux, macOS, and Windows on amd64 and arm64. Each release includes platform
archives plus `checksums.txt`. Stable releases update the Quite Picky Homebrew
tap and submit WinGet manifests. See [RELEASING.md](RELEASING.md) for credentials,
validation, and the Garden release workflow.

## Design Principles

1. Standards should be easy to declare.
2. Violations should remain visible.
3. Variances require rationale and classification.
4. Variances remain visible.
5. Metrics are provider-agnostic.
6. Configuration should be human-readable and double as architectural documentation.
7. Exact subject matching is preferred over complex selector systems.
8. Repository knowledge should be preserved alongside policy.

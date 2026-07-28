# GitHub Actions runner design for current cross-platform CI

Research date: 2026-07-27

## Conclusion

The smallest current matrix for this repository is:

```yaml
matrix:
  os: [macos-15, ubuntu-latest, windows-latest]
```

This keeps the existing three-platform coverage while replacing the deprecated
`macos-14` leg with stable macOS 15. The important label semantics are:

- `macos-15` is the standard ARM64/M1 macOS 15 runner.
- `macos-15-intel` is the standard x64/Intel macOS 15 runner.
- `macos-latest` now targets macOS 26 ARM64, so it is not an alias for macOS 15.
- `windows-latest` currently targets x64 Windows Server 2025 with Visual Studio
  2026.

For this repository, `macos-15` is the better default than
`macos-15-intel`: the current `macos-14` leg is already ARM64, the repository's
macOS checks are not documented as Intel-specific, and GitHub has announced that
macOS 15 Intel is its last x86_64 image and is available only through August
2027. Keep `windows-latest` when the intent is to continuously test GitHub's
current stable Windows image. Use `windows-2025` instead only if freezing the
Windows OS generation is a deliberate stability requirement.

Sources:

- [GitHub Docs: standard hosted-runner labels and hardware](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job#choosing-github-hosted-runners)
- [actions/runner-images: current available images and label mappings](https://github.com/actions/runner-images#available-images)
- [GitHub's macOS 15 Intel support announcement](https://github.com/actions/runner-images/issues/13045)
- [GitHub's macOS 14 deprecation announcement](https://github.com/actions/runner-images/issues/13518)

## macOS 15 labels and architectures

GitHub's current standard-runner table assigns:

| Workflow label | OS | Architecture | Standard hardware |
| --- | --- | --- | --- |
| `macos-15` | macOS 15 | ARM64, Apple M1 | 3 CPUs, 7 GB RAM |
| `macos-15-intel` | macOS 15 | x64, Intel | 4 CPUs, 14 GB RAM |

`macos-15-arm64` is the runner-image/release name, not the standard workflow
label. The workflow label is `macos-15`. The current ARM64 image includes Node
22, although `actions/setup-node` should remain the source of truth for this
repository's requested Node 22 toolchain.

GitHub began moving `macos-latest` from macOS 15 to macOS 26 on June 15, 2026
and the live runner table now maps it to macOS 26 ARM64. Pinning `macos-15` is
therefore required when the acceptance criterion is specifically macOS 15.

Sources:

- [GitHub Docs: public and private standard runner specifications](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job#choosing-github-hosted-runners)
- [Current macOS 15 ARM64 image contents](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)
- [GitHub Actions image migration notice](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations/)

## Windows labels and the x64 helper

The live runner-image table maps all three of these labels to the same x64
Windows Server 2025 image with Visual Studio 2026:

- `windows-latest`
- `windows-2025`
- `windows-2025-vs2026`

The migration completed in June 2026. GitHub documents the current image as
including Visual Studio Enterprise 2026, the native desktop workload, and
`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`. That is the correct hosted
environment for the workflow's `cl` build of
`native/bin/win32-job-kill-x64.exe`. Node 22 is also present, but the explicit
`actions/setup-node` step remains appropriate and consistent across all matrix
legs.

The label choice is a maintenance policy:

- `windows-latest` follows GitHub's newest stable Windows image. GitHub warns
  that a `-latest` migration is gradual and may change the OS during a one-to-two
  month rollout. This is appropriate when CI is intended to continuously test
  the current GitHub-hosted Windows platform.
- `windows-2025` freezes the OS generation, avoiding a future move to the next
  Windows Server release. It does not freeze the entire toolchain: GitHub moved
  both `windows-latest` and `windows-2025` from Visual Studio 2022 to Visual
  Studio 2026 in June 2026, and hosted images continue to receive weekly
  software updates.
- `windows-2022` is the deliberate compatibility lane for consumers that still
  require Visual Studio 2022. This repository has no such stated contract.

Sources:

- [actions/runner-images: label scheme and migration behavior](https://github.com/actions/runner-images#label-scheme)
- [Windows Server 2025 and Visual Studio 2026 migration announcement](https://github.com/actions/runner-images/issues/14017)
- [Current Windows Server 2025 image contents](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-VS2026-Readme.md)

## First-party action versions

The workflow's existing first-party majors are already current and appropriate
for GitHub-hosted runners:

```yaml
- uses: actions/checkout@v7
- uses: actions/setup-node@v7
  with: { node-version: 22 }
- uses: actions/upload-artifact@v7
```

As of the research date:

| Action | Latest release | Published |
| --- | --- | --- |
| `actions/checkout` | `v7.0.1` | 2026-07-20 |
| `actions/setup-node` | `v7.0.0` | 2026-07-14 |
| `actions/upload-artifact` | `v7.0.1` | 2026-04-10 |

All three v7 actions run their own action implementation on Node 24. That is
independent of `setup-node` installing Node 22 for this repository's commands.
The Node 24 action runtime requires Actions Runner 2.327.1 or newer; this matters
for self-hosted runners, not the GitHub-hosted matrix used here.

The existing uses are compatible with their v7 behavior:

- `checkout@v7` requires no input change for ordinary `push` and
  `pull_request` checkout.
- `setup-node@v7` supports `node-version: 22`; its v7 breaking change is the
  migration to ESM.
- `upload-artifact@v7` supports the current single x64 executable upload,
  artifact name, and `if-no-files-found: error`.

Sources:

- [`actions/checkout` v7.0.1 release](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [`actions/checkout` v7 README](https://github.com/actions/checkout/blob/v7/README.md)
- [`actions/setup-node` v7.0.0 release](https://github.com/actions/setup-node/releases/tag/v7.0.0)
- [`actions/setup-node` v7 README](https://github.com/actions/setup-node/blob/v7/README.md)
- [`actions/upload-artifact` v7.0.1 release](https://github.com/actions/upload-artifact/releases/tag/v7.0.1)
- [`actions/upload-artifact` v7 README](https://github.com/actions/upload-artifact/blob/v7/README.md)

## Recommended workflow scope

Only the matrix label needs to change for the requested refresh:

```diff
-        os: [macos-14, ubuntu-latest, windows-latest]
+        os: [macos-15, ubuntu-latest, windows-latest]
```

No additional macOS Intel leg is justified by the repository's current
contracts, and no Windows label change is required to exercise Windows Server
2025, Visual Studio 2026, the x64 MSVC compiler, and Node 22.

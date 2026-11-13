# Releasing Kenlith

This page describes how a Kenlith release is produced and published to this
repository.

## How the repositories relate

- **Development and release gates** take place in the maintainer's private
  engineering repository. That is where release candidates are built, tested
  and accepted. It also holds the historical packages that the
  downgrade-compatibility tests use.
- **This repository (`MWForgeEG/Kenlith`)** is the public source and
  distribution mirror. It holds the source of every published release and
  the public documentation. It keeps its own linear history, which begins
  with Kenlith 0.8.0. It is never created by copying the private history.
- **GitHub Releases** in this repository carry the accepted stable `.vsix`
  and its SHA-256 checksum. Kenlith is not published to any extension
  marketplace.

## Release steps

### In the private engineering repository

1. Develop on a version branch.
2. Run the established local gates: `npm test`, the editor integration suites
   on VS Code and Antigravity IDE, and the release's own checks.
3. Build a release candidate with a fixed `SOURCE_DATE_EPOCH`.
4. Complete the required live checks.
5. The maintainer accepts the final release candidate.
6. Merge to the private `main`.
7. Promote the accepted candidate to stable as a byte-identical copy. Record
   its SHA-256.
8. Install it locally and verify it.

### Public export

9. Write an explicit export plan: the source, test and documentation changes
   since the last public release that are approved for publication.
10. Copy only those files into the public working copy. Never add the private
    repository as a remote, fetch its refs, or push its history.
11. Keep the public-only adaptations described below.
12. Review the public diff (`git diff --stat`, then the full diff).
13. Run the public secret and privacy audit on the working tree and on the
    new commits. Check for credentials, credential-shaped literals, personal
    or account data, machine paths, and internal evidence. If anything is
    found, stop.
14. Run `npm test` in the public working copy. Expect pass, with only the
    documented historical-package tests skipped.
15. Update `CHANGELOG.md`, and the README or user guide where users see a
    change.
16. Commit to the public `main` with a clear message, for example
    `Kenlith 0.9.0`.
17. Push `main` to `origin` (`MWForgeEG/Kenlith`).
18. Tag the release commit `vX.Y.Z` and push the tag.
19. Create the GitHub Release `Kenlith X.Y.Z` from the tag. Attach the
    **accepted stable `.vsix`** and a `SHA256SUMS.txt`. Do not attach a file
    rebuilt for publication. Publish the SHA-256 in the release notes.
20. Download the published asset and confirm that its SHA-256 matches the
    accepted stable package.

Never attach release candidates, backups, or internal evidence to a public
release.

## Public-only adaptations to keep

The public copy differs from the private source in a few test files only:

- **Historical packages.** Tests that load earlier release packages call
  `test/helpers/historical.js` and are skipped when those packages are absent.
  `test/m1-0.test.js` holds the recorded `src/auth.js` baseline hash inline.
  The tab-icon test in `test/kenlith-041.test.js` pins the SHA-256 of
  `media/chat-tab.svg` instead of reading the design source.
- **Credential-shaped test values.** Synthetic tokens, keys and passwords in
  tests are written as fragments joined at runtime, for example
  `'gh' + 'p_…'`. The value the test checks is unchanged, but no
  credential-shaped literal is stored. Keep this pattern when you sync test
  changes, and use it for new tests.

When a private test file changes, re-apply these adaptations to the public
copy instead of overwriting it.

## Contributions from this repository

Pull requests are reviewed and merged here. A merged change becomes part of a
stable release only after it has been deliberately brought into the private
engineering source and has passed the release gates there. That step is done
by hand and reviewed. It is not automated.

## No CI publishing

This repository has no GitHub Actions workflows, and releases are published
manually. Adding CI is a separate decision.

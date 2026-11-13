# Contributing to Kenlith

Thank you for helping. Bug reports, ideas, documentation fixes and code changes
are all welcome.

## Before you start

- For anything larger than a small fix, please
  [open an issue](https://github.com/MWForgeEG/Kenlith/issues) first so we
  can agree on the approach.
- Security vulnerabilities must not go in public issues or pull requests. See
  [SECURITY.md](SECURITY.md).
- Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- [Node.js](https://nodejs.org/) (development is verified with Node.js 24) and
  Git.
- VS Code 1.107 or later, or Antigravity IDE, to try the extension and to run
  the editor integration suites.

Kenlith has no npm dependencies, so there is nothing to `npm install`.

## Local setup

```shell
git clone https://github.com/MWForgeEG/Kenlith.git
cd Kenlith
npm test
```

To build a package you can install from VSIX:

```shell
npm run package     # writes dist/plan-chat-antigravity-<version>.vsix
```

The build never overwrites an existing file in `dist/`. Delete the old file
before rebuilding. Install development builds in an editor or profile you use
for testing, not in your everyday setup.

## Build and test commands

| Command | What it does |
| --- | --- |
| `npm test` | All unit and cross-process tests (`node --test test/*.test.js`) |
| `npm run package` | Builds a `.vsix` into `dist/` |
| `node test/integration/run.js "<path to Code.exe or Antigravity IDE.exe>"` | Editor integration suites in a throwaway profile |

A few downgrade-compatibility tests need historical release packages that are
not part of this repository. They are reported as skipped, which is expected.

## Branch workflow

1. Fork the repository and create a branch from `main`, for example
   `fix/review-card-focus` or `feat/task-labels`.
2. Keep each pull request focused on one change.
3. Rebase on `main` if it has moved on.

## Proposing a change

- Explain **what** changes for the user and **why**.
- Add or update tests in `test/` for the behaviour you change. Most
  behaviour can be tested with the fake editor in `test/helpers/`.
- Update the [user guide](docs/USER-GUIDE.md) or the README when what users
  see changes, and add a line under an "Unreleased" heading in
  [CHANGELOG.md](CHANGELOG.md).
- Keep the runtime dependency-free: Node.js built-ins and the VS Code API only.

## Test evidence

In your pull request, include:

- the `npm test` summary (tests, pass, fail, skipped);
- for user-interface changes, a screenshot taken with a **synthetic demo
  project** and a **test account or no account**;
- the integration suite you ran, if any, and on which editor and OS.

**Never include real credentials, tokens, account email addresses, private
project content, or screenshots of a signed-in account.** Use made-up values
such as `synthetic.user@example.test` and obviously fake keys. If a test needs
a credential-shaped string, build it at runtime from fragments (for example
`'gh' + 'p_…'`) rather than storing a realistic literal.

## Security-sensitive changes

Some changes get extra review. These include changes to project-boundary
checks, sharing and consent, secret detection and output filtering, command
classification and approval, Review Before Apply, sign-in and token storage,
and the requests sent to OpenAI.

For these:

- explain the threat you considered and why the change keeps the boundary;
- add tests that try to cross the boundary, not only tests that show the
  feature working;
- expect questions and possibly a request to split the change.

The maintainer also runs the release gates on the change before it ships (see [docs/RELEASING.md](docs/RELEASING.md)).

## Submitting a pull request

1. Push your branch to your fork and open a pull request against `main`.
2. Fill in the pull request template.
3. A maintainer reviews the change in this repository.

Merged changes ship in the next stable release, after the release gates have
passed. A merged pull request is not a release.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).

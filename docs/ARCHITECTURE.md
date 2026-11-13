# Kenlith architecture

A map of the source for contributors. Kenlith is a VS Code extension written
in plain JavaScript. It uses only Node.js built-ins and the VS Code extension
API, and it has no npm dependencies.

Some source and test comments cite internal design records, for example a
decision ID such as `DEC-PLANCHAT-030` or a `docs/release-evidence/…` path.
Those records are not part of this repository. This page and the
[security model](SECURITY-MODEL.md) are the public references.

## Overview

```text
 editor tab (webview: src/view.js)          side bar (native trees: src/sidebar.js)
            │  messages                               │
            ▼                                         ▼
     src/panels.js ──────────► src/engine.js ◄────────┘
                                   │  one engine per window: send, stream, cards
         ┌─────────────────────────┼──────────────────────────────┐
         ▼                         ▼                              ▼
  project context            request building                 storage
  project-context.js         request-builder.js               store.js (chats)
  retrieval.js               provenance.js, budget.js         drafts.js, consent.js
  project-tools.js           reasoning.js (Thinking)          proposal-store.js
  workspace-safety.js        context-gate.js                  exec-store.js
         │                         │                          lock.js, lease.js
         ▼                         ▼
  proposals                  src/openai.js ──► OpenAI Responses API
  proposal.js                (tool loop, SSE: sse.js,
  proposal-review.js          last outbound check)
  proposal-apply.js               ▲
                                  │
  commands                        │
  exec-request.js → exec-policy.js → exec-service.js → exec-runner.js
                                     exec-output.js, exec-boundary.js, sensitive-text.js

  sign-in: auth.js, siwc.js          settings: settings.js          entry: extension.js
```

## Modules

| Area | Files | Responsibility |
| --- | --- | --- |
| Entry | `extension.js` | Activation, commands, wiring |
| Sign-in | `auth.js`, `siwc.js` | Sign in with ChatGPT (loopback OAuth), tokens in `SecretStorage`, plan-usage rules |
| UI | `view.js`, `panels.js`, `sidebar.js`, `markdown.js` | Chat webview, editor tabs, side bar trees, safe Markdown rendering |
| Conversation | `engine.js` | The one place in a window that sends messages, streams replies and holds pending cards |
| Requests | `request-builder.js`, `budget.js`, `provenance.js`, `reasoning.js`, `openai.js`, `sse.js` | The only producer of a model request. Applies the size bound and provenance filtering of earlier replies, sets the Thinking level, runs the tool loop, parses streaming |
| Project awareness | `project.js`, `project-context.js`, `retrieval.js`, `project-tools.js`, `glob.js` | Project identity, bounded listing and excerpt selection, the read-only tools, exclude-setting matching |
| Boundaries | `workspace-safety.js`, `context-gate.js`, `consent.js`, `attachments.js` | Contained reads and withheld files, the checks before and after retrieval, sharing permissions, attached selections |
| Review Before Apply | `proposal.js`, `proposal-review.js`, `proposal-store.js`, `proposal-apply.js` | Validating proposals, their review lifecycle and storage, and the only file writer |
| Commands | `exec-request.js`, `exec-policy.js`, `exec-service.js`, `exec-runner.js`, `exec-store.js`, `exec-output.js`, `exec-boundary.js`, `sensitive-text.js` | Resolving the exact run, A/B/C classification, approvals, process control, records, output cleaning and the outbound boundary |
| Storage | `store.js`, `drafts.js`, `lock.js`, `lease.js`, `fsutil.js` | Chat history shared safely by all windows of a profile (cross-process locks, atomic writes) |
| Settings | `settings.js` | Reads user-level settings only |

## Design rules

- **The host decides, the model asks.** Every read, send, write and run is
  decided in the extension host. Model output is data.
- **One producer per sensitive action.** Requests are produced only by
  `request-builder.js`, project files are written only by `proposal-apply.js`,
  and reads go through `workspace-safety.js`.
- **Fail closed.** If a check cannot be completed, nothing is sent, written or
  run.
- **Many windows, one profile.** Each editor window runs its own extension
  host process. Shared files are changed under cross-process locks, with
  atomic writes.
- **Additive storage.** New fields are optional, and older files are read
  without being rewritten.

## Tests

- `test/*.test.js`: unit and cross-process tests run with `node --test`,
  using a fake editor API (`test/helpers/fake-vscode.js`) and a fake OpenAI
  server (`test/helpers/fake-openai.js`).
- `test/integration/`: suites that launch a real VS Code or Antigravity IDE
  with a throwaway profile.

## Packaging

`scripts/package-vsix.js` builds the `.vsix` with Node.js built-ins only. It
is reproducible with `SOURCE_DATE_EPOCH`, and it never overwrites an existing
file. The package holds only runtime files: `package.json`, `src/`, `media/`,
`README.md`, `CHANGELOG.md`, `SECURITY.md` and `LICENSE`.

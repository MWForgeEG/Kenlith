# Kenlith security model

This page explains what Kenlith protects, where its trust boundaries are, and
which risks remain. It describes Kenlith 0.8.0. For how to report a
vulnerability, see [SECURITY.md](../SECURITY.md).

## What Kenlith protects

| Asset | What must hold |
| --- | --- |
| Your project files | Read only inside the open project folder. Kenlith itself changes them only through Review Before Apply, or by a command run you approved with that effect shown. A safe check runs your project's own test or build code (see residual risks). |
| Your secrets | Credential files are never read or sent. Known secret formats and the values of your secret files are removed from excerpts, tool results and command output; see residual risks for what detection cannot cover. |
| Data leaving your computer | Project data is sent only to OpenAI, and only under your sharing permission for that project and ChatGPT account. |
| Your machine and accounts | No elevation, no system changes, no access to credential stores, no remote control. |
| Your sign-in | Tokens stay in the editor's `SecretStorage` and are sent only to OpenAI's documented endpoints. |
| Your attention | Kenlith asks only when a run or a send crosses a boundary, instead of asking for everything. |

## Trust boundaries

Kenlith treats everything except your own decisions and its own code as
**untrusted data**:

- **The model.** It can call any tool with any arguments, and it can describe
  a dangerous command as "safe".
- **Project content.** This includes instructions hidden in files, a hostile
  `tasks.json` or `package.json`, and hostile file names.
- **Command output.** Output can contain prompt injection, control sequences
  or floods of text.
- **Other processes and windows.** They can race an approval against the
  start of a command.

The decisions are made in the extension host, in Kenlith's code. The model
never decides what is read, sent, written or run.

## Reading and sharing project files

- **Trusted, local project only.** Kenlith reads project files only in a
  trusted workspace, only for a chat of the project open in the window, and
  only when you send a message. It does not run in Restricted Mode.
- **Contained reads.** Every read goes through one boundary
  (`src/workspace-safety.js`). It resolves real paths, refuses anything
  outside the project root, and refuses links, junctions and files with a
  second name (hard links).
- **Withheld files.** Kenlith never reads or sends credential files and
  folders (`.env`, private keys, certificates, `.ssh`, `.aws`, `.npmrc`,
  `.git` internals and others), binary files, or any file whose content looks
  like a password or key. Your `files.exclude` and `search.exclude` settings
  add to this list. They cannot remove from it.
- **Bounds.** Listings, file sizes, excerpt counts, tool calls and characters
  sent per message all have fixed limits.
- **Sharing permission.** The first time a project chat wants to send project
  content, Kenlith shows exactly what it would send. The permission is per
  project, per ChatGPT account and per provider. It is stored locally,
  without your email address or account ID.
- **Last check before every request.** Just before each request leaves,
  Kenlith checks again: the permission, the account, Workspace Trust, and
  whether the files have changed. If any check fails, the request is not
  sent.
- **Stopping sharing** applies to every window of the editor profile within
  about 2 seconds, and stops a reply that is still streaming. It cannot recall
  what was already sent.

## Writing files (Review Before Apply)

- The model's only change tool **proposes** edits. It never writes.
- One module writes project files (`src/proposal-apply.js`). It writes only
  when you press **Apply**, and only the exact diff you reviewed. It writes
  one edit into the editor, without saving.
- At Apply, each file is checked against the version the proposal was made
  from: the bytes on disk, the file's identity and the editor text. A changed
  file makes the proposal out of date, and nothing is applied.
- New, deleted or renamed files, binary files, withheld files and files
  outside the project are never changed. Neither are files with unsaved
  edits.
- Allowing sharing never allows writing, and running a command never applies
  a proposal.

## Running commands

Kenlith resolves the **exact** execution before deciding anything: the
executable path, every argument, the real working folder, environment
changes and the time limit. It runs programs with `shell: false`. The model
cannot supply a shell string.

| Risk class | What happens | Examples |
| --- | --- | --- |
| **A: safe local check** | Runs without a prompt, only in known forms with allow-listed options. A test or build script runs only if its name and body pass Kenlith's screen | `npm test`, linters, type checks, `git status`, `git diff`, `node --version` |
| **B: has side effects** | One approval card shows exactly what would run, and one approval covers one run | installs, network use, file or Git changes, shells, project scripts, unknown programs |
| **C: refused** | Never runs | elevation, destructive or system commands, forced Git operations, credential access, paths outside the project, remote and cloud tools |

- **An approval is bound to the exact run.** Kenlith resolves the run again
  just before starting it. If anything changed, such as the program file,
  the settings or the open folder, the approval is void and nothing runs.
  There is no "always allow".
- **Git hardening.** Kenlith's Git runs override repository settings that
  would start programs during a read (`core.fsmonitor`, external diff and
  textconv, signing programs).
- **Stopping.** **Stop**, the time limit and closing the window end the
  process tree.

## Command output

Nothing a command prints reaches OpenAI before it passes Kenlith's outbound
boundary (`src/exec-boundary.js`). That boundary is applied again before
every request in a tool loop. It:

- removes terminal control codes;
- removes credential-like lines, whole private keys, and credentials inside
  addresses;
- removes the values of your secret and excluded files, also in base64, hex,
  URL or JSON form, or when partly printed;
- replaces long random-looking strings;
- removes paths outside the project;
- keeps Git content reads from reading secret or excluded files in any
  revision, and sends only the status for commands that name such files;
- **fails closed:** if Kenlith cannot check the project completely, no output
  is sent;
- sends output about your computer, or output that points mostly outside the
  project, only after you choose **Share** on its own card.

## Sign-in

- Kenlith uses OpenAI's Sign in with ChatGPT flow for open-source, locally
  hosted clients, with a loopback redirect.
- Tokens are stored in the editor's `SecretStorage`, never in files or
  settings.
- Kenlith never reads browser cookies or other apps' sign-in caches.

## Settings cannot be changed by a repository

Kenlith's settings are read from **user settings only**. A cloned repository
cannot change the instructions sent to the model, turn on project context, or
widen any boundary.

## Residual risks

Kenlith limits *which* commands run and *what* is sent. It is **not an
operating-system sandbox**. These risks remain:

- **Trusted project code.** In a workspace you trust, a test or build that
  Kenlith runs as a safe check runs with your permissions. It could open a
  network connection or write files that Kenlith cannot see. Kenlith screens
  validation scripts but cannot prove what they do. This is the same trust
  decision you make for VS Code tasks.
- **Detached processes.** A program that detaches itself from the run can
  outlive **Stop**.
- **Secret detection.** Kenlith removes known credential formats and the
  values of your secret files, including common encodings. It cannot detect
  every transformed, reworded or unknown secret.
- **Prompt injection.** Project text and command output can still mislead an
  answer. They cannot make Kenlith cross the boundaries above.
- **A compromised machine.** If a program on your `PATH` or another
  extension in the same editor is malicious, it is outside Kenlith's control.
- **Sent data.** Stopping sharing or signing out cannot recall data that was
  already sent to OpenAI.

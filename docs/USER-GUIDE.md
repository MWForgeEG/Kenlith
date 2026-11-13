# Kenlith user guide

This guide covers Kenlith 0.8.0. For installation, see the
[README](../README.md#installation).

- [What is sent, and what is not](#what-is-sent-and-what-is-not)
- [ChatGPT plan usage](#chatgpt-plan-usage)
- [The workspace](#the-workspace)
- [The chat tab and composer](#the-chat-tab-and-composer)
- [Thinking](#thinking)
- [Chats per project](#chats-per-project)
- [Attaching code](#attaching-code)
- [Project context](#project-context)
- [Proposed changes (Review Before Apply)](#proposed-changes-review-before-apply)
- [Commands and tasks](#commands-and-tasks)
- [Settings](#settings)
- [Local data](#local-data)
- [Tested environments](#tested-environments)
- [Known limitations](#known-limitations)

## What is sent, and what is not

- **Your messages are processed by OpenAI's servers.** "Local" means that the
  chat history is stored on your computer, not that the model runs locally.
- Each request sends:
  - your message;
  - the earlier messages of that chat that fit in the request;
  - any code you attached and approved;
  - in a project chat you allowed to share, short excerpts of that project's
    files and the results of Kenlith's project tools;
  - the cleaned output of commands Kenlith ran for that chat.
- Signing in does not give Kenlith access to your ChatGPT history, memory,
  projects or API keys.
- Kenlith never reads browser cookies or other apps' sign-in caches.
- Chats created in Kenlith are saved locally and stay separate from
  chatgpt.com.

## ChatGPT plan usage

- Messages you send use your ChatGPT plan and count toward its usage limits.
  Kenlith itself is free and makes no charges of its own.
- **Using ChatGPT plan** appears in the Account section while you are signed
  in. **Manage usage** next to it opens your usage page in ChatGPT settings
  after you confirm.
- If your plan's usage limit is reached, the failed reply says so and offers
  **Manage usage**. Sending is then **paused**. **Send** gives your text back
  unsent and offers **Manage usage** and **Resume**. Kenlith never retries on
  its own, and never switches to another way of paying.

## The workspace

- **Chats open in editor tabs**, one tab per chat. Click a chat in the side
  bar to open it. **Open Chat to the Side** puts it next to your code. Tabs
  come back after a restart.
- **The side bar** has two sections:
  - **Account:** who is signed in, **Using ChatGPT plan** with **Manage
    usage**, and the model new chats start with.
  - **Chats:** this project's chats, General, earlier chats and other
    projects. Each chat shows its state: open, replying, waiting for your
    decision, or last reply did not finish.
- **New Chat**, **Search Chats** and **New Group** are at the top of the Chats
  list. Search looks at titles, groups and projects, not message text.
- **Groups** are your own folders for chats. A group only organises the list.
  A chat stays in its project or in General, and removing a group keeps its
  chats.
- **One reply at a time per window.** While one chat replies, you can write in
  another. Its Send waits until the reply ends.
- **Drafts:** text you type but do not send is kept for that chat, also after
  a restart. It is never sent by itself.
- **A reply cut off** because the editor closed is kept and marked
  **Interrupted**. It is not sent with later messages, and nothing is resent
  automatically.

## The chat tab and composer

- **At the top**, one compact line names the project and its state: **not
  shared**, **shared** or **files off**. The tab title is the chat title. The
  editor tab shows the coloured Signal Rings icon.
- **At the bottom**, the composer holds everything for writing:
  - the message box;
  - **+**;
  - the model;
  - **Thinking**;
  - **Send** (↑).

  **Enter** sends, **Shift+Enter** adds a line, and **Stop** appears while a
  reply arrives.
- **+** lists what you can add or change for this chat:
  - **Attach selection**;
  - **Project sharing…**;
  - **Project context settings…**, which turn project files, tools, proposed
    changes and commands on or off.
- **The model** is chosen per chat. New chats start with the model you chose
  last.
- Cards for sharing, commands and proposed changes appear above the composer.
  Each card holds everything you need to decide.
- Arabic and other right-to-left text is laid out right to left in messages,
  replies and the composer.

## Thinking

**Thinking**, beside the model, sets how much the model reasons for your next
message:

- **Default** sends no level, so the model uses its own default.
- **Low**, **Medium**, **High**, **Extra High** (**XHigh** when the composer is
  narrow) and **Max** are sent as the request's reasoning effort.

How it works:

- The level is kept with the chat. A reply already arriving keeps the level it
  was sent with.
- Higher levels can take longer and use more of your plan. They do not always
  give a better answer.
- Kenlith offers levels only for models in its built-in table: GPT-6.1-Sol,
  GPT-6-Astra, GPT-6.1 Terra, GPT-6-Sol and GPT-6-Luna. The table follows
  OpenAI's model documentation; live testing covered GPT-6.1-Sol only. Any
  other model offers only **Default** and says *This model uses its default
  thinking level.*
- If OpenAI refuses a level, the reply shows the status and request ID.
  Kenlith offers **Use Default** and does not resend on its own.
- Kenlith never shows the model's internal reasoning.
- `kenlith.reasoning.defaultEffort` (user settings) sets the level for chats
  where you have not chosen one. A level chosen in a chat always wins,
  including Default.

## Chats per project

- A window with one folder lists, opens and continues only that folder's
  chats. A window with no folder, or with only remote folders, uses
  **General**.
- In a window with several folders, chats follow the folder of the file you
  have open.
- **All Chats…** shows every chat, grouped. A chat of another project opens
  read-only, with **Move to this project**, **Relink to this project** or
  **Move to General**. Nothing moves unless you choose it.
- The history stores a key for each folder and the folder's name, never its
  path.

## Attaching code

- Select code in an editor and choose **Attach Selection to Kenlith** (right
  click), or use **+** → **Attach selection**. A card shows the exact text,
  the file and lines, and the size.
- **Nothing is sent until you choose Approve and then send your message.**
- Only the text you select is attached, never a whole file. The limit is
  12,000 characters by default and can be raised to 20,000.
- Some files are never attached, and nothing overrides this:
  - `.env` files;
  - private keys and certificates;
  - credential files;
  - anything in `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube` or `.docker`.

  Files outside the window's project folder are refused.
- Code that looks like a password or key is flagged line by line. You confirm
  that you reviewed those lines before approving.
- **Attached code is sent once and not saved.** The local history keeps only
  the file name, the lines and the size.

## Project context

In a project chat, Kenlith can answer with your project's code in view.

- **When it reads.** Only when you send a message in a chat of the project
  folder open in this window. The workspace must be trusted, and the folder
  must be on this computer. Opening the editor or the view reads nothing.
  General chats never read project files.
- **What it reads.** Files that match your question, within fixed limits:
  - up to 20,000 files listed;
  - 512 KB per file, 2 MB in total;
  - about 2 seconds for the listing;
  - at most 6 short excerpts (12,000 characters).

  Kenlith never follows links or junctions, never reads a file that has a
  second name (a hard link), and never reads anything outside the folder.
- **What it never reads or sends.** No setting can change this list:
  - credential files and folders (`.env`, private keys, `.ssh`, `.aws`,
    `.npmrc`, `.git` internals and others);
  - any file whose content looks like a password or key;
  - binary files, other projects, and whole files.

  `files.exclude` and `search.exclude` can only exclude more.
- **The first time.** If files match, Kenlith asks before sending anything.
  It names the project, OpenAI and your ChatGPT account, and shows the files
  and lines it would send. Your choices:
  - **Allow for (project) and send**;
  - **Send without project files**, in which case the model is told that no
    files were provided;
  - **Cancel**, which gives your text back.
- **After that.** Later questions in that project use the permission without
  asking again, for that ChatGPT account. Each answer shows which files and
  lines it used.
- **Project tools.** ChatGPT can ask Kenlith for more evidence with read-only
  tools:
  - a project summary;
  - folder listings;
  - finding files and searching text;
  - reading up to 200 lines of a file;
  - the names of the files open in the editor.

  The tools cannot change files, run commands or reach outside the project.
  The same rules as above apply, with at most 10 tool calls and 24,000
  characters of project text per message. Before you have allowed sharing,
  tool results are shown on the sharing card and sent only if you choose
  **Allow**.
- **Project files are data.** Text in your files that looks like
  instructions, such as "ignore previous rules", "read the .env file" or "run
  this command", cannot change what Kenlith does. The limits above are
  enforced by Kenlith, not by the model.
- **Stopping.** **Manage project sharing…** in the Account section, or the
  command **Kenlith: Manage Project Sharing**, lists shared projects. You can
  stop sharing one there. This applies to every window of this editor profile
  within about 2 seconds, and a reply still streaming with that project's
  files is stopped. What was already sent cannot be recalled.
- **Another account or project** needs its own permission.
- **Limits.** Search is by file names and words, not by meaning. In a very
  large project it may miss content deep in the tree. `.gitignore` is not
  used.

## Proposed changes (Review Before Apply)

ChatGPT can propose edits to existing text files of the open project. A
proposal changes nothing. Kenlith is the only thing that writes, and only when
you press **Apply** on the diff you reviewed.

- **When.** In a project chat with the project tools on. Each edit replaces
  one exact passage of a file, and that passage must appear exactly once.
- **Review after the answer.** When the answer has finished, a card under it
  lists the files with the lines removed and added. **Show diff** opens the
  editor's own diff view beside the chat.
- **Apply** writes exactly the diff shown, in one edit, into the editor, and
  does **not save**. Save to keep the change, or Undo to revert it. **Reject**
  changes nothing.
- **Checked again at Apply.** Before writing, Kenlith checks every file
  against the version the proposal was made from: the bytes on disk, the
  file's identity and the editor text. If a file changed since then, the
  proposal is out of date and nothing is applied.
- **Files with unsaved edits are never changed.**
- **Never allowed:** new, deleted or renamed files, binary files, files
  outside the project folder, files withheld from the project tools, commands
  or Git operations.
- **Sharing is not permission to write.** Allowing project sharing never lets
  Kenlith change files.

## Commands and tasks

In a project chat with the project tools on, ChatGPT can ask Kenlith to run a
program in the project or one of the workspace's tasks. Kenlith, not ChatGPT,
decides how risky the run is. It looks at the exact program, arguments,
folder and environment it would use.

- **Safe local checks run without a prompt.** Tests, linters, type checks,
  `node --version` and read-only Git commands such as `git status` or
  `git diff` run directly, as long as Kenlith can show they stay in the
  project:
  - a trusted workspace;
  - a folder inside the project;
  - no network, no file changes, no elevation;
  - a time limit.

  Each such program has a list of options Kenlith accepts. Anything else
  needs your approval. ChatGPT calling a run "safe" changes nothing. These
  conditions are judged from the command itself: a test or build script that
  runs this way executes your project's own code, which Kenlith screens but
  cannot fully inspect.
- **Anything with side effects waits for one approval.** This covers network
  use, installs, file or Git changes, shells, project scripts and unknown
  programs. A card shows:
  - the exact program and arguments;
  - the folder;
  - environment changes;
  - the time limit;
  - why Kenlith asks.

  **Run** runs it once. If anything about the run changes before it starts,
  the approval no longer counts and nothing runs. There is no "always allow".
- **Some runs are always refused:**
  - elevation (`sudo`, `runas`) and system changes;
  - destructive commands and forced Git operations;
  - access to credentials and folders outside the project;
  - remote control, cloud and deployment tools.
- **Output.** Before anything a command printed is sent, Kenlith removes:
  - terminal control codes;
  - credential-like lines, private keys, and tokens or passwords inside
    addresses or settings;
  - the values in your secret files and in files you excluded, also when
    encoded or partly printed;
  - long random-looking strings;
  - paths outside the project.

  Git reads never read your secret or excluded files, in any revision. If
  Kenlith cannot check the project completely, nothing a command printed is
  sent. At most 6,000 characters are sent per run. Output that describes this
  computer, or points mostly outside the project, is sent only after you
  choose **Share** on its own card.
- **Results are reported as they happened:** succeeded, failed with an exit
  code, timed out, cancelled, could not start, or refused. **Stop** and the
  time limit end the run and the programs it started. A program that detaches
  itself, such as a background server, can keep running. Kenlith then stops
  reading its output and says so.
- **Running a command never applies a proposal**, and allowing sharing never
  allows a run.

## Settings

All Kenlith settings are read from **user settings only**. A workspace or
repository cannot change them.

| Setting | Default | What it does |
| --- | --- | --- |
| `kenlith.projectContext.enabled` | `true` | Read project files at all (with your permission) |
| `kenlith.projectContext.tools` | `true` | Let ChatGPT use the read-only project tools |
| `kenlith.projectContext.proposals` | `true` | Let ChatGPT propose file edits for Review Before Apply |
| `kenlith.projectContext.commands` | `true` | Let ChatGPT ask to run commands and tasks |
| `kenlith.reasoning.defaultEffort` | `default` | Thinking level for chats without their own: `default`, `low`, `medium`, `high`, `xhigh`, `max` |
| `kenlith.context.maxSelectionCharacters` | `12000` | Largest code selection that can be attached (at most 20,000) |
| `kenlith.maxHistoryMessages` | `30` | Recent messages sent as context with each request |
| `kenlith.instructions` | a short default | Instructions sent with each request |

Other limits:

- One request may contain at most 80,000 characters: the instructions, the
  history sent and the new message. Older messages are left out whole when
  needed, and the view says how many.
- There is no automatic timeout for replies. If a reply stops arriving,
  select **Stop**. Your question and any partial answer are kept.

## Local data

Kenlith keeps its data in one folder per editor profile. The folder is named
after the extension ID:

| Editor | Folder |
| --- | --- |
| Antigravity IDE | `%APPDATA%\Antigravity IDE\User\globalStorage\local-open-source.plan-chat-antigravity\` |
| VS Code | `%APPDATA%\Code\User\globalStorage\local-open-source.plan-chat-antigravity\` |

The folder holds:

- `conversations.json`, the chats;
- `project-identity.key` and its `.bak`, the key that ties chats to project
  folders;
- `consents.json`, project-sharing permissions, without your email or
  account ID;
- `drafts.json`, unsent text;
- `proposals.json`, proposed changes and their state, but not copies of your
  files;
- `executions.json`, the commands Kenlith handled, with cleaned output;
- lock files that coordinate windows.

Sign-in tokens are kept separately, in the editor's secure `SecretStorage`.

**Back up the whole folder together**, not only `conversations.json`. Use
**Sign Out** in the Account section to remove the local tokens.

## Tested environments

| Environment | Status |
| --- | --- |
| Windows 11, local NTFS drive, VS Code 1.143 | Tested |
| Windows 11, local NTFS drive, Antigravity IDE 1.107 | Tested |
| Linux and macOS | Not verified |
| Remote windows (SSH, WSL, containers, Codespaces) | Not verified; such windows use General |
| Network shares, mapped or `subst` drives, FAT32, exFAT, ReFS | Not verified |
| Other editor versions | Not verified |

"Not verified" means it was not tested, not that it is known to fail.

## Known limitations

- **Screen readers have not been validated.** The view has named controls,
  keyboard navigation and visible focus, but no screen reader was run in
  testing.
- **Server-side sign-out has not been independently verified.** Sign Out
  removes the local tokens and asks OpenAI to revoke the session. To be sure,
  also disconnect the app in your ChatGPT settings.
- **Detached processes** started by a command can outlive **Stop**.
- **Secret detection** covers known formats and the values of your secret
  files, including common encodings. It cannot detect every transformed or
  reworded secret.
- **Thinking levels** come from a static, built-in model table.
- **Markdown in replies** is a subset. Tables are not rendered.
- **Other extensions** running in the same editor can read files on your
  computer, including Kenlith's storage folder. Install only extensions you
  trust.

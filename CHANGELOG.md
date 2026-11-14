# Changelog

The public source history of Kenlith begins with 0.8.0. Earlier entries are
kept for reference; the release packages of versions before 0.8.0 are not
published in this repository. Entries before 0.4.1 use the earlier setting
names (`planChat.*`); the settings are now `kenlith.*`.

## 0.9.0 (2026-11-14)

**Summary.** Deep Research: ask a question, Kenlith has ChatGPT search the
public web and answers with cited sources. Also a refined editor tab icon.

- **Deep Research**, in the **+** menu. While it is on, a small **Deep
  Research** chip sits above the message box; select it (or the menu item
  again) to turn it off. It applies to the next message only.
- **Real web search.** The request uses OpenAI's hosted `web_search` tool
  with `tool_choice: "required"`, so a search always runs. It uses the model
  and Thinking level you chose. Deep Research is verified with **GPT-6-Astra**
  on the ChatGPT plan route; with another model Kenlith sends nothing and
  offers **Use GPT-6-Astra**.
- **Progress** from what actually happens: *Searching the web…*, *Reading
  sources…*, *Synthesizing…*, with the number of searches and pages read.
  No percentages, and none of the model's reasoning is shown.
- **Citations.** Each citation in the answer is a link with a number and the
  site's domain, taken from OpenAI's citation data, not from the answer's
  own text. Links open only after you confirm the full address, as before.
  **Sources** lists each cited page once, with title, domain and address.
  The answer and its citations are saved with the chat (a new, optional
  field) and come back after a restart.
- **Stop, interruptions and errors.** Stop ends the research request; the
  reply says it stopped and did not continue. If the editor closes during a
  run, the reply shows as interrupted: the research did not continue in the
  background. **Retry** puts the question back in the message box with Deep
  Research on; nothing is sent until you press Send. A run ends after 20
  minutes. Refusals, usage limits and network failures are shown as such;
  Kenlith never retries on its own and never substitutes an answer without
  the web.
- **Only public web research.** A Deep Research request carries your
  question and the chat's text. It never carries project files, attached
  code or earlier answers that used project files, offers no project tools,
  and never shows the sharing card. Web pages are treated as data.
- **Editor tab icon:** two Signal Mint rings with an open centre on the Deep
  Forest tile, with a green rim, drawn for 16 to 20 px. The Activity Bar icon
  is unchanged.
- Unchanged: ordinary messages (no web search unless you choose Deep
  Research), sign-in, project sharing, Review Before Apply, commands,
  Thinking, Workspace Trust.

**Known limitations.**

- **Deep Research is live-verified with GPT-6-Astra only.** With another
  model Kenlith sends nothing and offers GPT-6-Astra.
- **Deep Research runs in the foreground.** Closing the editor ends a run;
  the reply is kept as interrupted and offers **Retry**. There is no
  background research.
- **Markdown tables are shown as raw Markdown**, in research answers as in
  other replies.
- **Arabic paragraphs that begin with a Latin word** (for example a product
  name) may be laid out left to right.
- **Citation positions.** OpenAI's citation offsets can be read as UTF-16
  units or as code points, and live testing did not show which one applies.
  Kenlith maps them defensively: a citation it cannot place exactly on a link
  to its address is listed under **Sources** only.

The `CHANGELOG.md` inside the 0.9.0 package still carries the heading
"0.9.0 (release candidate, not released)": the release package is a byte
copy of the accepted release candidate.

## 0.8.0 (2026-11-13)

**Summary.** Thinking effort: choose how much the model reasons for the next
message.

- **Thinking**, beside the model in the composer: Default, Low, Medium,
  High, Extra High (XHigh when narrow), Max. Each level is sent as the
  Responses API's `reasoning.effort`. **Default** sends no `reasoning` field,
  so the model keeps its own default and the request is the 0.7.0 request.
- **Per chat.** The level is saved with the chat (a new, optional field; older
  chats are read as Default and are not rewritten). The new user setting
  `kenlith.reasoning.defaultEffort` sets the level for chats without their
  own; a chat's own choice wins, Default included.
- **Per model.** Kenlith offers the levels documented for the selected model
  only: GPT-6.1-Sol, GPT-6-Astra, GPT-6.1 Terra, GPT-6-Sol and GPT-6-Luna
  accept all five. Any other model offers Default only and says *This model
  uses its default thinking level.*; the chat's saved level comes back with
  a model that accepts it.
- **Checked by Kenlith.** The page sends only the chosen value; Kenlith checks
  it against the six choices and the model before anything is sent, and only
  Kenlith's request builder writes the field. Project tools, commands and
  their continuations keep the level chosen at Send; changing it during a
  reply applies to the next message.
- **Refusals.** If OpenAI refuses a level, the reply shows the status and
  request ID, Kenlith does not send it again (not even without tools), and
  **Use Default** is offered; the saved level changes only if you choose it.
- Unchanged: sign-in, project sharing, Review Before Apply, command
  classification and approval, the output boundary.

## 0.7.0 (2026-11-12)

**Summary.** Controlled commands and tasks: ChatGPT can ask Kenlith to run
programs and workspace tasks in the project. Kenlith decides the risk from
the exact run; it asks only when a run crosses a boundary.

- **Two new tools**, `project_run_command` (a program with structured
  arguments, no shell string) and `project_run_task`.
- **Three classes.** Safe local checks run without a prompt; runs with side
  effects wait for one approval card showing exactly what would run; elevation,
  destructive, credential, outside-the-project, remote and cloud runs are
  refused. An approval covers one run and becomes void if the run changes.
- **Output** is cleaned and bounded, sent under the project's sharing
  permission; output about this computer or mostly outside the project needs
  its own **Share**. A single outbound boundary applies to
  every command result, checked again just before each request leaves:
  - git content reads exclude secret and excluded files in every revision;
  - commands naming such files send status only;
  - values of secret and excluded files are removed, also when encoded or
    partly printed;
  - wider credential formats, whole private keys, and credentials inside
    addresses are removed, as are long random-looking strings;
  - it fails closed when the project cannot be checked completely.
- **Results** say what happened: succeeded, non-zero exit, timed out,
  cancelled, could not start, refused. Stop and the time limit end the
  process tree; a program that detaches itself is reported as still running.
  Nothing is retried or resumed after a restart.
- **Git** runs get `core.fsmonitor=false`, `--no-ext-diff` and
  `--no-textconv`, so a repository's own configuration cannot start a
  program during a read.
- **Chat status** adds waiting for a command approval, waiting for an
  output-sharing decision, and running a command.
- **0.6.0 fixes.** The applied card shows when its change was undone; a file
  with unsaved changes from Kenlith's own Apply gets its own message; a click
  is no longer lost while the conversation redraws; the first sign-in notice
  no longer covers the view.
- **The chat tab**: one compact project line at the top
  and one message box at the bottom holding the message, **+**, the model and
  **Send**. **+** lists only what Kenlith can do here: **Attach selection**,
  **Project sharing…**, **Project context settings…**. The model selector
  moved from the header into the box. Kenlith has no thinking-effort setting,
  so none is shown. The tab uses the editor background; the project line no
  longer uses badge colours (3.9:1 in Dark Modern, 1.6:1 in High Contrast
  Light before).
- **Command card** always lists the effect (for example network) and the
  environment ("no changes" when none); paths and variables stay left to
  right, and ChatGPT's own words keep their direction in an Arabic chat.
- **Icon.** The editor tab shows the coloured Signal Rings, Signal Mint rings
  on a Deep Forest tile; the Activity Bar icon stays
  monochrome.
- New setting `kenlith.projectContext.commands` (on by default).
- New storage files `executions.json` and `executions.lock`; earlier versions
  ignore them.

## 0.6.0 (2026-11-09)

**Summary.** Review Before Apply: ChatGPT can propose edits to project files,
and Kenlith changes a file only when you press **Apply** on the exact diff you
reviewed.

- **Proposals.** A new tool, `project_propose_edit`, records edits to
  existing text files. It writes nothing.
- **Review after the answer.** The card comes after the answer has finished,
  with the files, lines removed and added, **Show diff** (the editor's diff,
  beside the chat), **Apply** and **Reject**. A proposal waiting for review
  holds no reply slot.
- **Apply** checks every file again (disk bytes, identity, editor text),
  writes the reviewed edits into the editor in one edit, and does not save.
  Undo works as usual. A changed, replaced, linked or unsaved file makes the
  proposal out of date; nothing is applied.
- **Separate from sharing.** A sharing permission never allows a change;
  Stop Sharing does not apply or reject anything.
- **Chat status.** The Chats list now says when a chat waits for your sharing
  decision (also during an answer), has changes to review, or is applying
  them, instead of "replying".
- New setting `kenlith.projectContext.proposals` (on by default).
- New storage files `proposals.json` and `proposals.lock`; earlier versions
  ignore them.

## 0.5.0 (2026-11-08)

**Summary.** Kenlith understands the open project better and can look things
up in it, read-only, after you allowed sharing for that project.

- **Project awareness.** The chat header shows the project and whether it is
  **not shared**, **shared** or has project **files off**. Knowing the
  project needs no dialog.
- **Better picks.** The file open in the editor counts when you ask about it
  ("explain this"), and the README and manifest when you ask what the project
  does. Each pick records why it was chosen.
- **Project tools.** ChatGPT can ask for
  a project summary, folder listings, files by name, text matches, up to 200
  lines of a file, and the names of the open files. Read-only, inside the
  project folder only, with the same exclusions as before (secrets, `.git`,
  dependency and build folders, links, binaries), at most 10 calls and 24,000
  characters per message. Files the tools sent are listed with the answer.
  Without a project permission, the first results are shown on the sharing
  card and sent only after **Allow**, so a project question that matches no
  file can still use the tools.
  New setting `kenlith.projectContext.tools` (on by default).
- **Hostile files.** Text in project files is treated as data; it cannot widen
  what the tools may read.
- More folders are skipped when looking through a project: caches, editor
  folders and temporary folders (`.cache`, `.idea`, `.vs`, `tmp`,
  `temp` and others).
- Unchanged: chats, groups, drafts, sign-in, project permissions, settings and
  the extension ID carry over from 0.4.1, and 0.4.1 can still open what 0.5.0
  writes.

## 0.4.1 (2026-11-03)

**Summary.** Plan Chat is now named Kenlith. Chats, groups, drafts, the model
choice, project sharing and sign-in carry over from Plan Chat 0.4.0, and Plan
Chat 0.4.0 can still open what 0.4.1 writes.

- The editor shows the name Kenlith: the Extensions view, the Activity Bar,
  the side bar, command palette entries (**Kenlith: …**), the settings
  section, notifications and dialogs.
- Settings are now `kenlith.instructions`, `kenlith.maxHistoryMessages`,
  `kenlith.context.maxSelectionCharacters` and
  `kenlith.projectContext.enabled`. Values you set under the old names are
  copied to the new ones the first time Kenlith starts. The old settings are
  kept, marked as replaced, so that Plan Chat 0.4.0 still finds them after a
  rollback. As before, only user settings count; a workspace cannot change
  them.
- On a new installation, the sign-in page shows the app name Kenlith. An
  existing sign-in is kept.
- The notes Kenlith adds to a request (project excerpts, a stopped reply) name
  Kenlith.
- Unchanged on purpose: the extension ID
  `local-open-source.plan-chat-antigravity`, command and view IDs, and the
  storage folder. Changing them would install a second extension or lose
  data.
- Package files are named `kenlith-antigravity-<version>.vsix`. Earlier
  packages keep their Plan Chat names.

## 0.4.0 (2026-10-31)

**Summary.** A workspace: chats open in editor tabs and the side bar lists your
account and your chats. Sending, consent, project context and sign-in work as
in 0.3.0. Chats, project identity, sign-in and settings from 0.3.0 are kept on
upgrade, and 0.3.0 can read what 0.4.0 writes.

- **Editor tabs:** one tab per chat, in the active editor group or to the side;
  restored after a restart. Switching to a chat puts the cursor in its message
  box.
- **Side bar:** **Account** (signed-in account, Using ChatGPT plan, Manage
  usage, model for new chats, Resume after a usage pause) and **Chats**
  (grouped by project and General, with states, Search, and your own groups).
- **Per-chat model**, with the last chosen model as the default for new chats.
- **Drafts** kept per chat and project across restarts; never sent by
  themselves.
- **Reliability:** one reply at a time per window; one reply at a time per
  chat across windows; the reply text is saved while it streams; a reply cut
  off by closing the editor is marked Interrupted and never sent again,
  including by 0.3.0 and 0.2.0 after a downgrade.
- **Consent cards belong to their chat;** stopping sharing, turning off project
  context and signing out (also in another window) reach every chat.
- No deletion of chats in this version.

## 0.3.0 (2026-10-30)

**Summary.** Project context: in a project chat, Plan Chat can read the
relevant files of the open folder on your computer and, after you allow it
for that project and ChatGPT account, send short excerpts with your
question. Also follows OpenAI's Sign in with ChatGPT UI guidelines. Chats,
sign-in and settings from 0.2.0 are kept on upgrade.

**Project context** (see README, **Project context**):

- Reads only when you send in a trusted project chat; never in General
  chats, never in the background, never outside the folder, never links,
  junctions, hard links, credential files or credential-like content.
- Asks before the first send per project and ChatGPT account, showing the
  files and lines; **Allow**, **Send without project files** or **Cancel**.
- Each answer shows the files and lines it used. **Manage project sharing…**
  stops sharing in every window; a reply streaming with that project is
  stopped; answers made under an earlier permission are not sent again.
- A last check just before each request confirms the permission, the
  account, workspace trust and unchanged files; otherwise nothing is sent.
- `planChat.projectContext.enabled` (user settings only) turns it off.
- History keeps only relative paths, line ranges and file hashes, never the
  excerpt text. The history file format stays version 1; 0.2.0 can still read
  it and does not send answers that used project files.

**Sign in with ChatGPT guidelines:**

- **Using ChatGPT plan** with **Manage usage** under the model list; Manage
  usage opens ChatGPT's usage settings after you confirm.
- The ChatGPT plan usage-limit error (`subscription_sharing_usage_limit_exceeded`),
  before or during a reply, offers **Manage usage** as its action and pauses
  sending until you choose **Resume** or sign in again. Other errors,
  including other 429 errors, are unchanged. Nothing is retried.
- A one-time welcome after the first sign-in explains that messages use your
  ChatGPT plan's usage limits and that Plan Chat itself is free. Users who
  were already signed in do not see it.

**Unchanged:** sign-in and token storage, the shape of the request sent to
OpenAI (the same fields; project excerpts are part of your message's text),
attached code, and the history file format.

**Fixed:** the reason a reply stopped part-way was lost from view right after
the reply ended; it now stays for the session.

## 0.2.0 (release candidate 1, 2026-10-29)

**Summary.** Chats are kept per project folder, with an **All Chats** list;
selected code can be attached to one message, explicitly and after approval;
VS Code and Antigravity IDE on Windows are both tested. Chats, sign-in and
settings from 0.1.2 are kept on upgrade.

**Fixed during release validation:**

- Two different folders whose names differ only in Unicode form (for
  example `Café` typed two ways) or in special letters (such as the Kelvin
  sign and `k`) shared one project, so one could list and send the other's
  chats. Each folder is now its own project.
- A message whose save failed (for example, a full disk) is given back in the
  input box instead of being lost.
- The sign-in pages no longer say "Antigravity IDE" in VS Code.
- The default instructions setting no longer says the assistant is inside
  Antigravity IDE; it now says "inside the user's code editor".
- A history file that is valid JSON but not in Plan Chat's format is kept
  aside and reported, instead of being overwritten.
- After the chat history or All Chats list is closed, the keyboard focus
  returns to the button that opened it.
- The right-click command is named **Attach Selection to Plan Chat**.

**Changed behaviour to know about:**

- Chats made by pre-release builds of this version need one **Relink to this
  project** each (they are never sent until then). Chats from 0.1.0 to 0.1.2
  are not affected.
- **Going back to 0.1.2** keeps every chat but lists all projects together and
  sends again answers that 0.2.0 left out of later messages.

**Known limitations:** tested only on Windows with VS Code 1.143 and
Antigravity IDE 1.107; screen readers not verified; server-side sign-out not
independently verified; no automatic timeout (use **Stop**). See the README.

The detailed notes of each development stage follow.

### Development notes (Phase 3.1)

Phase 3.1 stage 3, selected code:

- **Attach Selection** (editor right-click menu, the command palette, or the
  button under the message box) shows the selected code in a card above the
  message box: the exact text, the file and lines, and its size. Nothing is
  sent until you choose **Approve** and then send your message. **Remove**
  takes it away; **Refresh** takes the current text again.
- Only text you select is attached, never a whole file, and at most 12,000
  characters (`planChat.context.maxSelectionCharacters`, up to 20,000, user
  settings only).
- Some files are never attached: `.env` files, private keys and
  certificates, credential files, and anything in `.ssh`, `.aws`, `.azure`,
  `.gnupg`, `.kube` or `.docker`. There is no way to override this. Files
  outside the window's project folder are refused too. In a window with no
  folder, only untitled editors can be attached.
- Code that looks like it holds a password or key is flagged by line; you
  must confirm you reviewed those lines before approving. Nothing is removed
  from the code automatically.
- The code is sent once, with the message you send next. It is not saved:
  the history keeps only the file name, lines and size. To ask about it
  again, attach it again.
- The answer to a message with attached code is not sent with later
  messages, because it may quote the code. **Include in follow-ups** on that
  answer changes this for that answer only, after you confirm.
- Opening another chat, starting a new chat or changing the project removes
  attached code that was not sent yet.
- **Going back to 0.1.2:** 0.1.2 sends answers that were left out here with
  later messages again, so code those answers quoted can be sent again.

Phase 3.1 stage 2, chats per project:

- A window with one folder lists, opens and continues only that folder's
  chats. A window with no folder, or only remote folders, uses **General**.
  The view shows which one it is.
- In a window with several folders, chats follow the folder of the file you
  had open; with none, General until you choose a folder.
- Chats made before this version are kept exactly as they were. They are
  listed under **Earlier chats** in General windows. In a project window they
  open read-only, until you choose **Move to this project**.
- **All Chats…** (in the history list) shows every chat, grouped. Chats of
  another project or context open read-only, with **Move to this project**,
  **Relink to this project** or **Move to General**.
- The history file stores a key for each folder and the folder's name, never
  a path. The key comes from a random identity key kept in two files beside
  the history (`project-identity.key` and its `.bak`).
- Back up the whole Plan Chat storage folder together: `conversations.json`
  and the two key files. Restoring `conversations.json` alone loses nothing;
  its project chats then appear under Earlier identity key, ready to relink.
- **Going back to 0.1.2** keeps every chat and its tags. 0.1.2 does not
  separate projects; it lists all chats together. 0.1.0 also keeps only 30
  chats when it saves.

Stage 2 preflight:

- Plan Chat exports nothing to other extensions, in development and test
  hosts too. The UI tests run a throwaway test copy with its own entry point
  instead.
- **Sign Out** is in the Account panel only (still with confirmation); it is
  no longer in the view's "…" menu or the command palette.
- The edges of the message input, model selector and history button are
  easier to see (4.75:1 in Dark Modern, 3.4:1 in Light Modern).
- "YOU" and "ASSISTANT" are no longer shown; screen readers still hear them.
  Your messages are indented.
- Chat history shows relative times ("5 minutes ago"), with the full date
  under each chat.
- Escape closes the Account panel wherever the focus is in the view.

UI hardening, slice 2:

- The view's title reads "Plan Chat" once. The extra brand line, the second
  **+** and the email in the header are gone; the email is in the Account
  panel.
- One **New Chat**, in the view's title bar. Also in the command palette and
  at the top of the chat history.
- Chat history opens the editor's searchable list from the chat-title button
  or the title bar's **Show Chat History**. Chats and their ids are unchanged.
- **Sign Out** is also in the view's "…" menu; it still asks first.
- A failed reply is shown once, in the message. A reply cut off part-way
  says why under it. A notification appears only when the view is hidden.
- The view no longer widens past a narrow sidebar (240 px) when a message has
  a long code line or the chat has a long title.
- The input's placeholder uses the theme colour; code stays readable in
  Antigravity's High Contrast theme.

UI hardening, slice 1:

- **Account** opens a small panel with the signed-in account and a
  **Sign Out…** button. Account itself never signs out. Sign Out still asks
  for confirmation first, as before.
- Replies are shown as Markdown: paragraphs, bold and italic, lists, quotes,
  headings, links and code blocks with a **Copy** button. Raw HTML in a reply
  stays visible text. Images are never loaded; they appear as a link.
- Arabic, English and code mix correctly: each paragraph takes its own
  direction, Arabic lists put their numbers on the right, and code always
  reads left to right in its original order. Hidden direction characters in
  code are shown as markers; Copy keeps the code exactly.
- A link in a message opens in the browser only after Plan Chat shows its
  full address and you choose **Open Link**. Only http and https links work.
- While a reply streams, the view follows it only if you are at the end;
  scroll up to read and it stays put, with **Jump to latest**. The input stays
  editable, so you can write the next message; Send waits for the reply to
  finish or for Stop.
- Keyboard and screen readers: every control shows a focus outline, errors are
  announced, a finished reply is announced once, and Enter that confirms an
  IME composition no longer sends.

- New icon, approved by the project owner: Signal Rings. The Activity Bar
  uses a single-colour SVG that follows the editor theme (`media/chat.svg`).
  The extension gallery icon is off-white rings on Deep Forest `#103D32`
  (`media/icon.png`, 256 × 256).

- Workspace Trust is declared explicitly: `untrustedWorkspaces.supported:
  false`. Installed Plan Chat does not load in Restricted Mode (checked in VS
  Code 1.143 and Antigravity 1.107).
- `planChat.instructions` and `planChat.maxHistoryMessages` are user settings
  only (`application` scope), and Plan Chat also reads them from the user layer
  in code. **Migration:** if a workspace's `.vscode/settings.json` or
  `.code-workspace` file set either of them, that value is no longer used.
  Copy what you need into your user settings. The editor hides such workspace
  values from extensions, so Plan Chat cannot detect them and does not show a
  notice.
- Every request is limited to 80,000 characters (UTF-16 code units),
  counting the instructions, the history sent and the new message. A message
  that cannot fit is refused before it is saved or sent, and it goes back into
  the input box unchanged. Older history is left out whole, oldest first, and
  the view says how many messages were left out. This is a character limit,
  not the model's token limit.
- History sent with a request no longer starts with an answer whose question
  was left out.
- Text is given back in the input box, not lost, when a send is refused before
  saving: message too long, unavailable model, or a second send while one is
  starting.

## 0.1.2

- History is safe with several editor windows open. Every change runs as a
  transaction under a lock shared by all windows: re-read `conversations.json`,
  apply the one change, replace the file atomically. Windows no longer
  overwrite each other's chats or messages (0.1.1 lost them).
- Each window keeps its own open chat. The file's `currentId` now only records
  the last chat opened, for the next start.
- **+** no longer deletes empty chats, so a chat open in another window cannot
  disappear. Pressing **+** while already on an empty chat stays on it.
- A history file that cannot be read is kept as `conversations.corrupt-*.json`
  instead of being replaced by an empty history.
- On Windows, a save waits out another process reading the file instead of
  failing at once. A save that cannot complete reports "not saved" and leaves
  the file unchanged.
- Token refresh is coordinated across windows. One window refreshes at a time,
  under a shared lock. A window whose SecretStorage copy is older than the
  shared session generation waits for the newer copy instead of reusing a
  rotated refresh token. Sign-out in one window is honoured by all windows and
  cannot be undone by a refresh still running elsewhere.
- New files in global storage: `conversations.lock`, `session.lock` and
  `session-state.json`. They hold no credentials.
- After a send, the view re-reads the chat, so messages another window added
  to it appear.
- Tests: cross-process tests with separate OS processes for history and token
  refresh, and a real-editor test running two editor processes on one shared
  history.

## 0.1.1

- Refresh: classify OpenAI refresh errors. A revoked or invalid refresh token
  clears the local tokens and returns the view to sign-in; network failures,
  429 and 5xx keep the session.
- Refresh: re-read the latest credentials inside the serialized refresh, adopt
  a token rotated by another editor window, and reject tokens for a different
  account.
- Check `chatgpt.tokens.use.direct` before every request, not only at sign-in.
- Sign-out waits for an in-flight refresh, retries revocation on network/5xx
  failures, and a refresh can no longer restore tokens after sign-out.
- Token and revocation requests time out instead of hanging.
- Error messages include the HTTP status, plan error code and request ID, and
  are redacted before they are shown or saved to history.
- Chat: the model shown in the dropdown is the model sent; a stopped or
  interrupted reply is saved to the conversation it belongs to; double sends
  are ignored; empty placeholders are kept out of the request context.
- History: conversations with messages are no longer evicted when new chats
  are created; saves are serialized; titles never split an emoji.
- Arabic: message bubbles and the input use `dir="auto"`.
- Tests: unit tests for auth, refresh, chat, persistence and redaction, plus an
  integration suite for VS Code and Antigravity IDE.

## 0.1.0

- Initial local MVP for Antigravity IDE 2.5.5 / VS Code OSS 1.107.
- Official Sign in with ChatGPT OAuth flow with PKCE and ID-token validation.
- Streaming Responses API chat with local conversation storage.
- Account, model, new-chat, stop, and sign-out controls.

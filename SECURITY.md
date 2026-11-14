# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.9.x (current stable) | Yes |
| Earlier versions | No. Please upgrade to the latest release. |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull
requests or discussions.** Coordinate privately first so that a fix can be
released before the details are public.

Report privately through GitHub:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**. You can also go directly to
   <https://github.com/MWForgeEG/Kenlith/security/advisories/new>.

Please include:

- the Kenlith version, editor and version, and operating system;
- what you did, what you expected, and what happened;
- the smallest synthetic project or steps that reproduce it.

**Never include real credentials, tokens, account details or private project
content in a report.** Use made-up values (for example `ghp_` followed by
obviously fake characters) and a synthetic demo project. If a real secret was
exposed, revoke or rotate it first.

You should receive an acknowledgement within a few days. Kenlith is maintained
on a best-effort basis. We will keep you informed while we work on a fix, and
we will credit you in the advisory unless you prefer otherwise.

## What is especially security-sensitive

These are Kenlith's core promises. A bypass of any of them is a security
issue:

- **Project boundary escape:** reading, listing, sending or writing anything
  outside the open project folder, including through links, junctions, hard
  links or path tricks.
- **Sharing or consent bypass:** project content reaching OpenAI without the
  user's sharing permission for that project and account, or after sharing was
  stopped.
- **Secret leakage:** credential files, secret values, private keys or tokens
  leaving the machine in excerpts, tool results, command output or requests.
- **Command approval bypass:** a run with side effects starting without the
  user's approval, an approval being reused or changed, or a refused run
  starting anyway.
- **Review Before Apply bypass:** any file change written without the user
  pressing **Apply** on that exact proposal.
- **Authentication or token exposure:** sign-in tokens leaving the editor's
  secure storage, or reaching anything other than OpenAI's documented
  endpoints.

Text in a project that tries to instruct the model, also called prompt
injection, is expected. It is a vulnerability only if it makes Kenlith cross
one of the boundaries above.

## How Kenlith handles your data

- Kenlith uses OpenAI's documented Sign in with ChatGPT flow for open-source,
  locally hosted clients. It does not read browser cookies or other apps'
  sign-in caches.
- Access, refresh and ID tokens are stored in the editor's `SecretStorage`.
  Chats are stored locally in the extension's storage folder.
- Kenlith cannot access your ChatGPT conversations, memories or projects on
  chatgpt.com.
- **Deep Research** uses OpenAI's hosted public web search. A research request
  carries your question and the chat's text. Kenlith does not add project
  files, attached code or project tools to it. See the
  [security model](docs/SECURITY-MODEL.md#deep-research).
- If you suspect token exposure, choose **Sign Out** in Kenlith. Then
  disconnect the app in ChatGPT under **Settings > Security and login > Sign
  in with ChatGPT**. Sign Out asks OpenAI to revoke the session, but this has
  not been independently verified, so disconnecting the app is the sure way.
- Install Kenlith only from this repository's
  [Releases](https://github.com/MWForgeEG/Kenlith/releases), and check the
  published SHA-256.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for the full security
model.

'use strict';

// Scenario "workspace" for test/integration/workspace-ui.js (0.4.0). Runs only
// inside the throwaway test copy in its 'workspace' mode (lib/test-copy.js):
// the shipped wiring (Account and Chats trees, chats in editor tabs) with the
// fakes of sidebar-ui.js (no network, fake sign-in and model). The runner
// drives the real editor over its debugging port; this side seeds synthetic
// chats, runs real commands, and writes what the extension host sees. The
// two sides hand over through files in PLAN_CHAT_IT_UI_DIR.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { ConsentStore } = require('../src/consent');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(engine, context) {
  const dir = process.env.PLAN_CHAT_IT_UI_DIR;
  const phase = process.env.PLAN_CHAT_IT_PHASE || '1';
  const out = (name, data) => fs.writeFileSync(path.join(dir, `ws-${name}.json`), JSON.stringify(data, null, 2));
  const waitFile = async (name, timeout = 240000) => {
    const file = path.join(dir, `ws-${name}.json`);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
      await sleep(200);
    }
    throw new Error(`no ${name} from the runner`);
  };
  const requests = [];
  const errors = [];
  // The synthetic account has an id from the start (project context needs
  // one). Adding it later would be an account change, which ends pending work.
  const getSession = engine.authService.getSession;
  engine.authService.getSession = async () => { const session = await getSession(); return session ? { ...session, subject: 'synthetic-subject-1' } : session; };
  await engine.rememberSession();
  const store = engine.store;
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => ({ label: tab.label, group: group.viewColumn, webview: tab.input instanceof vscode.TabInputWebview ? String(tab.input.viewType) : null, active: tab.isActive })));
  // Every model request is recorded (synthetic text only); "HANG" streams a
  // little and then waits until it is stopped or the window closes.
  const stream = engine.openAIService.streamResponse.bind(engine.openAIService);
  engine.openAIService.streamResponse = async (options) => {
    const entry = { phase, at: Date.now(), model: options.model, effort: options.request?.reasoning ? options.request.reasoning.effort : null, question: options.messages.at(-1).content.slice(0, 120), count: options.messages.length, tools: Boolean(options.request?.tools), toolOutputs: 0 };
    requests.push(entry);
    if (options.onToolCalls) {
      // 0.5.0 RC3: what the tool loop hands back for sending.
      const onToolCalls = options.onToolCalls;
      options = { ...options, onToolCalls: async (calls, current) => {
        const next = await onToolCalls(calls, current);
        if (next) entry.toolOutputs += next.continuation.filter((item) => item.type === 'function_call_output').length;
        return next;
      } };
    }
    // 0.9.0 Deep Research (test/integration/research-ui.js): a research
    // request is answered by replaying the recorded live run-2 stream
    // (PLAN_CHAT_IT_RESEARCH_FIXTURE) through the engine's own callbacks;
    // nothing leaves the computer. "HANG" stops after the first search and
    // waits until the run is stopped.
    entry.research = Boolean(options.request?.research);
    entry.researchTools = options.request?.research ? options.request.research.tools : null;
    entry.researchToolChoice = options.request?.research ? options.request.research.toolChoice : null;
    if (options.request?.research && process.env.PLAN_CHAT_IT_RESEARCH_FIXTURE) {
      if (options.preflight) await options.preflight();
      const fixture = JSON.parse(fs.readFileSync(process.env.PLAN_CHAT_IT_RESEARCH_FIXTURE, 'utf8'));
      const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      const hang = options.messages.at(-1).content.includes('HANG');
      let text = '';
      let searches = 0;
      for (const event of fixture.events) {
        if (options.signal.aborted) throw aborted();
        const item = event.item || {};
        if (event.type === 'response.output_item.added' && item.type === 'web_search_call') options.onResearch?.({ kind: 'search', id: item.id });
        else if (event.type === 'response.output_item.done' && item.type === 'web_search_call') {
          options.onResearch?.({ kind: 'searched', id: item.id, action: item.action.type, status: item.status });
          searches += 1;
          if (hang && searches === 1) await new Promise((resolve, reject) => { if (options.signal.aborted) reject(aborted()); options.signal.addEventListener('abort', () => reject(aborted())); });
        } else if (event.type === 'response.output_item.added' && item.type === 'message') options.onResearch?.({ kind: 'writing' });
        else if (event.type === 'response.output_text.delta') { text += event.delta; options.onDelta(event.delta); } else if (event.type === 'response.output_text.annotation.added') options.onResearch?.({ kind: 'annotation', annotation: event.annotation });
        await sleep(event.type.startsWith('response.web_search_call') || event.type.startsWith('response.output_item') ? 120 : 8);
      }
      return text;
    }
    if (options.messages.at(-1).content.includes('HANG')) {
      if (options.preflight) await options.preflight();
      options.onDelta('This reply is cut off by the restart. ');
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return stream(options);
  };
  try {
    if (phase === 'composer') {
      // 0.7.0 RC2 composer acceptance (test/integration/composer-ui.js): two
      // chats in two groups, then editor commands on request (themes, side
      // bar, group layout) until the runner is done.
      // A fresh Antigravity profile reloads its window once during its own
      // first-run onboarding (seen 73 s after start, whatever the test was
      // doing). This phase then runs again: it reuses the chats it made and
      // carries on with the runner's requests, instead of seeding twice.
      const idsFile = path.join(dir, 'ws-composer-ids.json');
      let a;
      let h;
      if (fs.existsSync(idsFile)) {
        const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
        a = await store.getConversation(ids.a);
        h = await store.getConversation(ids.h);
        out('reloaded-composer', { at: new Date().toISOString(), tabs: tabs() });
      } else {
        store.currentId = undefined;
        a = await store.newConversation();
        await store.addMessage('user', 'Release notes for the workspace', a.id);
        await store.addMessage('assistant', 'Here are the **release notes**:\n\n- Chats open in editor tabs\n- The composer holds the model and the actions\n\n```js\nconst tabs = true;\n```', a.id);
        store.currentId = undefined;
        h = await store.newConversation();
        await store.addMessage('user', 'هلا هلا', h.id);
        await store.addMessage('assistant', 'أهلًا. شغّل `npm test` في المجلد `src/app` ثم راجع الملف **README.md** قبل الإصدار.', h.id);
        fs.writeFileSync(idsFile, JSON.stringify({ a: a.id, h: h.id }));
        await vscode.commands.executeCommand('workbench.view.extension.planChat');
        await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: a.id } });
        await vscode.commands.executeCommand('planChat.openChatBeside', { type: 'chat', item: { id: h.id } });
        await sleep(1500);
        out('ready-composer', { ids: { a: a.id, h: h.id }, tabs: tabs() });
      }
      let first = 1;
      while (fs.existsSync(path.join(dir, `ws-cmd-${first}-done.json`))) first += 1;
      for (let n = first; ; n += 1) {
        const request = await waitFile(`cmd-${n}`, 20 * 60 * 1000);
        if (request.done) break;
        const result = {};
        try {
          if (request.theme) await vscode.workspace.getConfiguration('workbench').update('colorTheme', request.theme, vscode.ConfigurationTarget.Global);
          if (request.command) await vscode.commands.executeCommand(request.command, ...(request.args || []));
          if (request.openFile) await vscode.window.showTextDocument(vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, request.openFile)), { viewColumn: request.column || vscode.ViewColumn.One, preview: false });
          if (request.openChat) await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: { a: a.id, h: h.id }[request.openChat] } });
          if (request.state) {
            result.chats = {};
            for (const [key, id] of Object.entries({ a: a.id, h: h.id })) {
              const chat = await store.getConversation(id);
              result.chats[key] = { title: chat.title, model: chat.model, reasoningEffort: chat.reasoningEffort, messages: chat.messages.length };
            }
            // 0.8.0: what the (fake) transport received, synthetic text only.
            result.requests = requests.map((entry) => ({ model: entry.model, effort: entry.effort, question: entry.question, research: entry.research, researchTools: entry.researchTools, researchToolChoice: entry.researchToolChoice, tools: entry.tools }));
            // 0.9.0: the stored research record of each chat's last reply.
            for (const [key, id] of Object.entries({ a: a.id, h: h.id })) {
              const last = (await store.getConversation(id)).messages.filter((m) => m.role === 'assistant').at(-1);
              result.chats[key].lastReply = last ? { research: last.research || null, stopped: Boolean(last.stopped), error: Boolean(last.error), interrupted: Boolean(last.interrupted), chars: (last.content || '').length } : null;
            }
          }
          await sleep(request.wait || 600);
          result.tabs = tabs();
          result.theme = vscode.window.activeColorTheme.kind;
        } catch (error) {
          result.error = String(error?.message || error);
        }
        out(`cmd-${n}-done`, result);
      }
    } else if (phase === '1') {
      store.currentId = undefined;
      const a = await store.newConversation();
      await store.addMessage('user', 'Release notes for the workspace', a.id);
      await store.addMessage('assistant', 'Here are the **release notes**:\n\n- Chats open in editor tabs\n- The side bar lists your chats\n\n```js\nconst tabs = true;\n```', a.id);
      store.currentId = undefined;
      const b = await store.newConversation();
      await store.addMessage('user', 'ما هي خطة الإصدار؟', b.id);
      await store.addMessage('assistant', 'الخطة جاهزة. استخدم `npm test` قبل الإصدار، ثم راجع **الملاحظات**.', b.id);
      store.currentId = undefined;
      const c = await store.newConversation();
      await store.addMessage('user', 'Long running question', c.id);
      await store.addMessage('assistant', 'First answer.', c.id);
      store.currentId = undefined;
      const general = await store.newConversation();
      await store.addMessage('user', 'A General chat from another window', general.id);
      await store.moveConversation(general.id, { kind: 'general' });
      const group = await store.createGroup('Release');
      await store.setConversationGroup(a.id, group.id);
      await store.setConversationGroup(c.id, group.id);
      await vscode.commands.executeCommand('workbench.view.extension.planChat');
      await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: a.id } });
      await vscode.commands.executeCommand('planChat.openChatBeside', { type: 'chat', item: { id: b.id } });
      await sleep(1500);
      out('ready-1', { ids: { a: a.id, b: b.id, c: c.id, general: general.id }, groupId: group.id, tabs: tabs() });
      await waitFile('go-2');
      const shownA = await store.getConversation(a.id);
      const draftsFile = path.join(context.globalStorageUri.fsPath, 'drafts.json');
      const drafts = fs.existsSync(draftsFile) ? JSON.parse(fs.readFileSync(draftsFile, 'utf8')).drafts : {};
      out('state-2', {
        tabs: tabs(),
        open: [...engine.openChatIds()],
        aMessages: shownA.messages.map((message) => ({ role: message.role, content: message.content.slice(0, 80), inProgress: Boolean(message.inProgress) })),
        aModel: shownA.model,
        draftB: drafts[b.id] ? { length: drafts[b.id].text.length, text: drafts[b.id].text } : null,
        requests
      });
      // D-1 (RC5): the project consent flow in a real editor. The fake account
      // gets an id so project context applies (as the earlier suites do).
      await waitFile('go-p');
      store.currentId = undefined;
      const p = await store.newConversation();
      await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: p.id } });
      await sleep(1500);
      out('ready-p', { id: p.id });
      await waitFile('done-p');
      const shownP = await store.getConversation(p.id);
      const draftsFileP = path.join(context.globalStorageUri.fsPath, 'drafts.json');
      const draftsP = fs.existsSync(draftsFileP) ? JSON.parse(fs.readFileSync(draftsFileP, 'utf8')).drafts : {};
      out('state-p', { messages: shownP.messages.map((m) => ({ role: m.role, content: m.content.slice(0, 80), contextUsed: (m.contextUsed || []).map((u) => u.relPath) })), draft: draftsP[p.id] ? draftsP[p.id].text : null, requests });
      // D-2 (0.5.0 RC3, DEC-PLANCHAT-024): sharing stopped, then a question
      // that matches no file; the model asks for the project summary.
      await waitFile('go-t');
      const consents = new ConsentStore(context.globalStorageUri.fsPath);
      for (const record of await consents.list()) {
        if (record.state === 'active') await consents.revoke({ projectKey: record.projectKey, provider: record.provider, accountRef: record.accountRef }, 'user');
      }
      store.currentId = undefined;
      const t = await store.newConversation();
      await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: t.id } });
      await sleep(1500);
      out('ready-t', { id: t.id, activeBefore: (await consents.list()).filter((record) => record.state === 'active').length });
      await waitFile('done-t');
      const shownT = await store.getConversation(t.id);
      const replyT = shownT.messages.filter((m) => m.role === 'assistant').at(-1);
      out('state-t', {
        reply: replyT && { content: replyT.content.slice(0, 80), provenance: replyT.provenance, consentId: replyT.consentId },
        active: (await consents.list()).filter((record) => record.state === 'active').map((record) => record.consentId),
        requests: requests.filter((request) => request.question.includes('TOOLCARD'))
      });
      // D-3 (0.6.0 Review Before Apply): under the grant from D-2, a model
      // proposes one edit; the user reviews the diff and applies it.
      await waitFile('go-r');
      store.currentId = undefined;
      const r = await store.newConversation();
      await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: r.id } });
      await sleep(1500);
      const notes = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'src', 'notes.js');
      const notesDoc = () => vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === 'file' && doc.uri.fsPath.toLowerCase() === notes.toLowerCase());
      const diffTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputTextDiff).map((tab) => tab.label);
      out('ready-r', { id: r.id });
      await waitFile('reviewing-r');
      // The click itself must have reached the extension (diff documents made).
      const diag = { diffDocuments: [...engine.review.contents.keys()].length };
      out('state-r1', { status: engine.chatStatus(r.id), disk: fs.readFileSync(notes, 'utf8'), dirty: Boolean(notesDoc()?.isDirty), editorText: notesDoc()?.getText() ?? null, diffTabs: diffTabs(), diag });
      // The diff tab is closed so the chat tab is shown again for Apply.
      const diffs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputTextDiff);
      await vscode.window.tabGroups.close(diffs).then(undefined, () => undefined);
      await sleep(800);
      out('diff-closed-r', { left: diffTabs().length });
      await waitFile('done-r');
      await sleep(500);
      const applied = notesDoc();
      out('state-r', { status: engine.chatStatus(r.id), text: applied?.getText() ?? null, dirty: Boolean(applied?.isDirty), disk: fs.readFileSync(notes, 'utf8'), requests: requests.filter((request) => request.question.includes('PROPOSE')) });
      // Nothing unsaved is left for the quit below: the edit is reverted and
      // the editors opened by the review are closed.
      if (applied) {
        await vscode.window.showTextDocument(applied);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const textTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => !(tab.input instanceof vscode.TabInputWebview));
      if (textTabs.length) await vscode.window.tabGroups.close(textTabs).then(undefined, () => undefined);
      out('closed-r', { disk: fs.readFileSync(notes, 'utf8') });
      // D-4 (0.7.0 controlled execution): a Class A run with no card and a
      // Class B run behind one approval card.
      await waitFile('go-x');
      store.currentId = undefined;
      const x = await store.newConversation();
      await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: x.id } });
      await sleep(1500);
      const marker = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'd4-ran.txt');
      out('ready-x', { id: x.id, markerBefore: fs.existsSync(marker) });
      await waitFile('card-x');
      out('state-x1', { status: engine.chatStatus(x.id), markerBeforeRun: fs.existsSync(marker) });
      await waitFile('done-x');
      await sleep(800);
      const replyX = (await store.getConversation(x.id)).messages.filter((m) => m.role === 'assistant').at(-1);
      out('state-x', { marker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null, commands: replyX?.commands || [], status: engine.chatStatus(x.id), requests: requests.filter((r) => r.question.includes('RUNCMD')) });
      if (fs.existsSync(marker)) fs.rmSync(marker);
      // U3 (0.6.0 debt): a history refresh with the same messages (what the
      // history file watcher does) must not redraw the conversation.
      await waitFile('go-u3');
      await engine.historyChanged();
      await sleep(600);
      out('done-u3', {});
      await waitFile('go-3');
      await sleep(800);
      const shownC = await store.getConversation(c.id);
      out('state-3', {
        cLast: shownC.messages.at(-1) && { content: shownC.messages.at(-1).content, inProgress: Boolean(shownC.messages.at(-1).inProgress) },
        leaseLive: await engine.leases.isLive(c.id),
        replying: engine.chatStatus(c.id),
        requests
      });
      // Restart during the reply: quit the editor normally while it streams.
      await vscode.commands.executeCommand('workbench.action.quit');
      return;
    }
    // Phase 2: after the restart.
    const ids = (await waitFile('ready-1')).ids;
    await sleep(4000);
    out('ready-p2', { tabs: tabs(), requestsAtStart: requests.length, bound: [...engine.openChatIds()] });
    await waitFile('go-p2');
    await sleep(800);
    const shownC = await store.getConversation(ids.c);
    out('state-p2', {
      tabs: tabs(),
      bound: [...engine.openChatIds()],
      cLast: shownC.messages.at(-1) && { content: shownC.messages.at(-1).content, interrupted: Boolean(shownC.messages.at(-1).interrupted), inProgress: Boolean(shownC.messages.at(-1).inProgress), contextPolicy: shownC.messages.at(-1).contextPolicy },
      requests,
      groups: (await store.listGroups()).map((group) => group.name)
    });
    await vscode.commands.executeCommand('workbench.action.quit');
  } catch (error) {
    errors.push(String(error?.stack || error));
    out(`error-${phase}`, { errors });
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

module.exports = { run };

'use strict';

// Real-editor checks for Workspace Trust and configuration precedence, each in
// a throwaway profile. Nothing touches the installed extension or real data.
//
//   restricted  – fresh synthetic folder, trust enforced (no --disable-workspace-trust),
//                 startup trust prompt suppressed so the folder stays untrusted.
//   config      – trusted run; user settings, workspace settings and a
//                 language-specific override written with synthetic values.
//
// Usage: node test/integration/trust-config.js <editor executable> [restricted|config|all]

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');

const [executable, which = 'all'] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}

const root = path.resolve(__dirname, '..', '..');
// Kenlith's code: the project, or the release candidate (WP-06, lib/candidate.js).
const { codeRoot } = require('./lib/test-copy');
const manifest = require(path.join(root, 'package.json'));

// Copies the extension's runtime files into a throwaway extensions folder so
// the editor loads Kenlith as an installed extension rather than as the
// development extension. No VSIX is built.
function installCopy(extensionsDir) {
  const target = path.join(extensionsDir, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
  for (const item of ['package.json', 'src', 'media', 'LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md']) {
    fs.cpSync(path.join(codeRoot, item), path.join(target, item), { recursive: true });
  }
  return target;
}

function launch(phase, { trustEnforced, userSettings, workspaceSettings, installed }) {
  const sandbox = makeOwnedTempDir(`plan-chat-${phase}-`);
  const userData = path.join(sandbox, 'user-data');
  const folder = path.join(sandbox, 'synthetic-project');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'sample.txt'), 'synthetic file\n');
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(userSettings, null, 2));
  if (workspaceSettings) {
    fs.writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify(workspaceSettings, null, 2));
  }
  const extensionsDir = path.join(sandbox, 'extensions');
  if (installed) {
    installCopy(extensionsDir);
  }
  const resultFile = path.join(sandbox, 'result.json');
  const env = { ...process.env, PLAN_CHAT_IT_PHASE: phase, PLAN_CHAT_IT_RESULT: resultFile };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    folder,
    `--extensionDevelopmentPath=${installed ? path.join(__dirname, 'probe-extension') : root}`,
    `--extensionTestsPath=${path.join(__dirname, 'suite', 'index.js')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    ...(installed ? [] : ['--disable-extensions']),
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window'
  ];
  if (!trustEnforced) {
    args.push('--disable-workspace-trust');
  }
  const run = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 180_000 });
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : undefined;
  return { sandbox, exit: run.status, report };
}

function check(label, ok, detail) {
  console.log(`  ${ok === undefined ? 'NOT VERIFIED' : ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  return ok !== false;
}

let allOk = true;

const TRUST_SETTINGS = {
  'security.workspace.trust.enabled': true,
  'security.workspace.trust.startupPrompt': 'never',
  'security.workspace.trust.untrustedFiles': 'open'
};

for (const variant of ['restricted', 'restricted-installed', 'control-installed']) {
  if (which !== 'all' && which !== variant && !(which === 'restricted' && variant !== 'control-installed')) {
    continue;
  }
  const installed = variant.endsWith('installed');
  const trustEnforced = variant !== 'control-installed';
  const { report, exit, sandbox } = launch('restricted', {
    trustEnforced,
    installed,
    userSettings: TRUST_SETTINGS
  });
  console.log(`[${variant}] ${report ? `${report.host} ${report.version}` : 'no report'} (exit ${exit}) ${sandbox}`);
  if (!report) {
    allOk = check('suite ran in Restricted Mode', undefined, 'no result file: the test host may not run in Restricted Mode') && allOk;
  } else {
    const declared = manifest.capabilities?.untrustedWorkspaces?.supported;
    console.log(`  INFO  manifest untrustedWorkspaces.supported = ${JSON.stringify(declared)}; loaded from ${report.extensionPath || 'n/a'}`);
    const detail = `found=${report.extensionFound}, activeBefore=${report.activeBefore}, activeAfter=${report.extensionActive}, command=${report.commandRegistered}, open: ${report.openResult}`;
    if (variant === 'control-installed') {
      // Control: trusted window, same installed copy. Proves the copy is loadable.
      allOk = check('control: window trusted', report.isTrusted === true, `isTrusted=${report.isTrusted}`) && allOk;
      allOk = check('control: installed copy loads and activates', report.extensionFound && report.extensionActive, detail) && allOk;
    } else {
      allOk = check('window is untrusted', report.isTrusted === false, `isTrusted=${report.isTrusted}`) && allOk;
      const inactive = report.extensionActive === false && report.commandRegistered === false;
      if (variant === 'restricted') {
        // Development extension: records the host's behaviour; not the release proof.
        check('development copy blocked by Restricted Mode', inactive ? true : undefined, detail);
      } else {
        allOk = check('installed copy blocked by Restricted Mode', inactive, detail) && allOk;
      }
    }
  }
}

if (which === 'config' || which === 'all') {
  const { report, exit, sandbox } = launch('config', {
    trustEnforced: false,
    userSettings: {
      'planChat.instructions': 'USER-LEVEL synthetic instructions',
      'planChat.maxHistoryMessages': 12,
      '[plaintext]': { 'planChat.instructions': 'LANGUAGE-OVERRIDE synthetic instructions' }
    },
    workspaceSettings: {
      'planChat.instructions': 'WORKSPACE synthetic instructions',
      'planChat.maxHistoryMessages': 99,
      // Kenlith 0.4.1: a repository must not set the new keys either.
      'kenlith.instructions': 'WORKSPACE kenlith synthetic instructions',
      'kenlith.maxHistoryMessages': 77,
      '[plaintext]': { 'planChat.instructions': 'WORKSPACE-LANGUAGE synthetic instructions', 'kenlith.instructions': 'WORKSPACE-LANGUAGE kenlith synthetic instructions' }
    }
  });
  console.log(`[config] ${report ? `${report.host} ${report.version}` : 'no report'} (exit ${exit}) ${sandbox}`);
  if (!report) {
    allOk = check('config suite ran', false) && allOk;
  } else {
    const inspect = report.inspect.instructions;
    console.log(`  INFO  editor get(instructions) = ${JSON.stringify(report.get.instructions)}`);
    console.log(`  INFO  editor get(maxHistoryMessages) = ${JSON.stringify(report.get.maxHistoryMessages)}`);
    console.log(`  INFO  inspect layers: global=${JSON.stringify(inspect.globalValue)} workspace=${JSON.stringify(inspect.workspaceValue)} folder=${JSON.stringify(inspect.workspaceFolderValue)}`);
    console.log(`  INFO  language-scoped get = ${JSON.stringify(report.languageScoped.get)}; languageIds=${JSON.stringify(report.languageScoped.inspect?.languageIds)}`);
    allOk = check('inspect exposes the user layer', inspect.globalValue === 'USER-LEVEL synthetic instructions') && allOk;
    const scoped = manifest.contributes.configuration.properties['planChat.instructions'].scope === 'application';
    if (scoped) {
      allOk = check('application scope: workspace value hidden from the API', inspect.workspaceValue === undefined && inspect.workspaceLanguageValue === undefined,
        `workspace=${JSON.stringify(inspect.workspaceValue)} workspaceLanguage=${JSON.stringify(inspect.workspaceLanguageValue)}`) && allOk;
      allOk = check('application scope: workspace history limit hidden', report.get.maxHistoryMessages === 12, String(report.get.maxHistoryMessages)) && allOk;
    } else {
      allOk = check('inspect exposes the workspace layer', inspect.workspaceValue === 'WORKSPACE synthetic instructions') && allOk;
    }
    if (typeof report.extensionReads === 'string') {
      console.log(`  INFO  ${report.extensionReads}`);
      check('editor itself ignores the workspace value', report.get.instructions === 'USER-LEVEL synthetic instructions' ? true : undefined,
        report.get.instructions === 'USER-LEVEL synthetic instructions' ? '' : 'workspace value wins at baseline (window scope)');
    } else {
      allOk = check('extension uses the user-level instructions', report.extensionReads.instructions === 'USER-LEVEL synthetic instructions', JSON.stringify(report.extensionReads.instructions)) && allOk;
      allOk = check('extension uses the user-level history limit', report.extensionReads.maxHistoryMessages === 12, String(report.extensionReads.maxHistoryMessages)) && allOk;
      check('editor itself ignores the workspace value (application scope)', report.get.instructions === 'USER-LEVEL synthetic instructions' ? true : undefined,
        `editor get() = ${JSON.stringify(report.get.instructions)}`);
    }
    if (report.kenlith) {
      const k = report.kenlith.inspect;
      allOk = check('Kenlith: the user value was copied to kenlith.* in user settings', k.instructions.globalValue === 'USER-LEVEL synthetic instructions' && k.maxHistoryMessages.globalValue === 12,
        `kenlith global: ${JSON.stringify(k.instructions.globalValue)}, ${JSON.stringify(k.maxHistoryMessages.globalValue)}`) && allOk;
      allOk = check('Kenlith: the planChat.* user value is kept for a rollback', report.kenlith.legacyAfter === 'USER-LEVEL synthetic instructions', JSON.stringify(report.kenlith.legacyAfter)) && allOk;
      allOk = check('Kenlith: workspace and language values of kenlith.* are hidden (application scope)', k.instructions.workspaceValue === undefined && k.instructions.workspaceLanguageValue === undefined && k.maxHistoryMessages.workspaceValue === undefined,
        `workspace=${JSON.stringify(k.instructions.workspaceValue)} workspaceLanguage=${JSON.stringify(k.instructions.workspaceLanguageValue)}`) && allOk;
      allOk = check('Kenlith: the editor merge of kenlith.* gives the user value', report.kenlith.get.instructions === 'USER-LEVEL synthetic instructions' && report.kenlith.get.maxHistoryMessages === 12,
        JSON.stringify(report.kenlith.get)) && allOk;
    } else if (manifest.contributes.configuration.properties['kenlith.instructions']) {
      allOk = check('Kenlith: kenlith.* recorded after activation', false) && allOk;
    }
  }
}

process.exit(allOk ? 0 : 1);

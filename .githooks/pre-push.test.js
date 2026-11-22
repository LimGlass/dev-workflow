#!/usr/bin/env node
// End-to-end tests for .githooks/pre-push. Run from anywhere:
//   node .githooks/pre-push.test.js
// Each case runs real git in a temporary repository whose core.hooksPath points
// at this directory, pushing to a temporary local bare remote. Nothing outside
// the temp directory is touched. Exits 1 if any case fails.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS = __dirname;
const HOOK = path.join(HOOKS, 'pre-push');

// Keep the caller's git environment (e.g. when run from inside a hook) out of the fixtures.
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX)$/.test(k)) delete env[k];
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30000 });
function must(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`setup failed: git ${args.join(' ')}\n${r.stderr}`);
  return (r.stdout || '').trim();
}

let passed = 0;
let failed = 0;
function report(ok, label, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`      ${String(detail).trim().split('\n').join('\n      ')}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-test-'));
try {
  console.log('\n== HOOK FILE ==');
  const exists = fs.existsSync(HOOK);
  report(exists, '.githooks/pre-push exists');
  if (exists) {
    const text = fs.readFileSync(HOOK, 'utf8');
    report(text.startsWith('#!/bin/sh\n'), 'starts with #!/bin/sh and an LF line ending');
    report(!text.includes('\r'), 'has no CR characters (CRLF would break sh)');
    if (process.platform !== 'win32') {
      report((fs.statSync(HOOK).mode & 0o111) !== 0, 'is executable in the working tree');
    }
    const staged = git(HOOKS, 'ls-files', '-s', '--', 'pre-push');
    if (staged.status === 0 && staged.stdout.trim()) {
      report(staged.stdout.startsWith('100755 '), 'is committed with mode 100755', staged.stdout);
    } else {
      console.log('SKIP  mode check: pre-push is not in a git index here');
    }
    const template = path.join(HOOKS, '..', 'templates', '.githooks', 'pre-push');
    if (fs.existsSync(template)) {
      report(fs.readFileSync(template, 'utf8') === text, 'templates/.githooks/pre-push matches .githooks/pre-push');
    }
  }

  // Fixtures: a bare remote with main, agent/old and a tag, and a clone-like work repo.
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  const noHooks = path.join(tmp, 'no-hooks');
  fs.mkdirSync(noHooks);
  must(tmp, 'init', '-q', '--bare', remote);
  fs.mkdirSync(work);
  must(work, 'init', '-q', '-b', 'feature');
  for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
    must(work, 'config', k, v);
  }
  must(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  must(work, 'remote', 'add', 'origin', remote);
  // Seed the remote with no hooks active (an empty hooks directory).
  must(work, '-c', `core.hooksPath=${noHooks}`, 'push', '-q', 'origin', 'HEAD:main', 'HEAD:agent/old');
  must(work, 'tag', 'v1');
  must(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  must(work, 'config', 'core.hooksPath', HOOKS);
  const mainBefore = must(remote, 'rev-parse', 'refs/heads/main');
  const remoteHas = (ref) => git(remote, 'rev-parse', '--verify', '-q', ref).status === 0;

  console.log('\n== MUST REJECT ==');
  const reject = [
    ['push', 'origin', 'HEAD:main'],
    ['push', '--force', 'origin', '+HEAD:main'],
    ['push', 'origin', '--delete', 'main'],
    ['push', 'origin', 'HEAD:refs/heads/main'],
    ['push', 'origin', 'HEAD:MAIN'],
    ['push', 'origin', 'HEAD:agent/claude/y', 'HEAD:main'],
  ];
  for (const args of reject) {
    const r = git(work, ...args);
    const mainAfter = git(remote, 'rev-parse', 'refs/heads/main').stdout.trim();
    const ok = r.status !== 0 && /ADR-0001/.test(r.stderr) && mainAfter === mainBefore && !remoteHas('refs/heads/agent/claude/y');
    report(ok, `git ${args.join(' ')}`, ok ? '' : `exit ${r.status}; main ${mainAfter === mainBefore ? 'unchanged' : 'CHANGED'}\n${r.stderr}`);
  }

  console.log('\n== MUST ACCEPT ==');
  const accept = [
    { args: ['push', 'origin', 'HEAD:agent/claude/x'], check: () => remoteHas('refs/heads/agent/claude/x') },
    { args: ['push', 'origin', 'v1'], check: () => remoteHas('refs/tags/v1') },
    { args: ['push', 'origin', '--delete', 'agent/old'], check: () => !remoteHas('refs/heads/agent/old') },
  ];
  for (const { args, check } of accept) {
    const r = git(work, ...args);
    const ok = r.status === 0 && check();
    report(ok, `git ${args.join(' ')}`, ok ? '' : `exit ${r.status}\n${r.stderr}`);
  }
  report(must(remote, 'rev-parse', 'refs/heads/main') === mainBefore, 'remote main never moved');

  console.log(`\n${passed} passed, ${failed} failed`);
} catch (e) {
  failed++;
  console.log(`FAIL  ${e.message}`);
  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

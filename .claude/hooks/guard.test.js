#!/usr/bin/env node
// Tests for guard.js. Run from anywhere: node .claude/hooks/guard.test.js
// Each case runs guard.js as Claude Code would (hook JSON on stdin) and checks
// the exit code: 2 = blocked, 0 = allowed. Exits 1 if any case fails.

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD = path.join(__dirname, 'guard.js');

// ---------------------------------------------------------------- fixtures

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
function repo(name, branch) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', branch);
  return dir;
}
const onMain = repo('on-main', 'main');
const onFeature = repo('on-feature', 'feature');
// Branch "feat" whose push target is origin/main (push.default=upstream).
const tracksMain = repo('tracks-main', 'feat');
git(tracksMain, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
  'commit', '-q', '--allow-empty', '-m', 'init');
git(tracksMain, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
git(tracksMain, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
git(tracksMain, 'config', 'branch.feat.remote', 'origin');
git(tracksMain, 'config', 'branch.feat.merge', 'refs/heads/main');
git(tracksMain, 'config', 'push.default', 'upstream');

const encoded = (s) => Buffer.from(s, 'utf16le').toString('base64');

// ------------------------------------------------------------------- cases
// Default cwd is a repo on branch "feature", so a bare push there is allowed.

const BLOCK = [
  // git push -> main: remotes, refspecs, flags
  { group: 'push', cmd: 'git push origin main' },
  { group: 'push', cmd: 'git push upstream main' },
  { group: 'push', cmd: 'git push origin HEAD:main' },
  { group: 'push', cmd: 'git push origin feature:main' },
  { group: 'push', cmd: 'git push origin +main' },
  { group: 'push', cmd: 'git push origin :main' },
  { group: 'push', cmd: 'git push origin HEAD:refs/heads/main' },
  { group: 'push', cmd: 'git push origin feature main' },
  { group: 'push', cmd: 'git push -u origin main' },
  { group: 'push', cmd: 'git push -f origin main' },
  { group: 'push', cmd: 'git push origin main --force' },
  { group: 'push', cmd: 'git push --force-with-lease origin main' },
  { group: 'push', cmd: 'git push --force-with-lease=main:abc123 origin HEAD:main' },
  { group: 'push', cmd: 'git push --dry-run origin HEAD:main' },
  { group: 'push', cmd: 'git push --repo=origin main' },
  { group: 'push', cmd: 'git push --all origin' },
  { group: 'push', cmd: 'git push --mirror origin' },
  { group: 'push', cmd: "git push origin 'refs/heads/*:refs/heads/*'" },
  { group: 'push', cmd: 'git push origin $BRANCH' },
  { group: 'push', cmd: 'git -C ../other push origin main' },
  { group: 'push', cmd: 'git -c push.default=current push origin main' },
  { group: 'push', cmd: 'GIT_TRACE=1 git push origin main' },
  { group: 'push', cmd: 'env GIT_TRACE=1 git push origin main' },
  { group: 'push', cmd: '/usr/bin/git push origin main' },
  { group: 'push', cmd: '"C:\\Program Files\\Git\\cmd\\git.exe" push origin main' },
  { group: 'push', cmd: 'git push origin main', tool: 'PowerShell' },
  // git push with no refspec while main is checked out / tracked
  { group: 'push (current branch)', cmd: 'git push', cwd: onMain },
  { group: 'push (current branch)', cmd: 'git push origin', cwd: onMain },
  { group: 'push (current branch)', cmd: 'git push -u origin HEAD', cwd: onMain },
  { group: 'push (current branch)', cmd: 'git push --force', cwd: onMain },
  { group: 'push (current branch)', cmd: 'git push origin $(git branch --show-current)', cwd: onMain },
  { group: 'push (current branch)', cmd: 'git push', cwd: tracksMain },
  { group: 'push (current branch)', cmd: `cd "${onMain}" && git push` },
  { group: 'push (current branch)', cmd: `git -C "${onMain}" push` },
  { group: 'push (current branch)', cmd: `Set-Location "${onMain}"; git push`, tool: 'PowerShell' },
  // PlatformIO
  { group: 'pio', cmd: 'pio run -t upload' },
  { group: 'pio', cmd: 'pio run --target upload' },
  { group: 'pio', cmd: 'pio run --target=upload' },
  { group: 'pio', cmd: 'pio run -tupload' },
  { group: 'pio', cmd: 'pio run -t uploadfs -e esp32dev' },
  { group: 'pio', cmd: 'platformio run -e esp32dev --target program' },
  { group: 'pio', cmd: 'pio run -e esp32dev --upload-port COM3 -t upload' },
  { group: 'pio', cmd: 'pio run -t clean -t upload' },
  { group: 'pio', cmd: 'pio remote run -t upload' },
  { group: 'pio', cmd: 'python -m platformio run -t upload' },
  { group: 'pio', cmd: '"C:\\Users\\me\\.platformio\\penv\\Scripts\\pio.exe" run -t upload' },
  { group: 'pio', cmd: 'pio run -t upload', tool: 'PowerShell' },
  // esptool, idf.py, arduino-cli
  { group: 'esptool', cmd: 'esptool.py --port COM3 write_flash 0x0 firmware.bin' },
  { group: 'esptool', cmd: 'esptool --chip esp32 erase_flash' },
  { group: 'esptool', cmd: 'python -m esptool chip_id' },
  { group: 'esptool', cmd: 'python3 esptool.py read_mac' },
  { group: 'idf.py', cmd: 'idf.py flash' },
  { group: 'idf.py', cmd: 'idf.py -p COM3 flash monitor' },
  { group: 'idf.py', cmd: 'idf.py app-flash' },
  { group: 'arduino-cli', cmd: 'arduino-cli upload -p COM3 --fqbn esp32:esp32:esp32 sketch' },
  { group: 'arduino-cli', cmd: 'arduino-cli compile --upload -p COM3 --fqbn esp32:esp32:esp32 sketch' },
  { group: 'arduino-cli', cmd: 'arduino-cli compile -u -p COM3 -b esp32:esp32:esp32 sketch' },
  // combined commands: every part is checked
  { group: 'combined', cmd: 'git status && git push origin main' },
  { group: 'combined', cmd: 'git fetch || git push origin main' },
  { group: 'combined', cmd: 'echo building; pio run -t upload' },
  { group: 'combined', cmd: 'echo y | esptool.py erase_flash' },
  { group: 'combined', cmd: 'pio run && pio run -t upload 2>&1 | tee log.txt' },
  { group: 'combined', cmd: 'git add -A\ngit commit -m wip\ngit push origin main' },
  { group: 'combined', cmd: 'echo $(git push origin main)' },
  { group: 'combined', cmd: 'echo "result: `idf.py flash`"' },
  { group: 'combined', cmd: 'if true; then git push origin main; fi' },
  { group: 'combined', cmd: 'git status; if ($?) { git push origin main }', tool: 'PowerShell' },
  // wrapped commands
  { group: 'wrapped', cmd: 'bash -c "git push origin main"' },
  { group: 'wrapped', cmd: "sh -c 'pio run -t upload'" },
  { group: 'wrapped', cmd: 'bash -lc "cd firmware && idf.py flash"' },
  { group: 'wrapped', cmd: 'bash -c "sh -c \'git push origin HEAD:main\'"' },
  { group: 'wrapped', cmd: 'cmd /c git push origin main' },
  { group: 'wrapped', cmd: 'cmd /c "pio run -t upload"' },
  { group: 'wrapped', cmd: 'cmd.exe /C "echo ok & arduino-cli upload -p COM3"' },
  { group: 'wrapped', cmd: 'powershell -Command "git push origin main"' },
  { group: 'wrapped', cmd: "powershell -NoProfile -Command \"& 'C:\\tools\\pio.exe' run -t upload\"" },
  { group: 'wrapped', cmd: 'pwsh -c "arduino-cli upload -p COM3"' },
  { group: 'wrapped', cmd: 'pwsh -NoProfile -c "git status; git push origin main"' },
  { group: 'wrapped', cmd: `pwsh -EncodedCommand ${encoded('git push origin main')}` },
  { group: 'wrapped', cmd: 'Invoke-Expression "git push origin main"', tool: 'PowerShell' },
  { group: 'wrapped', cmd: 'Start-Process pio -ArgumentList "run -t upload"', tool: 'PowerShell' },
  { group: 'wrapped', cmd: 'eval "esptool.py erase_flash"' },
  { group: 'wrapped', cmd: 'sudo -u builder git push origin main' },
  // risky and unparseable
  { group: 'unparseable', cmd: 'git push origin "main' },
  { group: 'unparseable', cmd: "pio run -t 'upload" },
  { group: 'unparseable', cmd: 'echo "$(esptool.py chip_id"' },
  // computed values next to a definite target
  { group: 'computed', cmd: 'git push origin $BRANCH main', reason: /updates main/ },
  { group: 'computed', cmd: 'pio run -t $TARGET -t upload', reason: /target "upload"/ },
  { group: 'computed', cmd: 'git status; if ($?) { git push origin main }', tool: 'PowerShell', reason: /updates main/ },
];

const ALLOW = [
  { group: 'push', cmd: 'git push origin agent/claude/guard-hook' },
  { group: 'push', cmd: 'git push -u origin feature' },
  { group: 'push', cmd: 'git push --force-with-lease origin agent/claude/x' },
  { group: 'push', cmd: 'git push origin main:feature' },
  { group: 'push', cmd: 'git push origin mainline' },
  { group: 'push', cmd: 'git push origin --delete old-branch' },
  { group: 'push', cmd: 'git push' },
  { group: 'push', cmd: 'git push origin HEAD' },
  { group: 'push', cmd: 'git push -u origin $(git branch --show-current)' },
  { group: 'push', cmd: `cd "${onMain}" && cd "${onFeature}" && git push` },
  { group: 'push', cmd: 'git push origin feature', tool: 'PowerShell' },
  { group: 'other git', cmd: 'git pull origin main' },
  { group: 'other git', cmd: 'git fetch origin main' },
  { group: 'other git', cmd: 'git checkout main && git merge --ff-only origin/main' },
  { group: 'other git', cmd: 'git diff main...HEAD --stat' },
  { group: 'other git', cmd: 'git commit -m "fix push to main and flash docs"' },
  { group: 'build', cmd: 'pio run' },
  { group: 'build', cmd: 'pio run -t clean' },
  { group: 'build', cmd: 'pio run -e esp32dev -t size' },
  { group: 'build', cmd: 'pio device monitor -b 115200' },
  { group: 'build', cmd: 'idf.py build' },
  { group: 'build', cmd: 'arduino-cli compile --fqbn esp32:esp32:esp32 sketch' },
  { group: 'text', cmd: 'echo "git push origin main"' },
  { group: 'text', cmd: 'grep -rn "upload" src/ | head -20' },
  { group: 'text', cmd: 'ls "unterminated' },
  { group: 'wrapped', cmd: 'bash -c "pio run -t clean"' },
  { group: 'wrapped', cmd: 'cmd /c "git status && git log --oneline -5"' },
  { group: 'wrapped', cmd: 'pwsh -c "git push origin agent/claude/x"' },
  { group: 'misc', cmd: 'node .claude/hooks/guard.test.js 2>&1' },
];

// --------------------------------------------------------------------- run

function run({ cmd, tool = 'Bash', cwd = onFeature }) {
  const input = {
    session_id: 'guard-test',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command: cmd },
    cwd,
  };
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: res.status, stderr: (res.stderr || '').trim() };
}

const oneLine = (s) => s.replace(/\r?\n/g, '\\n').split(tmp).join('<tmp>');

let passed = 0;
let failed = 0;
function report(ok, label, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`      ${detail.split('\n').join('\n      ')}`);
}

try {
  for (const [title, cases, want] of [['MUST BLOCK', BLOCK, 2], ['MUST ALLOW', ALLOW, 0]]) {
    console.log(`\n== ${title} (${cases.length}) ==`);
    for (const c of cases) {
      const r = run(c);
      const where = [c.tool === 'PowerShell' ? 'PowerShell' : '', c.cwd === onMain ? 'on main'
        : c.cwd === tracksMain ? 'tracks origin/main' : ''].filter(Boolean).join(', ');
      const label = `[${c.group}] ${oneLine(c.cmd)}${where ? `  (${where})` : ''}`;
      // Optional `reason`: the block message must give this specific reason.
      const ok = r.status === want && (!c.reason || c.reason.test(r.stderr));
      report(ok, label, ok ? '' : `exit ${r.status}, expected ${want}\n${r.stderr}`);
    }
  }

  console.log('\n== CONFIG ==');
  const settingsPath = path.join(__dirname, '..', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const entries = (settings.hooks && settings.hooks.PreToolUse) || [];
    const entry = entries.find((e) => (e.hooks || []).some((h) => (h.args || []).some((a) => /guard\.js$/.test(a))));
    const matcher = entry ? new RegExp(`^(?:${entry.matcher})$`) : null;
    report(Boolean(matcher && matcher.test('Bash') && matcher.test('PowerShell')),
      'settings.json registers guard.js for Bash and PowerShell');
    const hook = entry && entry.hooks.find((h) => (h.args || []).some((a) => /guard\.js$/.test(a)));
    report(Boolean(hook && hook.onFailure === 'block'), 'guard hook fails closed (onFailure: "block")');
    const deny = (settings.permissions && settings.permissions.deny) || [];
    report(deny.includes('Bash(git push origin main:*)') && deny.includes('Bash(esptool:*)'),
      'existing deny rules are kept');
  } else {
    console.log('SKIP  settings.json not found next to hooks/');
  }
  const templateGuard = path.join(__dirname, '..', '..', 'templates', '.claude', 'hooks', 'guard.js');
  if (fs.existsSync(templateGuard)) {
    report(fs.readFileSync(templateGuard, 'utf8') === fs.readFileSync(GUARD, 'utf8'),
      'templates/.claude/hooks/guard.js matches .claude/hooks/guard.js');
  }

  const blockCount = BLOCK.length;
  const allowCount = ALLOW.length;
  console.log(`\n${passed} passed, ${failed} failed (${blockCount} must-block, ${allowCount} must-allow, plus config checks)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

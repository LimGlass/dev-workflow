#!/usr/bin/env node
// PreToolUse guard for the Bash and PowerShell tools (ADR-0001, review ADR-0001-setup-r1 #1).
//
// Blocks (exit code 2, reason on stderr):
//   - any `git push` that would update `main`: any remote, any refspec form
//     (main, HEAD:main, +main, :main, refs/heads/main, wildcards), any flags,
//     --all / --mirror, and a push with no refspec (or HEAD) while main is
//     checked out or the current branch's push target is <remote>/main
//   - PlatformIO uploads: pio / platformio with -t / --target / --target= set to
//     upload, uploadfs or program, in any argument order
//   - esptool (any invocation), idf.py flash (and *-flash targets),
//     arduino-cli upload and arduino-cli compile --upload / -u
//
// Every part of a combined command is checked (&&, ||, ;, |, &, newlines,
// $(...), backticks), as are commands wrapped in bash/sh -c, cmd /c,
// powershell/pwsh -Command / -EncodedCommand, eval and Invoke-Expression.
// A command that cannot be parsed confidently is blocked only when it mentions
// push, upload, uploadfs, flash or esptool; everything else is allowed and goes
// through the normal permission rules.
//
// This catches mistakes; it is not a sandbox. Scripts, aliases and git aliases
// are not inspected. The deny rules in settings.json remain a second layer.

'use strict';

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const RISKY = /push|upload|uploadfs|flash|esptool/i;
const MAX_DEPTH = 8;

// Placeholders left in a word where a command substitution was.
const SUB = '\u0000SUB\u0000'; // unknown value
const CUR = '\u0000CUR\u0000'; // $(git branch --show-current) and equivalents
const TOP = '\u0000TOP\u0000'; // $(git rev-parse --show-toplevel)
const CURRENT_BRANCH_RE =
  /^git\s+(branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+--short\s+(-q\s+)?HEAD)$/;
const TOPLEVEL_RE = /^git\s+rev-parse\s+--show-toplevel$/;

const PIO_TARGETS = new Set(['upload', 'uploadfs', 'program']);

class ParseError extends Error {}

// ---------------------------------------------------------------- tokenizer

function marker(inner) {
  const s = inner.trim();
  if (CURRENT_BRANCH_RE.test(s)) return CUR;
  if (TOPLEVEL_RE.test(s)) return TOP;
  return SUB;
}

function matchParen(src, open) {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, j + 1);
      if (end < 0) throw new ParseError('unterminated quote inside $( )');
      j = end;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  throw new ParseError('unterminated $( )');
}

// Splits a command line into simple commands (arrays of words).
// dialect: 'bash' | 'ps' (PowerShell) | 'cmd'.
// Returns { segments, subs } where subs are command substitutions to check too.
function tokenize(src, dialect) {
  const segments = [];
  const subs = [];
  let words = [];
  let cur = '';
  let inWord = false;
  let dropNext = false; // next word is a redirection target

  const flushWord = () => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else words.push(cur);
    }
    cur = '';
    inWord = false;
  };
  const endSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Escape characters.
    const esc = dialect === 'bash' ? '\\' : dialect === 'ps' ? '`' : '^';
    if (c === esc) {
      if (next === '\n') { i += 2; continue; }
      if (next === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      if (next !== undefined) { cur += next; inWord = true; }
      i += 2;
      continue;
    }

    if (c === "'" && dialect !== 'cmd') {
      let j = i + 1;
      let buf = '';
      for (;;) {
        if (j >= n) throw new ParseError('unterminated single quote');
        if (src[j] === "'") {
          if (dialect === 'ps' && src[j + 1] === "'") { buf += "'"; j += 2; continue; }
          break;
        }
        buf += src[j++];
      }
      cur += buf;
      inWord = true;
      i = j + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let buf = '';
      for (;;) {
        if (j >= n) throw new ParseError('unterminated double quote');
        const d = src[j];
        if (d === '"') {
          if (dialect === 'ps' && src[j + 1] === '"') { buf += '"'; j += 2; continue; }
          break;
        }
        if (dialect === 'bash' && d === '\\' && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== '\n') buf += src[j + 1];
          j += 2;
          continue;
        }
        if (dialect === 'ps' && d === '`' && j + 1 < n) { buf += src[j + 1]; j += 2; continue; }
        if (dialect !== 'cmd' && d === '$' && src[j + 1] === '(') {
          const end = matchParen(src, j + 1);
          const inner = src.slice(j + 2, end);
          subs.push(inner);
          buf += marker(inner);
          j = end + 1;
          continue;
        }
        if (dialect === 'bash' && d === '`') {
          const end = src.indexOf('`', j + 1);
          if (end < 0) throw new ParseError('unterminated backtick');
          const inner = src.slice(j + 1, end);
          subs.push(inner);
          buf += marker(inner);
          j = end + 1;
          continue;
        }
        buf += d;
        j++;
      }
      cur += buf;
      inWord = true;
      i = j + 1;
      continue;
    }

    if (dialect === 'bash' && c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new ParseError('unterminated backtick');
      const inner = src.slice(i + 1, end);
      subs.push(inner);
      cur += marker(inner);
      inWord = true;
      i = end + 1;
      continue;
    }

    if (dialect !== 'cmd' && c === '$' && next === '(') {
      const end = matchParen(src, i + 1);
      const inner = src.slice(i + 2, end);
      subs.push(inner);
      cur += marker(inner);
      inWord = true;
      i = end + 1;
      continue;
    }

    if (c === '#' && !inWord && dialect !== 'cmd') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') { flushWord(); i++; continue; }
    if (c === '\n' || c === ';') { endSegment(); i++; continue; }

    if (c === '&') {
      if (next === '>') {
        // &> file, &>> file
        flushWord();
        i += 2;
        if (src[i] === '>') i++;
        dropNext = true;
        continue;
      }
      endSegment();
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (c === '|') {
      endSegment();
      i += next === '|' || next === '&' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') { endSegment(); i++; continue; }

    if (c === '>' || c === '<') {
      // Drop a leading file descriptor (2>, *>) and the redirection target.
      if (inWord && /^(\d+|\*)$/.test(cur)) { cur = ''; inWord = false; } else flushWord();
      i++;
      while (src[i] === '>' || src[i] === '<' || src[i] === '|') i++;
      if (src[i] === '&' && /[0-9-]/.test(src[i + 1] || '')) {
        i++;
        while (/[0-9-]/.test(src[i] || '')) i++;
        continue; // 2>&1 has no separate target
      }
      if (src[i] === '&') i++;
      dropNext = true;
      continue;
    }

    cur += c;
    inWord = true;
    i++;
  }
  endSegment();
  return { segments, subs };
}

// ------------------------------------------------------------------ helpers

function normName(word) {
  const base = word.split(/[\\/]/).pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

function isDynamic(word) {
  return /[$`%]/.test(word) || word.includes(SUB);
}

function show(text) {
  return text.split(SUB).join('$(...)').split(CUR).join('$(current branch)').split(TOP).join('$(repo root)');
}

function requote(t) {
  return /\s/.test(t) ? `"${t}"` : t;
}

function fromMsys(p) {
  // Git Bash style /c/dev/x -> C:\dev\x
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(p)) {
    return `${p[1].toUpperCase()}:\\${p.slice(3)}`;
  }
  return p;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function resolveDir(base, p) {
  if (base === null || p === undefined) return null;
  if (p === TOP) return git(base, ['rev-parse', '--show-toplevel']);
  if (isDynamic(p) || p.includes(CUR)) return null;
  let s = p;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(base, fromMsys(s));
}

// Uncertain about a guarded command: block only if the command looks risky.
// The verdict is "soft": analysis keeps going so a definite reason found later
// in the same command is reported instead.
function unsure(ctx, reason) {
  return RISKY.test(ctx.src) ? { reason: `${reason}, so it cannot be checked`, soft: true } : null;
}

// --------------------------------------------------------------- analysis

function analyze(src, ctx, depth) {
  const local = { ...ctx };
  if (depth > MAX_DEPTH) {
    return RISKY.test(src) ? { reason: 'command is nested too deeply to check', where: src } : null;
  }
  let parsed;
  try {
    parsed = tokenize(src, local.dialect);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return RISKY.test(src)
      ? { reason: `could not parse a command that mentions push/upload/flash/esptool (${e.message})`, where: src }
      : null;
  }
  let soft = null;
  const results = [
    ...parsed.subs.map((sub) => () =>
      analyze(sub, { ...local, dialect: local.dialect === 'ps' ? 'ps' : 'bash' }, depth + 1)),
    ...parsed.segments.map((words) => () => checkSegment(words, local, depth)),
  ];
  for (const next of results) {
    const r = next();
    if (!r) continue;
    if (!r.soft) return r;
    soft = soft || r;
  }
  return soft;
}

const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);

const WRAPPERS = {
  sudo: { val: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--prompt'] },
  doas: { val: ['-u', '-C'] },
  env: { val: ['-u', '--unset', '-C', '--chdir'], assign: true, uncertainOn: ['-S', '--split-string'] },
  nice: { val: ['-n', '--adjustment'] },
  ionice: { val: ['-c', '-n', '-p', '--class', '--classdata'] },
  timeout: { val: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  xargs: {
    val: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-lines', '--max-procs',
      '--delimiter', '--arg-file', '--replace', '--eof'],
    uncertain: true,
  },
  nohup: {},
  time: {},
  command: {},
  builtin: {},
  exec: { val: ['-a'] },
  winpty: {},
  call: {},
  stdbuf: {},
  unbuffer: {},
};

function stripWrappers(words) {
  const w = words.slice();
  let uncertain = false;
  while (w.length) {
    const first = w[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first)) { w.shift(); continue; }
    const name = normName(first);
    if (KEYWORDS.has(name)) { w.shift(); continue; }
    const spec = WRAPPERS[name];
    if (!spec) break;
    w.shift();
    if (spec.uncertain) uncertain = true;
    let positional = spec.positional || 0;
    while (w.length) {
      const a = w[0];
      if (a === '--') { w.shift(); break; }
      if (spec.uncertainOn && spec.uncertainOn.includes(a)) { uncertain = true; w.splice(0, 2); continue; }
      if (spec.val && spec.val.includes(a)) { w.splice(0, 2); continue; }
      if (a.startsWith('-') && a.length > 1) { w.shift(); continue; }
      if (spec.assign && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { w.shift(); continue; }
      if (positional > 0) { positional--; w.shift(); continue; }
      break;
    }
  }
  while (w.length && w[w.length - 1] === '}') w.pop();
  return { words: w, uncertain };
}

function checkSegment(words, ctx, depth) {
  const { words: w, uncertain } = stripWrappers(words);
  if (!w.length) return null;
  const where = show(words.join(' '));
  const r = isDynamic(w[0])
    ? unsure(ctx, 'the command name is computed at run time')
    : checkCommand(normName(w[0]), w.slice(1), ctx, depth, uncertain);
  if (!r) return null;
  if (typeof r === 'string') return { reason: r, where };
  return r.where ? r : { ...r, where };
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish']);
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const PYTHON_RE = /^(python(\d+(\.\d+)*)?w?|py)$/;

function checkCommand(name, args, ctx, depth, uncertain) {
  if (CD.has(name)) return changeDir(args, ctx);
  if (name === 'popd' || name === 'pop-location') { ctx.cwd = null; return null; }
  if (SHELLS.has(name)) return checkShell(args, ctx, depth);
  if (name === 'cmd') return checkCmd(args, ctx, depth);
  if (name === 'powershell' || name === 'pwsh') return checkPowerShell(args, ctx, depth);
  if (name === 'iex' || name === 'invoke-expression') {
    return analyzeJoined(args.filter((a) => !/^-command$/i.test(a)), { ...ctx, dialect: 'ps' }, depth);
  }
  if (name === 'eval') return analyzeJoined(args, { ...ctx, dialect: 'bash' }, depth);
  if (name === 'start-process' || name === 'saps' || name === 'start') return checkStart(args, ctx, depth);
  if (name === 'git') return checkGit(args, ctx, uncertain);
  if (name === 'pio' || name === 'platformio') return checkPio(args, ctx, uncertain);
  if (name === 'esptool' || name === 'esptool.py') return 'esptool writes to the chip';
  if (name === 'idf.py' || name === 'idf') return checkIdf(args, ctx, uncertain);
  if (name === 'arduino-cli') return checkArduino(args, ctx, uncertain);
  if (PYTHON_RE.test(name)) return checkPython(args, ctx, depth, uncertain);
  return null;
}

// Check tokens re-joined into one command string, both as-is and with
// space-containing tokens re-quoted (cmd /c "a b" vs. cmd /c "C:\Program Files\x" y).
function analyzeJoined(tokens, ctx, depth) {
  if (!tokens.length) return null;
  return firstHard([
    () => analyze(tokens.join(' '), ctx, depth + 1),
    () => analyze(tokens.map(requote).join(' '), ctx, depth + 1),
  ]);
}

// Run checks in order; return the first definite block, else the first soft one.
function firstHard(checks) {
  let soft = null;
  for (const check of checks) {
    const r = check();
    if (r && !r.soft) return r;
    soft = soft || r;
  }
  return soft;
}

function changeDir(args, ctx) {
  let target;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const l = a.toLowerCase();
    if (l === '-path' || l === '-literalpath' || l === '-stackname') { if (l !== '-stackname') target = args[i + 1]; i++; continue; }
    if (/^-[a-z@]+$/i.test(a) || /^\/d$/i.test(a)) continue;
    if (target === undefined) target = a;
  }
  if (target === undefined) ctx.cwd = os.homedir();
  else if (target === '-') ctx.cwd = null;
  else ctx.cwd = resolveDir(ctx.cwd, target);
  return null;
}

function checkShell(args, ctx, depth) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(a)) { i++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
      const script = args[i + 1];
      return script === undefined ? null : analyze(script, { ...ctx, dialect: 'bash' }, depth + 1);
    }
    if (a.startsWith('-') || a.startsWith('+')) continue;
    return null; // runs a script file; not inspected
  }
  return null;
}

function checkCmd(args, ctx, depth) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\/[ck]$/i.test(a)) return analyzeJoined(args.slice(i + 1), { ...ctx, dialect: 'cmd' }, depth);
    if (/^\/[ck]/i.test(a)) return analyzeJoined([a.slice(2), ...args.slice(i + 1)], { ...ctx, dialect: 'cmd' }, depth);
  }
  return null;
}

const PS_VALUE_OPTS = ['-executionpolicy', '-workingdirectory', '-configurationname', '-outputformat',
  '-inputformat', '-windowstyle', '-psconsolefile', '-version', '-settingsfile', '-custompipename'];
const PS_VALUE_SHORT = ['-ep', '-ex', '-wd', '-of', '-if', '-w', '-v', '-o'];

function checkPowerShell(args, ctx, depth) {
  const ps = { ...ctx, dialect: 'ps' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const l = a.toLowerCase();
    if (l === '-ec' || (l.length >= 2 && '-encodedcommand'.startsWith(l))) {
      const b64 = args[i + 1];
      if (!b64) return null;
      if (isDynamic(b64)) return unsure(ctx, 'the encoded command is computed at run time');
      return analyze(Buffer.from(b64, 'base64').toString('utf16le'), ps, depth + 1);
    }
    if (l === '-cwa' || (l.length >= 9 && '-commandwithargs'.startsWith(l))) {
      return args[i + 1] === undefined ? null : analyze(args[i + 1], ps, depth + 1);
    }
    if (l.length >= 2 && '-command'.startsWith(l)) return analyzeJoined(args.slice(i + 1), ps, depth);
    if (l.length >= 2 && '-file'.startsWith(l)) return null; // script file; not inspected
    if (PS_VALUE_SHORT.includes(l) || (l.length >= 4 && PS_VALUE_OPTS.some((o) => o.startsWith(l)))) { i++; continue; }
    if (a.startsWith('-')) continue;
    return analyzeJoined(args.slice(i), ps, depth); // positional command text
  }
  return null;
}

function checkStart(args, ctx, depth) {
  let file;
  const argList = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const l = a.toLowerCase();
    if (l === '-filepath') { file = args[++i]; continue; }
    if (l === '-argumentlist' || l === '-args') { argList.push((args[++i] || '').replace(/,/g, ' ')); continue; }
    if (['-workingdirectory', '-verb', '-windowstyle', '-redirectstandardoutput', '-redirectstandarderror',
      '-redirectstandardinput', '-credential', '/d'].includes(l)) { i++; continue; }
    if (/^-[a-z]+$/i.test(a) || /^\/[a-z]+$/i.test(a) || a === '') continue;
    rest.push(a);
  }
  const candidates = [];
  if (file !== undefined) candidates.push([file, ...rest]);
  else if (rest.length) {
    candidates.push(rest);
    if (rest.length > 1) candidates.push(rest.slice(1)); // cmd: start "title" program ...
  }
  const dialect = ctx.dialect === 'ps' ? 'ps' : 'bash';
  return firstHard(candidates.map((c) => () =>
    analyze([requote(c[0]), ...c.slice(1).map(requote), ...argList].join(' '), { ...ctx, dialect }, depth + 1)));
}

function checkPython(args, ctx, depth, uncertain) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || (a.startsWith('-m') && a.length > 2)) {
      const mod = (a === '-m' ? args[i + 1] || '' : a.slice(2)).toLowerCase().split('.')[0];
      const rest = args.slice(a === '-m' ? i + 2 : i + 1);
      if (mod === 'esptool' || mod === 'platformio') return checkCommand(mod, rest, ctx, depth, uncertain);
      return null;
    }
    if (a === '-c') {
      return RISKY.test(args[i + 1] || '') ? 'python -c code mentions push/upload/flash/esptool and cannot be checked' : null;
    }
    if (['-W', '-X', '-Q'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return checkCommand(normName(a), args.slice(i + 1), ctx, depth, uncertain); // python esptool.py ...
  }
  return null;
}

// ---------------------------------------------------------------- git push

const GIT_VALUE_OPTS = ['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'];

function checkGit(args, ctx, uncertain) {
  const opts = [];
  let cwd = ctx.cwd;
  let unknownLocation = cwd === null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-C') {
      const dir = resolveDir(cwd, args[++i]);
      if (dir === null) unknownLocation = true;
      else cwd = dir;
      continue;
    }
    if (GIT_VALUE_OPTS.includes(a)) {
      const v = args[++i] || '';
      if (isDynamic(v)) unknownLocation = true;
      opts.push(a, v);
      continue;
    }
    if (a.startsWith('-')) { opts.push(a); continue; }
    break;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  if (isDynamic(sub)) return unsure(ctx, 'the git subcommand is computed at run time');
  if (sub.toLowerCase() !== 'push') return null;
  return checkPush(args.slice(i + 1), { ctx, cwd, opts, unknownLocation, uncertain });
}

function checkPush(pargs, q) {
  const positional = [];
  let repoOption = false;
  let pushesAll = false;
  let endOfOptions = false;
  for (let i = 0; i < pargs.length; i++) {
    const a = pargs[i];
    if (!endOfOptions && a === '--') { endOfOptions = true; continue; }
    if (!endOfOptions && a.startsWith('-') && a.length > 1) {
      if (a === '--repo') { repoOption = true; i++; continue; }
      if (a.startsWith('--repo=')) { repoOption = true; continue; }
      if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) { i++; continue; }
      if (['--all', '--mirror', '--branches'].includes(a)) pushesAll = true;
      continue;
    }
    positional.push(a);
  }

  if (pushesAll) return 'git push --all/--mirror would update main';
  if (q.uncertain) return unsure(q.ctx, 'git push receives arguments at run time (xargs)');

  const refspecs = repoOption ? positional : positional.slice(1);
  let needsCurrentBranch = refspecs.length === 0;
  let dynamicRefspec = null;
  for (const r of refspecs) {
    if (r.startsWith('^')) continue; // negative refspec
    const s = r.replace(/^\+/, '');
    const colon = s.lastIndexOf(':');
    let dst = colon >= 0 ? s.slice(colon + 1) : s;
    if (dst === CUR || dst === 'HEAD' || dst === '@') { needsCurrentBranch = true; continue; }
    if (isDynamic(dst)) { dynamicRefspec = dynamicRefspec || r; continue; }
    dst = dst.replace(/^refs\/heads\//i, '');
    if (dst.includes('*')) return `refspec "${r}" is a wildcard that can update main`;
    if (dst.toLowerCase() === 'main') return `this push updates main (refspec "${r}")`;
  }

  if (needsCurrentBranch) {
    if (q.unknownLocation) return unsure(q.ctx, 'the repository directory is computed at run time');
    const branch = git(q.cwd, [...q.opts, 'symbolic-ref', '--short', '-q', 'HEAD']);
    if (branch === 'main') return 'main is checked out, so this push would update main';
    if (refspecs.length === 0) {
      const target = git(q.cwd, [...q.opts, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
      if (target && /\/main$/.test(target)) return `the current branch pushes to ${target}`;
    }
  }
  if (dynamicRefspec) return unsure(q.ctx, `the push target "${show(dynamicRefspec)}" is computed at run time`);
  return null;
}

// ------------------------------------------------------- firmware uploads

function checkPio(args, ctx, uncertain) {
  if (uncertain) return unsure(ctx, 'pio receives arguments at run time (xargs)');
  let dynamic = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    if (a === '-t' || a === '--target') v = args[i + 1] || '';
    else if (a.startsWith('--target=')) v = a.slice('--target='.length);
    else if (/^-t./.test(a)) v = a.slice(2).replace(/^=/, '');
    if (v === null) continue;
    if (isDynamic(v)) { dynamic = true; continue; }
    for (const t of v.split(',')) {
      if (PIO_TARGETS.has(t.trim().toLowerCase())) return `PlatformIO target "${t.trim()}" writes to a board`;
    }
  }
  return dynamic ? unsure(ctx, 'the PlatformIO target is computed at run time') : null;
}

function checkIdf(args, ctx, uncertain) {
  if (uncertain) return unsure(ctx, 'idf.py receives arguments at run time (xargs)');
  for (const a of args) {
    const l = a.toLowerCase();
    if (l === 'flash' || l.endsWith('-flash')) return `idf.py ${a} writes to the chip`;
  }
  return args.some(isDynamic) ? unsure(ctx, 'an idf.py argument is computed at run time') : null;
}

function checkArduino(args, ctx, uncertain) {
  const lower = args.map((a) => a.toLowerCase());
  if (lower.includes('upload')) return 'arduino-cli upload writes to a board';
  if (lower.includes('compile')) {
    const uploads = args.some((a) =>
      /^--upload(=(1|t|true))?$/i.test(a) || (/^-[A-Za-z]+$/.test(a) && a.includes('u')));
    if (uploads) return 'arduino-cli compile --upload writes to a board';
  }
  if (uncertain) return unsure(ctx, 'arduino-cli receives arguments at run time (xargs)');
  return args.some(isDynamic) ? unsure(ctx, 'an arduino-cli argument is computed at run time') : null;
}

// --------------------------------------------------------------------- main

function check(input) {
  const command = input && input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || !command.trim()) return null;
  const dialect = input.tool_name === 'PowerShell' ? 'ps' : 'bash';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return analyze(command, { dialect, cwd, src: command }, 0);
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.stderr.write('BLOCKED by .claude/hooks/guard.js: hook input was not valid JSON.\n');
      process.exit(2);
    }
    const r = check(input);
    if (!r) process.exit(0);
    process.stderr.write([
      `BLOCKED by .claude/hooks/guard.js: ${r.reason}.`,
      `  Command: ${show(r.where)}`,
      'Policy (ADR-0001): agents never push to main or write firmware to a board.',
      'Push to an agent/* branch and open a PR; ask the human owner to run uploads and flashing.',
      '',
    ].join('\n'));
    process.exit(2);
  });
}

if (require.main === module) main();
module.exports = { check, tokenize };

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
// Text sent to a command's stdin is checked too: heredocs (<<, <<-), here-strings
// (<<<), and piped literals (echo, printf, PowerShell strings and Write-Output,
// passed on through cat/tee). Where it goes decides what happens:
//   - text-only consumers (cat, tee, gh ... --body-file -, git commit -F -):
//     not checked, so quoted heredoc bodies may mention anything
//   - shells (bash, sh, ..., pwsh, cmd): checked as a script
//   - anything else (python, node, perl, ruby, unknown programs, groups):
//     blocked when it mentions push/upload/flash/esptool
// $(...) and backticks in unquoted heredocs are always checked.
//
// This catches mistakes; it is not a sandbox. Scripts, aliases and git aliases
// are not inspected, nor is stdin whose content is not known in advance
// (cat file | bash, bash < file, curl ... | bash) or text that hides the words
// above. The deny rules in settings.json remain a second layer.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
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

// Unquoted heredoc body: $(...) and backticks still run, so pull them out as
// substitutions; \$, \` and \\ are escapes. Returns the body text with markers.
function scanHeredocBody(body, subs) {
  let text = '';
  for (let j = 0; j < body.length;) {
    const d = body[j];
    if (d === '\\' && '$`\\'.includes(body[j + 1] || '')) { text += body[j + 1]; j += 2; continue; }
    if (d === '$' && body[j + 1] === '(') {
      const end = matchParen(body, j + 1);
      const inner = body.slice(j + 2, end);
      subs.push(inner);
      text += marker(inner);
      j = end + 1;
      continue;
    }
    if (d === '`') {
      const end = body.indexOf('`', j + 1);
      if (end < 0) throw new ParseError('unterminated backtick in heredoc');
      const inner = body.slice(j + 1, end);
      subs.push(inner);
      text += marker(inner);
      j = end + 1;
      continue;
    }
    text += d;
    j++;
  }
  return text;
}

// Splits a command line into simple commands (arrays of words).
// dialect: 'bash' | 'ps' (PowerShell) | 'cmd'.
// Returns { segments, subs, metas } where subs are command substitutions to
// check too, and metas[k] describes segments[k]'s stdin:
//   stdin:  text fed by heredocs (<<) and here-strings (<<<), as { kind, text, quoted }
//   pipeIn: true when the previous segment's output is piped into this one
//   pipeFromGroup: the pipe comes straight after a ( ... ) group
//   firstQuoted: the command word was quoted (in PowerShell that makes it a string value)
// A segment with no words is kept when a heredoc or here-string is redirected
// into it, e.g. (bash) <<'EOF', so that text is still checked.
function tokenize(src, dialect) {
  const segments = [];
  const subs = [];
  const metas = [];
  const newMeta = () => ({ stdin: [], pipeIn: false, pipeFromGroup: false, firstQuoted: false });
  let words = [];
  let meta = newMeta();
  let cur = '';
  let inWord = false;
  let wordQuoted = false;
  let dropNext = false; // next word is a redirection target
  let capture = null; // next word is a here-string for this segment's meta
  let pipeNext = false; // the next segment reads the previous one's output
  let groupNext = false; // ... and that output comes from a ( ... ) group
  let parenClosed = false; // the last token was )
  const heredocs = []; // heredocs whose bodies start after the next newline

  const flushWord = () => {
    if (inWord) {
      if (capture) {
        capture.stdin.push({ kind: 'here-string', text: cur, quoted: wordQuoted });
        capture = null;
      } else if (dropNext) {
        dropNext = false;
      } else {
        if (!words.length) meta.firstQuoted = wordQuoted;
        words.push(cur);
      }
    }
    cur = '';
    inWord = false;
    wordQuoted = false;
  };
  const endSegment = () => {
    flushWord();
    capture = null;
    if (words.length || meta.stdin.length || heredocs.some((h) => h.meta === meta)) {
      meta.pipeIn = pipeNext;
      meta.pipeFromGroup = groupNext;
      segments.push(words);
      metas.push(meta);
    }
    words = [];
    meta = newMeta();
    pipeNext = false;
    groupNext = false;
    parenClosed = false;
  };
  // Consume the bodies of pending heredocs, starting at the line after the operator.
  const readHeredocs = (start) => {
    let j = start;
    for (const h of heredocs) {
      let body = '';
      for (;;) {
        if (j >= src.length) throw new ParseError('unterminated heredoc');
        let eol = src.indexOf('\n', j);
        if (eol < 0) eol = src.length;
        let line = src.slice(j, eol);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (h.dash) line = line.replace(/^\t+/, '');
        j = eol + 1;
        if (line === h.delim) break;
        body += `${line}\n`;
      }
      const text = h.quoted ? body : scanHeredocBody(body, subs);
      h.meta.stdin.push({ kind: 'heredoc', text, quoted: h.quoted });
    }
    heredocs.length = 0;
    return j;
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
      wordQuoted = true;
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
      wordQuoted = true;
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
    if (c === '\n') {
      endSegment();
      i++;
      if (heredocs.length) i = readHeredocs(i);
      continue;
    }
    if (c === ';') { endSegment(); i++; continue; }

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
      const fromGroup = parenClosed;
      endSegment();
      if (next === '|') { i += 2; continue; } // ||
      pipeNext = true; // | and |&
      groupNext = fromGroup;
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') {
      endSegment();
      if (c === ')') parenClosed = true;
      i++;
      continue;
    }

    if (dialect === 'bash' && c === '<' && next === '<') {
      if (inWord && /^\d+$/.test(cur)) { cur = ''; inWord = false; wordQuoted = false; } else flushWord();
      if (src[i + 2] === '<') { // here-string: the next word is stdin
        capture = meta;
        i += 3;
        continue;
      }
      // heredoc: <<WORD or <<-WORD; any quoting in WORD makes the body literal
      i += 2;
      let dash = false;
      if (src[i] === '-') { dash = true; i++; }
      while (src[i] === ' ' || src[i] === '\t') i++;
      let delim = '';
      let quoted = false;
      while (i < n && !/[\s;&|<>()]/.test(src[i])) {
        const d = src[i];
        if (d === "'" || d === '"') {
          const end = src.indexOf(d, i + 1);
          if (end < 0) throw new ParseError('unterminated quote in heredoc delimiter');
          delim += src.slice(i + 1, end);
          quoted = true;
          i = end + 1;
          continue;
        }
        if (d === '\\') {
          if (i + 1 < n) delim += src[i + 1];
          quoted = true;
          i += 2;
          continue;
        }
        delim += d;
        i++;
      }
      if (!delim) throw new ParseError('missing heredoc delimiter');
      heredocs.push({ delim, dash, quoted, meta });
      continue;
    }

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
  if (heredocs.length) throw new ParseError('unterminated heredoc');
  return { segments, subs, metas };
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
    ...parsed.segments.map((words, k) => () =>
      checkSegment(words, local, depth, stdinText(parsed, k, local.dialect))),
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

// stdin: text known to reach this command's stdin (heredoc, here-string or
// piped literal), or null when there is none or it cannot be known.
// GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,
// or swapping the config files read (GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM), set by
// bash assignment, env, export, or PowerShell $env:, can repoint core.hooksPath.
const GIT_CONFIG_ENV = /^(\$env:)?GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)(=|$)/i;

function checkSegment(words, ctx, depth, stdin = null) {
  // Remembered for the rest of the command: a later git push in it is blocked.
  if (words.some((x) => GIT_CONFIG_ENV.test(x))) ctx.gitConfigEnv = true;
  const { words: w, uncertain } = stripWrappers(words);
  const where = show(words.join(' ') || '(group)');
  const wrap = (r) => {
    if (!r) return null;
    if (typeof r === 'string') return { reason: r, where };
    return r.where ? r : { ...r, where };
  };
  // No command of its own ({ ...; } <<EOF, (...) <<EOF): the text goes to
  // whatever runs inside the group, so treat it as an unknown consumer.
  if (!w.length) return stdin === null ? null : wrap(checkStdin(null, [], stdin, ctx, depth));
  const dynamicName = isDynamic(w[0]);
  const name = dynamicName ? null : normName(w[0]);
  const r = wrap(dynamicName
    ? unsure(ctx, 'the command name is computed at run time')
    : checkCommand(name, w.slice(1), ctx, depth, uncertain));
  if ((r && !r.soft) || stdin === null) return r;
  const s = wrap(checkStdin(name, w.slice(1), stdin, ctx, depth));
  if (s && !s.soft) return s;
  return r || s;
}

// ------------------------------------------------------------- stdin text

const GROUP_END = new Set(['done', 'fi', 'esac']);

// The segment closes a { ...; } group or a loop/if/case, so its output is
// whatever the commands inside wrote.
function closesGroup(words) {
  if (!words.length) return true;
  if (GROUP_END.has(normName(words[0]))) return true;
  return !stripWrappers(words).words.length && words.includes('}');
}

// Text reaching segment k's stdin: its heredocs and here-strings, plus the
// output of a piped producer when that output is a known literal. When the
// producer is a group, its exact members are not tracked, so every literal
// output earlier in the command is counted (over-approximation, fails safe).
function stdinText(parsed, k, dialect) {
  const meta = parsed.metas[k];
  const parts = meta.stdin.map((s) => s.text);
  if (meta.pipeIn && k > 0) {
    if (meta.pipeFromGroup || closesGroup(parsed.segments[k - 1])) {
      for (let j = 0; j < k; j++) {
        const out = stdoutText(parsed, j, dialect);
        if (out !== null) parts.push(out);
      }
    } else {
      const up = stdoutText(parsed, k - 1, dialect);
      if (up !== null) parts.push(up);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

const unescapeC = (s) => s.replace(/\\([ntr\\])/g, (_, e) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\' })[e]);

// Output of segment k when it is a literal known before running: echo/printf,
// a PowerShell string value or Write-Output, or cat/tee passing literal stdin on.
// null when the output cannot be known (files, network, other programs).
function stdoutText(parsed, k, dialect) {
  const words = parsed.segments[k];
  if (dialect === 'ps' && parsed.metas[k].firstQuoted) {
    // 'text' | ... or @'...'@ | ...: a string value, not a command
    return words.join('\n').replace(/^@\r?\n?([\s\S]*?)\r?\n?@$/, '$1');
  }
  const { words: w } = stripWrappers(words);
  if (!w.length || isDynamic(w[0])) return null;
  const name = normName(w[0]);
  let args = w.slice(1);
  if (name === 'echo' || (dialect === 'ps' && (name === 'write-output' || name === 'write'))) {
    let esc = false;
    if (dialect === 'bash') {
      while (args.length && /^-[neE]+$/.test(args[0])) {
        if (args[0].includes('e')) esc = true;
        args = args.slice(1);
      }
    }
    const text = args.join(dialect === 'ps' ? '\n' : ' ');
    return esc ? unescapeC(text) : text;
  }
  if (name === 'printf' && dialect === 'bash') return unescapeC(args.join(' '));
  if (name === 'tee') return stdinText(parsed, k, dialect);
  if (name === 'cat') {
    if (args.some((a) => a !== '-' && !a.startsWith('-'))) return null; // reads files
    return stdinText(parsed, k, dialect);
  }
  return null;
}

// Commands that only treat stdin as text: it is never run as code.
function isTextConsumer(name, args) {
  if (name === 'cat' || name === 'tee') return true;
  if (name === 'gh') {
    return args.some((a, i) => a === '--body-file=-' || (a === '--body-file' && args[i + 1] === '-'));
  }
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      i += args[i] === '-C' || GIT_VALUE_OPTS.includes(args[i]) ? 2 : 1;
    }
    if ((args[i] || '').toLowerCase() !== 'commit') return false;
    const rest = args.slice(i + 1);
    return rest.some((a, j) => a === '--file=-' || a === '-F-'
      || ((a === '-F' || a === '--file') && rest[j + 1] === '-'));
  }
  return false;
}

// Text reaching a command's stdin: free for text-only consumers; checked as a
// script for shells; for anything else (python, node, perl, ruby, unknown
// programs) blocked when it mentions push/upload/flash/esptool.
function checkStdin(name, args, text, ctx, depth) {
  if (name !== null && isTextConsumer(name, args)) return null;
  if (name !== null && SHELLS.has(name)) return analyze(text, { ...ctx, dialect: 'bash' }, depth + 1);
  if (name === 'powershell' || name === 'pwsh') return analyze(text, { ...ctx, dialect: 'ps' }, depth + 1);
  if (name === 'cmd') return analyze(text, { ...ctx, dialect: 'cmd' }, depth + 1);
  return RISKY.test(text)
    ? `input sent to ${name === null ? 'a computed command' : name} mentions push/upload/flash/esptool and cannot be checked`
    : null;
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
  if (name === 'gh') return checkGh(args);
  if (FILE_COMMANDS.has(name)) return checkHookFile(name, args, ctx);
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

const HOOKS_PATH_KEY = /^core\.hookspath(=|$)/i;

function checkGit(args, ctx, uncertain) {
  const opts = [];
  let cwd = ctx.cwd;
  let unknownLocation = cwd === null;
  let setsHooksPath = false;
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
      if ((a === '-c' || a === '--config-env') && HOOKS_PATH_KEY.test(v)) setsHooksPath = true;
      opts.push(a, v);
      continue;
    }
    if (/^--config-env=/i.test(a) && HOOKS_PATH_KEY.test(a.slice('--config-env='.length))) setsHooksPath = true;
    if (a.startsWith('-')) { opts.push(a); continue; }
    break;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  if (isDynamic(sub)) return unsure(ctx, 'the git subcommand is computed at run time');
  const rest = args.slice(i + 1);
  switch (sub.toLowerCase()) {
    case 'push':
      if (setsHooksPath) return 'git push sets core.hooksPath on the command line, which would bypass the pre-push hook';
      if (ctx.gitConfigEnv) return 'GIT_CONFIG_* environment variables can repoint core.hooksPath and bypass the pre-push hook';
      return checkPush(rest, { ctx, cwd, opts, unknownLocation, uncertain });
    case 'config':
      return checkGitConfig(rest);
    case 'rm':
    case 'mv':
      return checkHookFile(`git ${sub.toLowerCase()}`, rest, { ...ctx, cwd: unknownLocation ? null : cwd });
    default:
      return null;
  }
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
      // git accepts unambiguous abbreviations: --no-veri, --no-verif, --no-verify
      if (a.length >= '--no-veri'.length && '--no-verify'.startsWith(a)) {
        return 'git push --no-verify would skip the pre-push hook';
      }
      if (a === '--repo') { repoOption = true; i++; continue; }
      if (a.startsWith('--repo=')) { repoOption = true; continue; }
      if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) { i++; continue; }
      if (['--all', '--mirror', '--branches'].includes(a)) pushesAll = true;
      continue;
    }
    positional.push(a);
  }

  if (q.unknownLocation) {
    const u = unsure(q.ctx, 'the repository directory is computed at run time, so the pre-push hook cannot be checked');
    if (u) return u;
  } else {
    const inactive = hookInactive(q.cwd, q.opts);
    if (inactive) return inactive;
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

// ------------------------------------------------------ pre-push hook (.githooks)

function normPath(p) {
  const r = path.resolve(fromMsys(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function samePath(a, b) {
  return normPath(a) === normPath(b);
}

// A: a repository that ships .githooks/pre-push must have it enabled before any push.
function hookInactive(cwd, opts) {
  const top = git(cwd, [...opts, 'rev-parse', '--show-toplevel']);
  if (!top) return null; // not a repository; git push will fail on its own
  const hooksDir = path.join(fromMsys(top), '.githooks');
  if (!fs.existsSync(path.join(hooksDir, 'pre-push'))) return null;
  const hooksPath = git(cwd, [...opts, 'config', '--get', 'core.hooksPath']);
  // A relative core.hooksPath is resolved from the top of the working tree.
  if (hooksPath && samePath(path.resolve(fromMsys(top), fromMsys(hooksPath)), hooksDir)) return null;
  return `the pre-push hook in .githooks is not enabled (core.hooksPath is ${hooksPath ? `"${hooksPath}"` : 'unset'}); `
    + 'run: git config core.hooksPath .githooks';
}

// D: core.hooksPath may only be read, or set to .githooks.
function checkGitConfig(args) {
  const SUBCOMMANDS = ['get', 'set', 'unset', 'list', 'edit', 'rename-section', 'remove-section'];
  const VALUE_OPTS = ['--file', '-f', '--blob', '--type', '--default', '--comment', '--value'];
  const GET_OPTS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list'];
  let action = null; // get | unset | set
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const l = a.toLowerCase();
    if (VALUE_OPTS.includes(l)) { i++; continue; }
    if (l === '--unset' || l === '--unset-all') { action = 'unset'; continue; }
    if (GET_OPTS.includes(l)) { action = action || 'get'; continue; }
    if (l === '-e' || l === '--edit') return 'git config --edit opens the config in an editor, which could change core.hooksPath';
    if (l === '--remove-section' || l === '--rename-section') {
      const section = args[i + 1] || '';
      if (isDynamic(section) || section.toLowerCase() === 'core') return `git config ${l} ${section} would drop core.hooksPath`;
      i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) continue;
    positional.push(a);
  }
  if (positional.length && SUBCOMMANDS.includes(positional[0].toLowerCase())) {
    const sub = positional.shift().toLowerCase();
    if (sub === 'edit') return 'git config edit opens the config in an editor, which could change core.hooksPath';
    if (sub === 'remove-section' || sub === 'rename-section') {
      const section = positional[0] || '';
      return isDynamic(section) || section.toLowerCase() === 'core' ? `git config ${sub} ${section} would drop core.hooksPath` : null;
    }
    action = sub === 'list' ? 'get' : sub;
  }
  const key = positional[0];
  if (key === undefined) return null;
  if (isDynamic(key)) return action === 'get' ? null : 'the git config key is computed at run time, so it cannot be checked against core.hooksPath';
  if (key.toLowerCase() !== 'core.hookspath') return null;
  if (action === 'get') return null;
  if (action === 'unset') return 'git config would unset core.hooksPath, disabling the pre-push hook';
  const value = positional[1];
  if (value === undefined) return null; // old-style read: git config core.hooksPath
  if (!isDynamic(value) && value.replace(/^\.\//, '').replace(/[\\/]+$/, '') === '.githooks') return null;
  return `git config would set core.hooksPath to "${show(value)}"; the pre-push hook needs .githooks`;
}

// E: commands that delete, move, overwrite or change the mode of files.
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'remove-item', 'ri', 'git rm']);
const MOVERS = new Set(['mv', 'move', 'move-item', 'mi', 'rename-item', 'ren', 'rni', 'git mv']);
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install']);
const WRITERS = new Set(['chmod', 'chattr', 'tee', 'truncate', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'clear-content', 'clc', 'new-item', 'ni']);
const FILE_COMMANDS = new Set([...REMOVERS, ...MOVERS, ...COPIERS, ...WRITERS, 'sed']);
const PATH_PARAMS = ['-path', '-literalpath', '-destination', '-filepath', '-target', '-t', '--target-directory'];

// Is p (relative to cwd) inside the .githooks directory at the top of a git
// working tree, or (for recursive removal) a directory that contains one?
function isHookPath(p, cwd, removing) {
  if (isDynamic(p)) return /\.githooks/i.test(p);
  const resolved = resolveDir(cwd, p);
  if (resolved === null) return /(^|[\\/])\.githooks([\\/]|$)/i.test(p);
  const parts = resolved.split(path.sep);
  const idx = parts.findIndex((x) => x.toLowerCase() === '.githooks');
  if (idx > 0) {
    const candidate = parts.slice(0, idx).join(path.sep) || path.sep;
    if (fs.existsSync(candidate)) {
      const top = git(candidate, ['rev-parse', '--show-toplevel']);
      if (top && samePath(top, candidate)) return true;
    }
  }
  return removing && fs.existsSync(path.join(resolved, '.githooks', 'pre-push'));
}

function checkHookFile(name, args, ctx) {
  if (name === 'sed' && !args.some((a) => /^(-i|--in-place)/.test(a))) return null;
  const flagged = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const l = a.toLowerCase();
    if (PATH_PARAMS.includes(l)) { flagged.push(args[++i] || ''); continue; }
    if (l.startsWith('--target-directory=')) { flagged.push(a.slice(a.indexOf('=') + 1)); continue; }
    if (a.startsWith('-') && a.length > 1) continue;
    positional.push(a);
  }
  // A copy only changes its destination.
  const targets = COPIERS.has(name)
    ? [...flagged, ...(flagged.length || positional.length < 2 ? [] : [positional[positional.length - 1]])]
    : [...flagged, ...positional];
  const removing = REMOVERS.has(name) || MOVERS.has(name);
  const hit = targets.find((p) => isHookPath(p, ctx.cwd, removing));
  return hit === undefined ? null : `${name} would delete or change the pre-push hook in .githooks ("${show(hit)}")`;
}

// ------------------------------------------------------------- GitHub (gh)

// F: no writes to main and no merges through the GitHub CLI or API.
function checkGh(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += ['-R', '--repo'].includes(args[i]) ? 2 : 1;
  const sub = (args[i] || '').toLowerCase();
  if (sub === 'api') return checkGhApi(args.slice(i + 1));
  if (sub === 'pr') {
    let j = i + 1;
    while (j < args.length && args[j].startsWith('-')) j += ['-R', '--repo'].includes(args[j]) ? 2 : 1;
    if ((args[j] || '').toLowerCase() === 'merge') return 'gh pr merge merges a pull request; merging is a human gate';
  }
  return null;
}

const GRAPHQL_WRITES = /\b(mergePullRequest|mergeBranch|enablePullRequestAutoMerge|updateRefs?|createRef|deleteRef)\b/;

function checkGhApi(args) {
  let method = null;
  let hasBody = false;
  let hasInput = false; // request body read from a file or stdin: not inspected
  let endpoint = null;
  const fields = {};
  const addField = (kv) => {
    const eq = (kv || '').indexOf('=');
    if (eq > 0) fields[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1);
    hasBody = true;
  };
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '-X' || a === '--method') { method = args[++j] || ''; continue; }
    if (a.startsWith('--method=')) { method = a.slice('--method='.length); continue; }
    if (/^-X./.test(a)) { method = a.slice(2); continue; }
    if (['-f', '-F', '--raw-field', '--field'].includes(a)) { addField(args[++j]); continue; }
    if (/^--(raw-)?field=/.test(a)) { addField(a.slice(a.indexOf('=') + 1)); continue; }
    if (/^-[fF]./.test(a)) { addField(a.slice(2)); continue; }
    if (a === '--input') { j++; hasBody = true; hasInput = true; continue; }
    if (a.startsWith('--input=')) { hasBody = true; hasInput = true; continue; }
    if (['-H', '--header', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview'].includes(a)) { j++; continue; }
    if (a.startsWith('-') && a.length > 1) continue;
    if (endpoint === null) endpoint = a;
  }
  if (endpoint === null) return null;
  const verb = (method || (hasBody ? 'POST' : 'GET')).toUpperCase();
  let ep = endpoint;
  try { ep = decodeURIComponent(ep); } catch { /* keep as written */ }
  ep = ep.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/^api\/v3\//i, '')
    .replace(/\/{2,}/g, '/').toLowerCase();

  if (ep === 'graphql') {
    const query = fields.query || '';
    const m = /\bmutation\b/i.test(query) && query.match(GRAPHQL_WRITES);
    return m ? `gh api graphql runs the ${m[1]} mutation, which can merge or move branches` : null;
  }
  if (verb === 'GET' || verb === 'HEAD') return null;
  const rest = (ep.match(/^repos\/[^/]+\/[^/]+\/(.*)$/) || [null, ep])[1];
  const isMain = (v) => v === undefined || isDynamic(v) || /^(refs\/heads\/)?main$/i.test(v);
  const what = `gh api ${verb} ${show(endpoint)}`;
  if (/^git\/refs\/heads\/main$/.test(rest)) return `${what} writes refs/heads/main`;
  if (rest === 'git/refs' && fields.ref !== undefined && (isDynamic(fields.ref) || /^refs\/heads\/main$/i.test(fields.ref))) {
    return `${what} creates refs/heads/main`;
  }
  if (rest === 'git/refs' && fields.ref === undefined && hasInput) {
    return `${what} creates a ref named in a request body file, so it cannot be checked against main`;
  }
  if (/^pulls\/[^/]+\/merge$/.test(rest)) return `${what} calls the pull request merge endpoint`;
  if (rest === 'merges' && isMain(fields.base)) return `${what} merges into main`;
  if (/^contents\//.test(rest) && (verb === 'PUT' || verb === 'DELETE')) {
    if (fields.branch === undefined) return `${what} writes a file on the default branch (main)`;
    if (isMain(fields.branch)) return `${what} writes a file on main`;
  }
  if (/^branches\/main(\/|$)/.test(rest)) return `${what} changes settings of branch main (e.g. its protection)`;
  if (rest === 'merge-upstream' && isMain(fields.branch)) return `${what} updates main from upstream`;
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

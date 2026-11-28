/**
 * Read-only shell classification, judged by the rules of the shell that will run the
 * command.
 *
 * The bash tool does not run one shell: `resolveShell` spawns `pwsh -Command`, then
 * `powershell -Command`, then `cmd /c` on Windows, and `bash -lc` elsewhere. Those
 * shells disagree about quoting, escaping, separators, expansion and redirection, so a
 * line that only reads under bash can start a program under PowerShell. The classifier
 * therefore scans a command once per candidate shell and the caller requires every scan
 * to pass: a command is read-only only when it is read-only under all of them.
 *
 * The scanners are deliberately conservative. Anything they cannot model with
 * certainty is a failure, never a guess: command substitution, variable expansion,
 * grouping, here-strings, escapes that hide an operator, and any redirect that is not
 * the platform's null device are refused.
 */

/** The shell grammars `resolveShell` can hand a command to. */
export type ShellFamily = 'posix' | 'powershell' | 'cmd';

export type ShellScan =
  | { segments: string[][] }
  | { failure: 'syntax' | 'redirect' | 'expansion' };

/** The shells `resolveShell` can spawn on `platform`, most preferred first. */
export function shellFamiliesFor(platform: NodeJS.Platform): readonly ShellFamily[] {
  return platform === 'win32' ? ['powershell', 'cmd'] : ['posix'];
}

export function scanShellCommand(
  command: string,
  shell: ShellFamily,
  platform: NodeJS.Platform,
): ShellScan {
  if (shell === 'posix') return scanPosix(command, platform);
  if (shell === 'powershell') return scanPowerShell(command, platform);
  return scanCmd(command, platform);
}

/** Characters that expand to something else in at least one of the candidate shells. */
const EXPANSION_CHARS = /[$`%!^]/;

/**
 * Reads the target of a redirect: one bare or quoted word. A quoted word is read with
 * its quotes removed, so `/dev/null` and `"NUL"` both work. Anything that continues
 * into another operator means the redirect was malformed, which is refused.
 */
function readRedirectTarget(
  command: string,
  start: number,
): { target: string; next: number } | null {
  let i = start;
  let target = '';
  let quote: string | null = null;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else target += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === ';' ||
      ch === '|' ||
      ch === '&' ||
      ch === '<' ||
      ch === '>'
    ) {
      break;
    }
    target += ch;
    i += 1;
  }
  if (quote !== null || target.length === 0) return null;
  return { target, next: i };
}

type RedirectOutcome = { next: number } | { failure: 'syntax' | 'redirect' | 'expansion' };

/**
 * The one redirect shape a read-only turn keeps: stdout or stderr into the platform's
 * null device, or stderr merged into stdout with `2>&1`. Append (`>>`) is refused even
 * to the null device, because every shell agrees it writes somewhere.
 */
function scanRedirect(
  command: string,
  start: number,
  fd: string | null,
  platform: NodeJS.Platform,
): RedirectOutcome {
  let i = start;
  if (command[i] !== '>') return { failure: 'redirect' };
  i += 1;
  if (command[i] === '>' || command[i] === '|') return { failure: 'redirect' };
  while (command[i] === ' ' || command[i] === '\t') i += 1;
  if (command[i] === '&') {
    i += 1;
    let digits = '';
    while (i < command.length) {
      const digit = command[i];
      if (digit === undefined || digit < '0' || digit > '9') break;
      digits += digit;
      i += 1;
    }
    return fd === '2' && digits === '1' ? { next: i } : { failure: 'redirect' };
  }
  const target = readRedirectTarget(command, i);
  if (target === null) return { failure: 'redirect' };
  if (EXPANSION_CHARS.test(target.target)) return { failure: 'expansion' };
  const isNull =
    platform === 'win32'
      ? target.target.toLowerCase() === 'nul'
      : target.target === '/dev/null';
  if (!isNull) return { failure: 'redirect' };
  if (fd !== null && fd !== '1' && fd !== '2') return { failure: 'redirect' };
  return { next: target.next };
}

/**
 * bash -lc. A backslash escapes the next character outside single quotes, and only
 * `"`, `\`, `$`, a backtick or a newline inside double quotes; `$` and backticks expand
 * anywhere; `;`, `&`, `|` and a newline separate commands.
 */
function scanPosix(command: string, platform: NodeJS.Platform): ShellScan {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = '';
  let hasWord = false;
  let single = false;
  let double = false;

  const flushWord = (): void => {
    if (!hasWord) return;
    tokens.push(word);
    word = '';
    hasWord = false;
  };
  const flushSegment = (): void => {
    flushWord();
    segments.push(tokens);
    tokens = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (single) {
      if (ch === "'") single = false;
      else {
        word += ch;
        hasWord = true;
      }
      i += 1;
      continue;
    }
    if (double) {
      if (ch === '"') {
        double = false;
        i += 1;
        continue;
      }
      if (ch === '`' || ch === '$') return { failure: 'expansion' };
      if (ch === '\\') {
        const next = command[i + 1];
        if (next === undefined) return { failure: 'syntax' };
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          if (next !== '\n') {
            word += next;
            hasWord = true;
          }
          i += 2;
          continue;
        }
        word += ch;
        hasWord = true;
        i += 1;
        continue;
      }
      word += ch;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next === undefined) return { failure: 'syntax' };
      word += next;
      hasWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      single = true;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      double = true;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '`' || ch === '$') return { failure: 'expansion' };
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return { failure: 'syntax' };
    if (ch === ' ' || ch === '\t') {
      flushWord();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';') {
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        flushSegment();
        i += 2;
        continue;
      }
      if (command[i + 1] === '>') return { failure: 'redirect' };
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        flushSegment();
        i += 2;
        continue;
      }
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      let fd: string | null = null;
      if (word === '1' || word === '2') {
        fd = word;
        word = '';
        hasWord = false;
      }
      if (fd === null && !hasWord) {
        const last = tokens[tokens.length - 1];
        if (last === '1' || last === '2') {
          fd = last;
          tokens.pop();
        }
      }
      const redirect = scanRedirect(command, i, fd, platform);
      if ('failure' in redirect) return redirect;
      i = redirect.next;
      continue;
    }
    word += ch;
    hasWord = true;
    i += 1;
  }
  if (single || double) return { failure: 'syntax' };
  flushSegment();
  return { segments };
}

/**
 * PowerShell, whose grammar pwsh and Windows PowerShell share. A backtick is the
 * escape character and `$` starts a variable, a subexpression or a splat, so both are
 * refused outright; `@` starts an array, a splat or a here-string; `&` is the call
 * operator; `;`, `|` and a newline separate statements. `#` starts a comment at the
 * start of a word, which would hide the rest of the line from this scanner.
 */
function scanPowerShell(command: string, platform: NodeJS.Platform): ShellScan {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = '';
  let hasWord = false;
  let single = false;
  let double = false;

  const flushWord = (): void => {
    if (!hasWord) return;
    tokens.push(word);
    word = '';
    hasWord = false;
  };
  const flushSegment = (): void => {
    flushWord();
    segments.push(tokens);
    tokens = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (single) {
      if (ch === "'") {
        if (command[i + 1] === "'") {
          word += "'";
          i += 2;
          continue;
        }
        single = false;
        i += 1;
        continue;
      }
      word += ch;
      hasWord = true;
      i += 1;
      continue;
    }
    if (double) {
      if (ch === '"') {
        if (command[i + 1] === '"') {
          word += '"';
          i += 2;
          continue;
        }
        double = false;
        i += 1;
        continue;
      }
      if (ch === '$' || ch === '`') return { failure: 'expansion' };
      word += ch;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '`' || ch === '$' || ch === '@') return { failure: 'expansion' };
    if (ch === "'") {
      single = true;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      double = true;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return { failure: 'syntax' };
    if (ch === '&') {
      // `&&` is a pipeline chain in pwsh 7 and a parse error in 5.1; either way it is
      // a separator, never the call operator. A bare `&` runs a command, so refuse it.
      if (command[i + 1] === '&') {
        flushSegment();
        i += 2;
        continue;
      }
      return { failure: 'syntax' };
    }
    if (ch === '#' && !hasWord) return { failure: 'syntax' };
    if (ch === ' ' || ch === '\t') {
      flushWord();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';') {
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        flushSegment();
        i += 2;
        continue;
      }
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      let fd: string | null = null;
      if (word === '1' || word === '2') {
        fd = word;
        word = '';
        hasWord = false;
      }
      const redirect = scanRedirect(command, i, fd, platform);
      if ('failure' in redirect) return redirect;
      i = redirect.next;
      continue;
    }
    word += ch;
    hasWord = true;
    i += 1;
  }
  if (single || double) return { failure: 'syntax' };
  flushSegment();
  return { segments };
}

/**
 * cmd.exe, which `resolveShell` spawns as `cmd /d /s /c` with delayed expansion off.
 * `^` is the escape character, `%name%` expands a variable, `(`, `)` group commands,
 * and `&`, `|` and a newline separate commands. A single quote is an ordinary
 * character; only double quotes quote. `;` is an ordinary argument character here,
 * which is why a line that splits on it under PowerShell is still refused overall.
 */
function scanCmd(command: string, platform: NodeJS.Platform): ShellScan {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = '';
  let hasWord = false;
  let quoted = false;

  const flushWord = (): void => {
    if (!hasWord) return;
    tokens.push(word);
    word = '';
    hasWord = false;
  };
  const flushSegment = (): void => {
    flushWord();
    segments.push(tokens);
    tokens = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (quoted) {
      if (ch === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === '%' || ch === '!') return { failure: 'expansion' };
      word += ch;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '^' || ch === '!') return { failure: 'expansion' };
    if (ch === '%') {
      // `%name%` expands; a lone `%` is an ordinary character for cmd.
      const close = command.indexOf('%', i + 1);
      if (close !== -1 && !/[\s"'&|<>]/.test(command.slice(i + 1, close))) {
        return { failure: 'expansion' };
      }
      word += ch;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') return { failure: 'syntax' };
    if (ch === ' ' || ch === '\t') {
      flushWord();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '>') return { failure: 'syntax' };
      flushSegment();
      i += command[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (ch === '|') {
      flushSegment();
      i += command[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      let fd: string | null = null;
      if (word === '1' || word === '2') {
        fd = word;
        word = '';
        hasWord = false;
      }
      const redirect = scanRedirect(command, i, fd, platform);
      if ('failure' in redirect) return redirect;
      i = redirect.next;
      continue;
    }
    word += ch;
    hasWord = true;
    i += 1;
  }
  if (quoted) return { failure: 'syntax' };
  flushSegment();
  return { segments };
}

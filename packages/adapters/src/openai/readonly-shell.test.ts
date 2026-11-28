import { describe, expect, it } from 'vitest';
import { isReadOnlyCommandFor } from './tools.js';
import { scanShellCommand, shellFamiliesFor } from './readonly-shell.js';

/** The Windows rule: PowerShell and cmd must both agree the line only reads. */
function readOnlyOnWindows(command: string): boolean {
  return shellFamiliesFor('win32').every((shell) =>
    isReadOnlyCommandFor(command, shell, 'win32'),
  );
}

function readOnlyOnPosix(command: string): boolean {
  return isReadOnlyCommandFor(command, 'posix', 'linux');
}

describe('shell families', () => {
  it('names the shells resolveShell can spawn per platform', () => {
    expect(shellFamiliesFor('win32')).toEqual(['powershell', 'cmd']);
    expect(shellFamiliesFor('linux')).toEqual(['posix']);
    expect(shellFamiliesFor('darwin')).toEqual(['posix']);
  });
});

describe('posix (bash -lc)', () => {
  it('allows the read-only commands and the bash null device', () => {
    const allowed = [
      'ls',
      'ls -la',
      'cat package.json',
      'grep -rn "needle" src',
      'find . -name "*.ts" -type f',
      'git status --porcelain',
      'git log --oneline -5',
      'git diff --stat',
      'git log && git status',
      'git log\ngit status',
      'ls | wc -l',
      'ls 2>/dev/null',
      'ls >/dev/null',
      'git status 2>&1',
      'git log 2>&1 | head -n 5',
      'ls "a b"',
      "echo 'a;b'",
      // A backslash escapes the semicolon here, so bash sees one argument.
      'ls \\; node evil.js',
    ];
    for (const command of allowed) expect(readOnlyOnPosix(command), command).toBe(true);
  });

  it('refuses the windows null device, writes, chains and expansion', () => {
    const denied = [
      'ls 2>NUL',
      'ls 2>out.txt',
      'ls > out.txt',
      'ls >> /dev/null',
      'ls 2>>/dev/null',
      'ls 2>&2',
      'ls 1>&2',
      'ls &> out.txt',
      'ls; rm -rf x',
      'ls && rm -rf x',
      'ls | sh',
      'ls & rm -rf x',
      'ls\nrm -rf x',
      'echo `whoami`',
      'echo $(whoami)',
      'git log --format=%s$IFS--output=x',
      'cat < file',
      'find . -exec calc {} ;',
      'find . "-delete"',
      'git log "--output=x"',
      'rg "--pre=prog"',
      'FOO=bar ls',
      'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
    ];
    for (const command of denied) expect(readOnlyOnPosix(command), command).toBe(false);
  });
});

describe('powershell', () => {
  it('allows plain commands, quoted words and the windows null device', () => {
    const allowed = [
      'ls',
      'dir',
      'pwd',
      'Get-ChildItem -Path src -Recurse',
      'Select-String -Path *.ts -Pattern needle',
      'Get-Content package.json',
      'git status --porcelain',
      'git status 2>&1',
      'git log 2>&1 | head -n 5',
      'ls 2>NUL',
      'ls >NUL',
      'ls "a b"',
      "echo 'a;b'",
      'git log --format=%h',
      'Get-ChildItem | Measure-Object',
    ];
    for (const command of allowed) {
      expect(isReadOnlyCommandFor(command, 'powershell', 'win32'), command).toBe(true);
    }
  });

  it('refuses backslash-hidden operators, expansion, calls and cmd null device', () => {
    const denied = [
      'ls \\; node evil.js',
      'ls "\\"; node evil.js #"',
      'dir "\\" & node evil.js & rem "',
      'ls \\| node --version',
      'dir \\| node --version',
      'ls & node evil.js',
      'ls 2>/dev/null',
      'ls > out.txt',
      'echo $(Remove-Item x)',
      'echo `whoami`',
      'Get-ChildItem (Remove-Item x)',
      'Get-ChildItem @args',
      'ls # hidden ; node evil.js',
      'git log --format=%s$IFS--output=x',
      'git log "--output=x"',
      'ls; node evil.js',
    ];
    for (const command of denied) {
      expect(isReadOnlyCommandFor(command, 'powershell', 'win32'), command).toBe(false);
    }
  });
});

describe('cmd', () => {
  it('allows plain commands, the windows null device and cmd quoting', () => {
    const allowed = [
      'dir',
      'ls',
      'git status --porcelain',
      'git status 2>&1',
      'dir 2>NUL',
      'dir >NUL',
      'git log --format=%h',
      'git log && git status',
      'dir "a b"',
    ];
    for (const command of allowed) {
      expect(isReadOnlyCommandFor(command, 'cmd', 'win32'), command).toBe(true);
    }
  });

  it('refuses escapes, percent expansion, separators and file redirects', () => {
    const denied = [
      'dir & node evil.js',
      'dir | node evil.js',
      'dir \\| node evil.js',
      'dir ^& node evil.js',
      'dir %PATH%',
      'dir > out.txt',
      'dir 2>/dev/null',
      'dir 2>&1 > out.txt',
      'dir (node evil.js)',
    ];
    for (const command of denied) {
      expect(isReadOnlyCommandFor(command, 'cmd', 'win32'), command).toBe(false);
    }
  });
});

describe('windows requires every shell to agree', () => {
  it('refuses the inputs that split differently under PowerShell and cmd', () => {
    const denied = [
      'ls "\\"; node evil.js #"',
      'ls \\; node evil.js',
      'dir "\\" & node evil.js & rem "',
      'ls \\| node --version',
      'dir \\| node --version',
      'git log -p --format=%s$IFS--output=file',
      'git log "--output=x"',
      'rg "--pre=prog"',
      'find . "-delete"',
      'ls 2>/dev/null',
    ];
    for (const command of denied) expect(readOnlyOnWindows(command), command).toBe(false);
  });

  it('keeps the commands both shells read', () => {
    const allowed = ['dir', 'ls', 'git status', 'git log 2>&1 | head -n 5', 'ls 2>NUL'];
    for (const command of allowed) expect(readOnlyOnWindows(command), command).toBe(true);
  });
});

describe('scanShellCommand', () => {
  it('reports why a line was refused', () => {
    expect(scanShellCommand('ls 2>out.txt', 'posix', 'linux')).toEqual({
      failure: 'redirect',
    });
    expect(scanShellCommand('echo $HOME', 'posix', 'linux')).toEqual({ failure: 'expansion' });
    expect(scanShellCommand('echo "unclosed', 'posix', 'linux')).toEqual({ failure: 'syntax' });
  });

  it('splits segments with the shell it is given', () => {
    // cmd treats a semicolon as an ordinary argument character.
    expect(scanShellCommand('dir; node evil.js', 'cmd', 'win32')).toEqual({
      segments: [['dir;', 'node', 'evil.js']],
    });
    expect(scanShellCommand('ls; node evil.js', 'powershell', 'win32')).toEqual({
      segments: [['ls'], ['node', 'evil.js']],
    });
  });
});

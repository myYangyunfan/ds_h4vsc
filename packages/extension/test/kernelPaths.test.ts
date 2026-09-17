/**
 * Pins the off-PATH search used to find `dsh` (and the `npm` that installs one)
 * on a machine whose editor did not inherit the terminal's PATH - the macOS
 * "kernel not found although `dsh --version` works" report.
 *
 * These are the parts that can be checked without a file system: the directory
 * list, the platform-specific binary names, and the parser for a login shell's
 * PATH output (which has to survive rc-file noise).
 */
import { describe, expect, it } from 'vitest';
import {
  binaryFileNames,
  candidateBinDirs,
  dedupeDirs,
  nodeVersionManagerGlobs,
  parseShellPathOutput,
  SHELL_PATH_MARKER,
} from '../src/backend/kernelPaths.js';

const macHome = '/Users/someone';
const macEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };

describe('candidateBinDirs', () => {
  it('checks the Apple Silicon Homebrew prefix before the Intel one', () => {
    const dirs = candidateBinDirs({ home: macHome, platform: 'darwin', env: macEnv });
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs.indexOf('/opt/homebrew/bin')).toBeLessThan(dirs.indexOf('/usr/local/bin'));
  });

  it('covers the user-scoped prefixes a GUI app cannot see', () => {
    const dirs = candidateBinDirs({ home: macHome, platform: 'darwin', env: macEnv });
    for (const dir of [
      `${macHome}/.npm-global/bin`,
      `${macHome}/.local/bin`,
      `${macHome}/.bun/bin`,
      `${macHome}/.volta/bin`,
      `${macHome}/Library/pnpm`,
      `${macHome}/.dsh/bin`,
    ]) {
      expect(dirs).toContain(dir);
    }
  });

  it('includes one glob per Node version manager', () => {
    const dirs = candidateBinDirs({ home: macHome, platform: 'darwin', env: macEnv });
    for (const glob of nodeVersionManagerGlobs(macHome)) {
      expect(dirs).toContain(glob);
      expect(glob).toContain('*');
    }
    // The nvm layout is the one that bites most often: PATH entries added by
    // `nvm use` live in the shell only, never in a Dock-launched editor.
    expect(dirs).toContain(`${macHome}/.nvm/versions/node/*/bin`);
  });

  it('does not offer POSIX paths on Windows, and reads its prefixes from the environment', () => {
    const dirs = candidateBinDirs({
      home: 'C:\\Users\\someone',
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' },
    });
    expect(dirs).toEqual(['C:\\Users\\someone\\AppData\\Roaming\\npm']);
    expect(dirs.some((dir) => dir.startsWith('/'))).toBe(false);
  });

  it('tolerates a trailing separator in the Windows environment values', () => {
    const dirs = candidateBinDirs({
      home: 'C:\\Users\\someone',
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming\\' },
    });
    expect(dirs).toEqual(['C:\\Users\\someone\\AppData\\Roaming\\npm']);
  });

  it('skips Windows entries whose environment variable is unset', () => {
    // LOCALAPPDATA / ProgramFiles missing must not produce "\pnpm" style junk.
    const dirs = candidateBinDirs({
      home: 'C:\\Users\\someone',
      platform: 'win32',
      env: {},
    });
    expect(dirs).toEqual([]);
  });
});

describe('binaryFileNames', () => {
  it('tries the Windows shims before the bare name', () => {
    expect(binaryFileNames('dsh', 'win32')).toEqual(['dsh.cmd', 'dsh.exe', 'dsh']);
  });

  it('uses the bare name on POSIX', () => {
    expect(binaryFileNames('dsh', 'darwin')).toEqual(['dsh']);
    expect(binaryFileNames('npm', 'linux')).toEqual(['npm']);
  });
});

describe('parseShellPathOutput', () => {
  it('reads the marked line and ignores rc-file chatter', () => {
    const stdout = [
      'nvm is not compatible with the "PREFIX" environment variable',
      'Welcome back!',
      `${SHELL_PATH_MARKER}/opt/homebrew/bin:/usr/bin:/bin`,
    ].join('\n');
    expect(parseShellPathOutput(stdout)).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin']);
  });

  it('takes the last marked line when a login shell prints more than one', () => {
    const stdout = [
      `${SHELL_PATH_MARKER}/first`,
      'some banner',
      `${SHELL_PATH_MARKER}/second:/last`,
    ].join('\n');
    expect(parseShellPathOutput(stdout)).toEqual(['/second', '/last']);
  });

  it('returns nothing when the shell never printed the marker', () => {
    // A shell that died early, or one whose rc file replaced the command.
    expect(parseShellPathOutput('')).toEqual([]);
    expect(parseShellPathOutput('/usr/bin:/bin')).toEqual([]);
  });

  it('drops empty entries and duplicates', () => {
    const stdout = `${SHELL_PATH_MARKER}/usr/bin::/bin:/usr/bin:`;
    expect(parseShellPathOutput(stdout)).toEqual(['/usr/bin', '/bin']);
  });

  it('returns nothing for an empty PATH', () => {
    expect(parseShellPathOutput(`${SHELL_PATH_MARKER}\n`)).toEqual([]);
    expect(parseShellPathOutput(`${SHELL_PATH_MARKER}   \n`)).toEqual([]);
  });

  it('splits on the delimiter it is given', () => {
    expect(parseShellPathOutput(`${SHELL_PATH_MARKER}C:\\a;C:\\b`, ';')).toEqual(['C:\\a', 'C:\\b']);
  });

  it('does not treat a marker-looking prefix in a banner as the PATH', () => {
    // Only a line *starting* with the marker counts; a mention inside a banner
    // must not be mistaken for the value.
    const stdout = `note: ${SHELL_PATH_MARKER} is used by the extension\n${SHELL_PATH_MARKER}/real`;
    expect(parseShellPathOutput(stdout)).toEqual(['/real']);
  });
});

describe('dedupeDirs', () => {
  it('keeps the first occurrence and the overall order', () => {
    expect(dedupeDirs(['/a', '/b'], ['/b', '/c'], ['/a', '/d'])).toEqual(['/a', '/b', '/c', '/d']);
  });
});

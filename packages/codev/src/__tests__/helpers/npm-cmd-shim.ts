/**
 * The `.cmd` shim npm writes for a package bin on Windows (Spec 1658, M16), byte for byte as npm's
 * cmd-shim 7.0.0 generates it for a `node` script, so a Windows test reaches a stand-in through
 * the same route a real npm install takes: the shim resolver reads the entry out of this text and
 * runs `node <entry>` (or, under a PATH without node, the double-escaped cmd.exe route).
 */
export function npmCmdShim(entryFileName: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entryFileName}" %*`,
    '',
  ].join('\r\n');
}

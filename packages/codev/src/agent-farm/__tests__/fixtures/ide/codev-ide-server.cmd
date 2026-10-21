@echo off
rem Stub Codev IDE server shim (Spec 1658 Phase 9 tests): a plain .cmd, not npm-shaped,
rem so it runs through cmd.exe and the server is a grandchild of the spawn.
node "%~dp0stub-ide-server.mjs" %*

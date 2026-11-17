@echo off
rem Stub Codev IDE server shim (Spec 1658 Phase 9 tests), NOT npm-shaped: it
rem runs through cmd.exe, so the server is a grandchild of the spawn.
set "STUB_ENTRY=%~dp0stub-ide-server.mjs"
node "%STUB_ENTRY%" %*

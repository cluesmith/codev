@echo off
rem Stub Codev IDE server shim (Spec 1658 Phase 9 tests), npm-shaped: the shim
rem resolver runs node on the entry directly, as for a real npm install.
node "%~dp0stub-ide-server.mjs" %*

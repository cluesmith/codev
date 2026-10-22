# Plan iteration 2: responses

Verdicts: gemini APPROVE, codex COMMENT, claude APPROVE. All points accepted and folded in:
- Budget formula names every bound (version, install, stop-exit, ready) and doubles it for one queued lock wait; READY/STOP constants move into ide-version.ts to avoid an import cycle (codex, claude).
- Manifest helper split into an import-safe module (codex).
- Below-floor serverPath with a healthy live server: decided to fail the start, live server and record untouched; tested (claude).
- mkdir -p before vsce --out; artifact-canvas in the package job's build graph noted; floor-tie test asserts its manifest source (claude).

# Working on Alder

Alder is a reactive notebook for R. The next implementation target is
[dev/ARCHITECTURE.md](dev/ARCHITECTURE.md); development commands are in
[dev/README.md](dev/README.md).

- Edit files and use Git on the host. Run install, build, test, lint and app
  commands in `codex-universal`, mapping `/root/workspace/` to `/workspace/`:
  `docker exec -i -w /workspace/alder codex-universal bash -lc '<command>'`.
- Edit widget constructors in `R/ui-widgets.R`. Ark loads the installed
  package implementation; there is no worker mirror.
- After editing `js/src/editor.ts`, rebuild the committed CodeMirror bundle
  with `npm run build --prefix js` inside the container.
- Preserve generated R help and exports; their source is the roxygen comments
  in `R/`. Keep notebook examples runnable as ordinary R scripts.
- Prefer code and regression tests to prose. Comments should explain
  non-obvious behavioral decisions. Update existing docs when behavior changes;
  do not accumulate task ledgers, review transcripts or duplicate specs.
- Keep generated review evidence and Python caches out of Git.

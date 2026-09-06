# User-flow verification matrix

This matrix is the stable routing table for every full review cycle. The complete
test suite exercises the listed automated contracts; cycle evidence and specialist
reviews add visible browser, process, or rendered-file inspection. A flow is not
complete merely because its unit test passes.

| Flow | Automated contract | Required visible/cold evidence | Final v17 status |
|---|---|---|---|
| UF-01 Install | source build, installed-package load, `R CMD check` | clean isolated install transcript with R 4.6.1 and resolved imports | Pass — both complete cold cycles and mapped visible evidence |
| UF-02 First launch | `test-cli.R` launch/parser/help; browser loaded-cell suite | one `alder NOTEBOOK.R` process, ready browser screenshot, no interactive R | Pass — both complete cold cycles and mapped visible evidence |
| UF-03 Stop | CLI INT/TERM/HUP, API shutdown, idle timeout; worker stop tests | closed port and zero live server/worker descendants after each stop path | Pass — both complete cold cycles and mapped visible evidence |
| UF-04 Create/save | notebook byte/EOL tests; browser add/type/move, immediate keyboard save, manual/automatic formatted save; server save | edit-save-reopen source bytes and visible order; Save/Ctrl-S and optional autosave persist the latest acknowledged source, including a shortcut immediately after typing before the toolbar poll | Pass — both complete cold cycles and mapped visible evidence |
| UF-05 Reactive calculation | automatic Session/cache tests | upstream edit followed by visibly correct dependent output | Pass — both complete cold cycles and mapped visible evidence |
| UF-06 Lazy calculation | lazy Session/browser scheduling tests | visible stale badge then dependency-ordered requested result | Pass — both complete cold cycles and mapped visible evidence |
| UF-07 Recover from failure | structured-error and worker-recovery tests | error details, corrected source, clean successful rerun | Pass — both complete cold cycles and mapped visible evidence |
| UF-08 Conditions | worker/output tests; publishing condition tests | message and warning shown distinctly in editor and both reports | Pass — both complete cold cycles and mapped visible evidence |
| UF-09 Interrupt | pre/post-ack Session/unit/Chrome regressions | prompt Interrupted state, no late output, successful same-worker rerun | Pass — both complete cold cycles and mapped visible evidence |
| UF-10 Broad R syntax | full analyzer suite and scientific probe | representative base/tidy/formula/S3/namespace results; only bounded diagnostics | Pass — both complete cold cycles and mapped visible evidence |
| UF-11 Base plot | output/worker plot tests | inspected crisp base-graphics screenshot/artifact | Pass — both complete cold cycles and mapped visible evidence |
| UF-12 ggplot | browser/scientific plot probe | inspected ggplot before and after dependency change | Pass — both complete cold cycles and mapped visible evidence |
| UF-13 Data inspection | table page/sort/filter/copy/settings tests | visible rows/labels/settings under identical data | Pass — both complete cold cycles and mapped visible evidence |
| UF-14 Rich values | output, streaming, summary, htmlwidget tests | inspected summaries, Markdown, widgets, progress, ordered multiple outputs | Pass — both complete cold cycles and mapped visible evidence |
| UF-16 Widgets | constructor/Session/full browser widget suites | visible control and dependent output remain synchronized | Pass — both complete cold cycles and mapped visible evidence |
| UF-17 App mode | app model and browser app-view tests | output-only screenshot plus successful widget interaction | Pass — both complete cold cycles and mapped visible evidence |
| UF-18 Navigation | dataflow tests; movement/drag/navigator browser tests; native command probe | named cells, outline, usable DAG, keyboard movement, Ctrl-F cell search, variable filter/owner links, Ctrl-click definition, and References/Descendants links focus the correct source; unchanged/renamed polls and real reorder/add/delete preserve focused navigation nodes and graph scroll while updating current labels/order | Pass — both complete cold cycles and mapped visible evidence |
| UF-19 Editor assistance | LSP/path/hover/config/format contracts; native help, formatting, and diagnostic browser regressions | completion/signature toggles; full hover/F1 help with bounded desktop/narrow layout and keyboard scroll/dismissal; both formatting shortcuts; selection/focus preserved; manual/automatic formatted save; pending typing survives and only fresh acknowledged-source diagnostics appear | Pass — both complete cold cycles and mapped visible evidence |
| UF-20 Cache | cache identity/reference/corruption/reactive tests | deterministic 2→3 dependency probe produces 30, not stale 20 | Pass — both complete cold cycles and mapped visible evidence |
| UF-21 Environment | package/renv/sandbox/server responsiveness tests | standard lock/library files and surfaced install/restore failures | Pass — both complete cold cycles and mapped visible evidence |
| UF-22 Export | export/convert and real Quarto/Pandoc tests | inspect both HTML engines, provenance, conditions, code/output, source unchanged | Pass — both complete cold cycles and mapped visible evidence |
| UF-23 External source/test | `alder_source`, `alder_test`, CLI render tests | correct process status and cell-specific failure transcript | Pass — both complete cold cycles and mapped visible evidence |
| UF-24 Agent access | MCP schema/live Session/resource tests | add/edit/run/read flow and rejected invalid type through MCP | Pass — both complete cold cycles and mapped visible evidence |
| UF-25 Conflict safety | stale revision, browser conflict/tombstone, atomic save tests | both disk and unsaved browser versions remain recoverable | Pass — both complete cold cycles and mapped visible evidence |
| UF-26 Connection loss | worker-loss/restart and browser poll-error tests | stale output is labelled; failed Restart R retains outputs as stale, clears old inspections, permits edit/Save and later successful restart/replay | Pass — both complete cold cycles and mapped visible evidence |
| UF-27 Local security | origin/CSP/path/body/upload/shutdown-token tests | hostile requests rejected while same-origin browser remains functional | Pass — both complete cold cycles and mapped visible evidence |

UF-15 was deliberately removed with the dedicated SQL chunk surface under ADR
0019. Stable flow identifiers are not renumbered; ordinary database work is part
of UF-10 because it is ordinary R code.


Final sign-off: **all 26 active flows pass** for v17 archive SHA-256 `74878eb46a79dd41bbae470662c974270e0a7032a5df54a022c15db36ca4b444` (561,915 bytes). Independently verified caller restarts occurred at 05:59:56.674059973Z and 06:48:01.135637413Z on 2026-09-06. [Cold 1](evidence/release-completion/final-delivery-review/COLD-V17-1-REVIEW.md) completed at 06:46:22Z; [cold 2](evidence/release-completion/final-delivery-review/COLD-V17-2-REVIEW.md) completed at 07:33:40Z. Each has all 22 installed audits, 252 rehashed evidence files, 25 directly reviewed new actual images, full unfiltered installed/browser `R CMD check` Status: OK with 4,116 passes and zero other test outcomes, exact final source/driver/archive identity and strict resources/all 68 observed ports closed.

The accepted source evidence is the separately retained full current-product source/browser pass of 4,110 expectations/403 tests and the complete corrected MCP source file's 830 expectations/40 tests. Both are warning/error/failure/skip-free. No additional full v17 source-mode run is claimed; the only v16→v17 packaged delta is the single MCP test fixture and generated Packaged timestamp. Both final installed suites execute that exact corrected archive.

The [final flow evidence map](evidence/release-completion/final-delivery-review/FLOW-CLOSURE-MAP.md) routes every ID to its actual automated, public and visible evidence. The [current native command refresh](evidence/release-completion/final-delivery-review/B151-NATIVE-COMMAND-REVIEW.md) passes 34 checks with 12 directly reviewed images and current app/style/editor correspondence. Its exact source, selection, navigation and saved-file receipts supplement both full browser suites. B151's [247-expectation/eight-case permanent review](evidence/release-completion/final-delivery-review/B151-PERMANENT-BROWSER-REVIEW.md) and meaningful original/anchor-mutant evidence establish focus and graph-scroll retention during polls, renames and actual order changes. B137/B139 typing, formatting, immediate Ctrl-S and disk/conflict receipts, B135/B140 diagnostic provenance, and B136/B141 full desktop/narrow native help remain separately retained focused evidence.

UF26 includes the [failed-Restart recovery proof](evidence/release-completion/final-delivery-review/B144-FAILED-RESTART-REVIEW.md): exact retained stale outputs/source/revisions, cleared inspections, editable/saveable source and successful later restart/replay to fresh inspected y=9. The focused app/help/scientific-table and native command reviews are tied to current source/assets; neither cold is described as creating screenshots outside its actual 25-image plan. Intentional negative conditions, the surfaced upstream linter issue and B150–153 original-event qualifications remain explicit in the [final integration](evidence/release-completion/final-delivery-review/V17-FINAL-INTEGRATED-REVIEW.md).

This is a local Linux/R 4.6.1/Chrome release-readiness sign-off. Configured R-devel/Windows CI, native macOS and screen-reader execution are not claimed. The [pre-final matrix](evidence/release-completion/final-delivery-review/PRE-FINAL-user-flow-matrix.md) preserves its prior pending-state history.

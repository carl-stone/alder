# Alder task state

## Version-control follow-up

The user authorized committing and pushing the accumulated project changes.
Source, tests, documentation, examples and review scripts are included. Generated
`dev/reviews/evidence/` runs and Python bytecode remain local and are ignored by
Git; historical evidence paths below refer to those local records. Earlier
no-commit/no-push statements describe the validation checkpoints at their times.

## Completed follow-up: architecture specification and input latency tooling

The user has added pre-release console-like responsiveness requirements and
authorized the target architecture specification plus input-to-result benchmark,
tests and profiling. `dev/ARCHITECTURE.md` defines the TypeScript application
host, warm R services, contracts and migration gates. The host migration itself
has not begun. The implementation here adds opt-in measurement to the current
R host and trusted-browser benchmark tooling. The specification and measurement
deliverables are complete; responsiveness and correctness failures below remain
open product findings, not successful release gates.
Opt-in R spans now use the optional microbenchmark platform timer; the verified
Linux build uses CLOCK_MONOTONIC_RAW. Disabled tracing does not load it.

The earlier release acceptance below is historical exact-artifact evidence. It
does not establish the new median <=50 ms/p95 <=100 ms scalar interaction gates.
Baseline 04 uses `event.timeStamp`, retaining main-thread input queuing. It
finished with execution exit 1 after a completion HTTP 504 during long-notebook
edit-and-Run, also observed in Baselines 01 and 03. Its failed action, forced
fixture cleanup and partial results remain explicit; independent fixtures and
all seven separate profiling scenarios completed. The resource audit passed:
zero workloads/zombies/open observed ports. Completed samples have medians
524 ms (single Run), 634 ms (chain Run), 3500 ms (long Run; n=8), 5626 ms
(long edit-and-Run; n=7), and 162 ms (creation). No latency target is met.
Long edit-and-Run profiles show median summed evaluation of 17.8 ms and
state generation/encoding of 3925 ms; these inclusive spans are not additive.

The full [measurement report](dev/reviews/INPUT-LATENCY.md) links all evidence
and limitations. Baseline 04 artifact SHA-256:
`391b6f7856fde338f4d72c23ae77632b3086eae6ca39c8503280575b03bd82cd`.
Baseline 02 completed all 210 samples but used handler-entry timing and is
superseded for latency acceptance. Its old observer is retained. The packaged
runtime did not change during these browser/reporting corrections.

Validation 02 passed package/probe lint, syntax checks, four deliberate defect
controls and the budget-gate check (exit 3 with the same unmet-budget report).
Its full source/browser suite completed: 4,163 expectations across 407 tests,
4,161 passing and two failures, with zero errors, warnings or skips. Both failures
are waits in `browser source conflicts offer server recovery` (recovery control
and server source). The resource audit passed. Two isolated runs of that unchanged
test against the prior artifact and two against this artifact subsequently passed;
those replays do not explain or erase the original failures. Diagnostics and
comparison receipts remain in `validation-02/` and `conflict-comparison-02/`.

Final validation 03 passed seven observer tests, eight report tests, zero
package/probe lints, syntax/source correspondence and two additional report
mutations. Baseline 04 also passed all three installed tracing tests (16
expectations) and retained complete profiles. CI smoke coverage is configured;
remote CI and native Windows/macOS latency runs were not executed. No migration,
commit, push or publication was performed. No review workload remains active.

## Completed follow-up: representative long notebook

The requested roughly 1,000-line bulk differential-expression notebook is added
and tested: `dev/examples/bulk-differential-expression.R`, 1,262 physical lines,
1,016 nonblank/noncomment R lines, 65 cells (56 code, 9 Markdown), 190 DAG edges,
6,000 simulated genes and 24 samples. The full analysis is in the notebook.

The workload exposed state-poll performance problems. Session now caches source
reference ranges and their transport encoding while retaining exact decoded
state contents and invalidation on edits/ownership/structural changes. The
range-cache change passed 523 dataflow/Session assertions; final transport code
passed 421 dataflow/HTTP assertions, lint, both mutation checks and strict cleanup.

Installed run 07 passes all 32 scale checks: full-table/model parity with ordinary
R, all 18 plots loaded, 65 cells done after both runs (58.24 and 60.36 seconds),
threshold selection 501 → 33 without refitting (18.20 seconds), end-of-notebook
save preserving the other 64 cells, acknowledged save/reload retaining the edit,
and native shutdown. All final cell logs and captured browser channels are empty.
Strict final resources are clean; no test/app workload remains active.

[Full scale review and failed-attempt attribution](dev/reviews/BULK-DE-SCALE.md).
[Final result](dev/reviews/evidence/bulk-de-scale/run-07/result.json).
New artifact: `dev/reviews/evidence/bulk-de-scale/candidate-v19/alder_0.1.0.tar.gz`,
SHA-256 `af0884dc47cb7d25a1f585e8f8fe27fdce5149b998dc551dea4203996a3a9478`.
Compared with v17, package changes are only R/session.R, R/server.R, the dataflow
regression and NEWS.md, plus DESCRIPTION's build timestamp. This follow-up is
scoped validation, not another unfiltered release/cold cycle. The prior v17
release decision below remains historical exact-artifact evidence. No commit,
push or publication occurred.

Follow-up completed: 2026-09-06 14:08 UTC.
Prior release checkpoint: 2026-09-06 07:42 UTC.

## Release decision

**Alder 0.1.0 is accepted for its first complete release.** The requested
“marimo, but for R” implementation and release review are complete under
NORTH_STAR_RUBRIC.md. All four review cycles, both final cold cycles and all
26 active user flows pass. Forty final finding dispositions are reconciled;
no unresolved Critical or High remains. All 12 rubric criteria score 4/4 within
the observed first-release scope and documented limitations.

The large preexisting dirty worktree is preserved. No commit, push, package
publication or remote CI execution has occurred. No runtime work remains
active or needs to be repeated for this unchanged candidate. Final delivery
records are linked below; earlier failed runs remain failed evidence.

## Release artifact and authoritative review

- Package: `dev/reviews/evidence/release-completion/candidate-v17/alder_0.1.0.tar.gz`
- Size: 561,915 bytes.
- SHA-256: `74878eb46a79dd41bbae470662c974270e0a7032a5df54a022c15db36ca4b444`.
- Decision and all 12 final scores: [release review](dev/reviews/RELEASE-0.1.0.md).
- Fourth cycle: [integrated summary](dev/reviews/evidence/release-completion/CYCLE-4-SUMMARY.md).
- Current [flow matrix](dev/reviews/user-flow-matrix.md) and [finding ledger](dev/reviews/review-log.md).
- Independent [visual/delivery integration](dev/reviews/evidence/release-completion/final-delivery-review/V17-FINAL-INTEGRATED-REVIEW.md)
  and [runtime/API assessment](dev/reviews/evidence/release-completion/root/V17-RUNTIME-API-NORTH-STAR-ASSESSMENT.md).

## Final validation

| Gate | Completed result |
| --- | --- |
| Freeze/static/lint/build | v17: all passed; zero lints, deterministic editor bundle and exact source/archive correspondence |
| Full source/browser, identical product | v16: 4,110 expectations / 403 tests; zero failures/errors/warnings/skips |
| Complete corrected source test file | current MCP: 830 expectations / 40 tests; zero other outcomes and strict clean resources |
| First final cold | separate container restart 05:59:56.674059973Z; complete terminal 06:46:22Z; 4,116 installed assertions, zero failures/warnings/skips, R CMD check Status OK |
| Second final cold | separate restart 06:48:01.135637413Z; complete terminal 07:33:40Z; 4,116 installed assertions, zero failures/warnings/skips, R CMD check Status OK |
| Both fresh audits | all 22 phases, MCP 286/286 and five captured startups each; 252 evidence files and 25 directly reviewed new actual images per run |
| Identity and resources | all ten driver phases per run exit zero; source/current 32 audit inputs/seven drivers/archive unchanged; all 68 observed ports closed per run; zero workloads/zombies/new processes/listeners |

The source results are separate runs: no full v17 source-mode execution is
claimed. The sole v16-to-v17 package delta is one MCP test setup correction and
the generated Packaged timestamp; all product bytes are unchanged. Both final
cold checks execute the entire unfiltered installed/browser suite against the
exact corrected v17 archive. All 84 archive members correspond to current
source, with 83 byte-identical members and permitted DESCRIPTION build metadata.

Root independently read both complete test/check/terminal/resource receipts in
`root/V17-ROOT-FINAL-VALIDATION.json`. Both specialist reviewers independently
accepted the complete runs and current correspondence. Final Docker inspection
shows only its normal `sleep infinity` process. Exec55407 closed early, but the
actual second driver completed successfully; its durable terminal governs.

## Recent failure attribution

The nine failed cold attempts before v17 comprise one environment-setup failure,
three test/audit defects, one directly attributed product-performance failure,
and four original events whose causes remain unconfirmed. Separately,
investigation proved and repaired four product defects and the additional B153
test setup hazard. No droplet hardware/capacity cause is established.
See the [independent attribution review](dev/reviews/evidence/release-completion/root/FAILURE-ATTRIBUTION-INDEPENDENT.md).
Original B150–153 event causes remain qualified; controlled negative results
and lost-original-observation limitations remain preserved.

## Practical scope

Local validation uses Linux, R 4.6.1 and Chrome 152. The package floor is
R >= 4.6.0. R-devel and Windows CI are configured but were not run here; native
macOS and screen-reader execution are not claimed. Cold runs restart the
verified container and install Alder into fresh private libraries against
resolved dependencies; they are not repeated bare-OS bootstrap installations.
Trusted R executes with user permissions; reference mutation and external
side effects are not transactional. Deliberate negative-test conditions and
the visible upstream lintr failure remain explicit.

Everything below is retained historical execution/diagnosis state. Any older
active, pending or failed-candidate wording is superseded by this final decision;
its original failures and causal limits are not erased.

## Retained failed cold and repair history

Cold-v16-1-rerun1 FAILED at05-package-check, terminal05:36:13Z, exit1 and
resource0. Full installed suite:4098PASS/1FAIL/0WARN/0SKIP. Exact error:
`test-mcp.R:1234`, `local MCP set_widget settles with no consumers`,
`mcp_tool_payload(response)`: Argument 'txt' must be a JSON string, URL or file.
All22 installed audits passed, including286MCP;252 inventory files and25 actual
images independently accepted. Strict final has no workloads/zombies/new
processes/listeners, and all68 observed ports closed. Both successful final
cold cycles still required. Exactv16 archive/source/product/permanent tests held.

Root owns sole serial runtime. Agent outline prepares excluded10-case exact
original test AST with passive call_mcp_tool capture under root/mcp-widget-startup/;
root must inspect then run against exact installedv16. No test/product edits yet.
Final-delivery independently records failed terminal and pending B153 diagnosis.
Durable complete logs: cold-v16-1-rerun1/package-check/05-testthat.Rout.fail.
Original problem/partial logs retained root/mcp-widget-startup/live-capture-01/.
Source path hypothesis: process bootstrap already ready, but test sets timeout2
before first handshake; deferred notebook startup uses that2s budget. Startup
error could produce JSON-RPC-32603 without result/content, then payload parser
fails. Need actual raw response/startup condition before causal classification.
Other short timeouts in test-mcp.R deliberately test startup failure or fake
error states; this is the only actual widget case conflating startup and action.
Never weaken the2s widget-settlement contract. A correction, if evidence supports
it, should complete normal startup before applying the existing action budget.

Callerrestart53145 completedexit0/closed, changedStartedAt04:49:12.089031642Z
from03:42:07.273087279Z; root/cold-v16-1-rerun1-restart.json. Independent
B152-ACTIVE-INPUT-CORRESPONDENCE.json accepts32inputs/31unchanged vsB147,
onlyexcludedprobechanged; all83nonDESCRIPTIONmembers+normalizedDCF,7drivers,
currentnative3assetsandunchanged561866bytearchiveverified. No product/testdelta.

Guardedobservationprobe PROMOTED to active dev/reviews/probe-mcp-framing.R:
SHA13bc26539ed332e772f795ee801ce95601c590ff31035affd5db4c103150f04d.
OnlyexcludedauditprobeandAGENTSdocumentation changed; packagedv16/test/7driver
bytesheld. Activepromotion.json, active-promotion.patch,guard-only.patch retained.
Independentdeliveryaccepted negativeandguardedcode/promotion/reusefullsourceplan;
nowwriting B15232-inputcorrespondence (31unchanged vsB147). Capturedobservererrors
arefatalbeforeCOMPLETE. Originalstartupcauseunconfirmed; don'tclaimcodefixforit.

Deliberateearly-exit1complete: probe_exit1(expected), negative_validation0/resource0.
Sameobservedclone/local109pass, oneprocess_dead exact73/34bytestderr, PID34620,
port21367closed, unchanged60sdeadline,zeroobservererrors,strict0. Exec5094closed.
Bothrootandindependentrevieweracceptedactualfailedboundaryanddurablesource/pipes.

Previous observed full replay1 PASSED286/286, main/resource0/0, exec11036closed
and actual Docker onlysleep before currentlaunch. All5startupboundaries ready
in5.746–6.450s;549HTTPrecords=544pre-ready connection failures+5healthy200states,
exact URL stdout/empty stderr, fullsourceidentity andzeroobservererrors. Full
independent review accepted records and5closedports. Originalcauseunreproduced.

Observedclone SHA73a7b4c8ace3a33fc588fcce11c134546bd21a5143295da9a1a22192e2521d6c;
original/active SHA d57300da8be3c63d207b5eb056eccc3a10ad028e320394dbe165340cdb693c03.
All286 original assertions/60s deadline/CLI/pipes/HTTP predicate remain. Root and
independent delivery reviewer read actualdiff/inversedeltaproof. Before promotion
to active excluded audit probe, add uncaught startup_observer$require_clean()
just before final COMPLETE line, so captured observer errors cannot pass. Agent
outline recommended exact small closure method in OBSERVATION-CLONE-REVIEW.md.
No activeprobe/product/permanenttest change yet. Neednegativecaptureacceptance,
guardedactiveprobereview/new32inputcorrespondence, then bothfreshsamev16colds.
Current exact fullsource4110/403 remainsvalid forheldv16; additional source-mode
repeat may be omitted for observer-only excluded harness changes, subject to
independent correspondence. Full installedbrowser/packagecheck mandatoryeachcold.

**Cold-v16-1 FAILED in installed audit phase 22.**
Actual terminal 04:25:04Z: status failed/exit 1/main false, failed phase
04-installed-audit; strict resource exit 0, all 62 observed ports closed,
no workloads/zombies/new processes/listeners. Docker top confirms only sleep.
Handle 75707 had closed early; actual terminal and process tree now confirm exit.

The full unfiltered source/browser suite PASSED: 4,110 expectations / 403 tests,
zero failures/errors/warnings/skips (03:45:31–04:13:52Z), with exact source
verification at 04:13:56Z. Installed phases 01–21 passed and all 25 actual PNGs
were directly independently viewed; final visual/channel report is finishing.
Phase22 prints 109 local framing PASS lines, then `loopback Alder server did
not become ready` / `Execution halted`. No URL framing, full package check or
later identity gates completed. Finalization is retained, not a successful cold.

The original phase22 start_server() loses child stdout/stderr and caught HTTP
errors when startup fails, so this run does not distinguish child exit, timeout
or HTTP failure. Cause remains unknown. Agent outline_navigation_review is
preparing an excluded observation-only exact-probe clone under
root/mcp-startup-recovery/, preserving all 286 assertions, 60-second deadline,
CLI args and requests. Root inspected the actual clone/delta and launched the serial replay above. No
product, permanent test, active probe or driver change is authorized yet. Both
successful final cold cycles remain required. Current full-source pass remains
valid for held v16; do not repeat it unless a product/test change requires it.

Freeze-v16 completed main/resource 0/0; exec 17973 closed. Caller restart 57401
completed exit 0 and closed, changing StartedAt to 03:42:07.273087279Z from
02:33:06.952108257Z. Receipt: root/cold-v16-1-restart.json. Current evidence:
cold-v16-1; separate fresh audit root: /tmp/alder-cold-v16-1. Do not overlap any
runtime or restart while this workload is alive. Root owns the runtime slot.

Candidate-v16/alder_0.1.0.tar.gz is561866bytes,SHA256
5d140f5c6d4f388f2b82676c76fcbb7d5ec0b4a7c8348e3dc1ccc6fa1dd2d19d.
Freeze-v16static/lint/editorrebuild/build/sourceidentitystrict0pass:84regularfiles,
83byteidentical+normalizedDCF; sameeditor21cd... . Sourcetestappheldbelow. Rootgit
diff--checkclean. Independent archive/current-native/32-input/seven-driver review accepted. Disk 5.2GB free after first full source; monitor after full check. No successfulcoldyet.

permanent-after1 COMPLETE247expect/8tests,zeroerrors/failures/warnings/skips,
main/resource0/0, singlefilelintnolints, exactselectedASTcopies andheldinputchecks.
Exec46538closed/Dockeronlysleepbeforefreeze. New3regressions159assertions plus
originaloutline/graph/drawer/drag/gutter; helpers/originalprefixunchanged. All8
actual final PNGs/state/channels independently reviewed and accepted.
AppSHA df4e4aeca26a0053bf5fb117c108667920df8254628c4ec8d8945ee6980f712d.
PermanentbrowserfileSHA28c0396c1bfee8cb77913726d7f4f4687b9bf633aae34eee3db9506f23d3c8a8.

Correctedordergrid COMPLETE:before68expect/13specificfocus-nativefail→fixed67/67→
anchor-mutant68/6specificfail; zeroerrorswarnskip andstrict0allthree. Exec16369closed.
IndependentexactexpressionSHA958ced..., solechangedassetamong33installedpaths,
all18actualPNGs/15fullboundaryJSONsreviewed. Mutantpreservesidentity/currentorder
butlosesfocusafteractualmove/add/removeother, nativeEnterabsent. Correctedprobes
nowarepermanentthreevalidatedexpressions (positive23+69+67=159).

Native-current1 COMPLETEwholeexactprior34PASS, probe_exit0/audit_exit0, exec72618
closedbeforecurrentgate. Freshcurrentprivate /tmp/alder-b151-native1/lib, exact
probe9b8528e... andthreeassetSHAsretained. FinaldeliveryacceptedALL12actualnewPNGs/
state/nativeevents/channelsandrefreshedassetcorrespondence. Allserver/browser/R
channelsindependentlyaccepted:105requests/103responses(102x200+shutdown202),
2matchedcanceledhoverERR_ABORTEDexplicitlyacceptedbyunchangedspecificclassifier,
68trustedevents,3exactsourcefiles,12editor/publicsnapshots;zeroUNEXPECTEDconditions. Nooverlapruntime.

Ordergrid1 stoppedafter1,13543closed, mutant1neverrun. Before67expect/25fail;
after66/12fail,allzeroerrorswarnskip/strict0. The12sharedfailurescamefromwrong
fixtureassumption:add(after=NULL) appends, move(after=NULL) meansfirst. Actual
UIorder matchedAPIthroughout; fixedidentity/focus/nativeEnter/deleted-target
checksallpassed. Correctedfixtureexplicitlymovesnewlyadded/namedcellfirstbefore
checkingitsnewfirstorder;allpreviousassertions/nativeinputs/deadlinesretained,
addsoneHTTP200assert. Agentauthornote+independentreviewretainattempt1correctly.
MutantassetreplacesexactonefocusedfindIndex with-1; privatepackageinventory
verifiesonlyapp/static/app.jsdiffers. Thisfalsifiesnewfocused-anchorbranch with
actualmove/add/removeandnativeEnter contracts, neverchangesproductfornegative.

scoped-after1 COMPLETE23/23outline +69/69siblings,0errorswarnskip,main/resource0/0,
innerstrict0,exec42116closed/Dockeronlysleepbeforegrid. Exactsource/privateappcmp
andinputafterhashespass. Everyactualsiblingboundaryretainsconnected/current/focused
TRUE; graphscroll100→100, shared-ownerx/yreferencesintact. Rootandpatchauthorread
actualresults; finaldeliverynowindependentlyreviewsactualafterPNGs/state/source.
App heldSHA df4e4aeca26a0053bf5fb117c108667920df8254628c4ec8d8945ee6980f712d.
AgentimplementedscopednavigationDOMreconciler withstablekeys/unmovedfocusedanchor;
AGENTS/NEWS/UF18updated. Independent source reviewfoundnoblocker. Permanenttests
unchangeduntilallbefore/after/neworderfalsifier accepted. Excludedprobesretained.

siblings-before1 COMPLETE69expect/19assertfail,0errorswarnskip,main1/resource0,
exec69468closedbeforecurrentafterlaunch. Allsix(variableowner,dependencyreference,
graphtoolbar,SVGnode,graphscroll,minimap) originalnodesconnected/current/focused
TRUE→afterordinarypollallFALSE/activeBODY; graphscroll100→0. Duplicate-ownerx/y
references/currenttextchecksallpass.12actualPNGs+boundaryJSONs/finalstate/pipes;
independentreviewerinspectsactualimages. Frozenv15privatebeforeinstallretained
at/tmp/alder-outline-before1/lib; productmaynowdifferonsourcebutbeforeproofuses
exactfrozenv15. Nooverlapruntime.

Priorpoll-before1 COMPLETE25expect/10specificassertfail,0errorswarnskip,main1/
resource0, exec6981closed. Sixpublicboundaries proveunchangedversion7focusedoutline
nodeconnected/current/focusedTRUE→sameversion7allFALSE/activeBODY; noEnter. Real
renameAPI200changesversion8/currentlabelresult_updated, oldnodefalse/BODY,noSpace.
Workeravailableidlethroughout. Actualpollresponsegateunmodified; thisconfirms
realpollfocusdefect, thoughoriginalfullrunsparsetracecannotprovedirecttiming.

Rootauthorized outline_navigation_review toimplement smallest systemicrenderer-
scoped keyedDOMreconciliation ininst/app/static/app.js andAGENTS/NEWS afterexcluded
siblingprobe ready. Productmaynowchange WHILE frozenv15BEFOREmatrixruns; ituses
onlyprivateinstalledbeforeproduct. Testhelpers/permanenttestsremainhelduntilbefore
matrixends. Agentmustpreserveunmovedfocusedanchor, explicitstablekeys/collisions,
currentlabels/status/geometryandgraphscroll; existingdelegatedhandlersretained.
Do notappendpermanenttests untilsamebeforeexpressionscompleteandafterproven.

Cold-v15-1 FAILED at fullsource:3952 expectations/400tests,3assertionfailures,
zeroerrors/warnings/skips. Source02:36:10–03:04:10Z; strictfinal0 at03:04:11Z,
38observedportsclosed, no workloads/zombies/newprocess/listeners. Actual terminal
mainfalse/source_requestedtrue/failedphase02-source-suite/artifactSHA305c... .
Exec85820closed; Dockeronlysleep before laterprobe. No installedaudit/check/visual
phase was reached. Original trustedslidercase and newB15031+19 regressions have
no failures in thisfullsource; do not turn that into a successfulfullgate.

Allthree failures in test-browser.R 'browser outline handles trusted Enter and
Space once' lines2390–2453: Enter and focusedthirdlink checks pass, then native
Space never reachespanel listener; line2439waittimeout, line2444events onlyEnter
vsEnter/Space, line2447navigationonlycell2 vs2,3. Exactcauseoforiginalfailure not
yet proven. Source shows everyrenderDataflow call rebuilds outline buttons,
variablesowners/dependencies/graphcontrols/minimap; ordinary800mspoll can detach
focusedcontrol. New outline_navigation_review agent has source diagnosis and
proposes keyed scoped DOM reconciliation with an unmoved focused anchor, avoiding
indexidentity/reinsertion that blurs. ROOT MUST FIRST READ actualprobe beforepatch.

AllB151 evidence: dev/reviews/evidence/release-completion/root/outline-navigation/.
app.js.before-B151 and test-browser.R.before-B151 preserve exact originals.
original-before1 PASS40/40 across five exact original native case repetitions,
zeroother/observererrors, main/resource0/0, exec58313closed. Freshfrozenv15private
installation /tmp/alder-outline-before1/lib; exactapp.js cmp. Passive capture
capturesdocumentfocus/keyevents, panelmutations and stableweaknodeIDs, channels,
matched completedstatebodies+explicitboundarygaps, finalpublicstate/PNG/pipes.
No midactionRcaptures/refocus/nativeinput/assertion/deadline changes. Fiveisolated
passes do not erase the actualfailedfullsource. final_delivery_review nowinspects
allfiveactualPNGs/ASTs/captures. Sourceagent prepares excluded siblingpanel focus
matrix usingrealpollgate to observe analogouscontrols before systemicpatch.

Agents now: outline_navigation_review owns EXCLUDEDprobes/sourceanalysis only;
final_delivery_review owns independentreviews/ledger/flows/images. Rootownsruntime
anddocs. barrier_recovery_review could not resume dueagentthreadlimit; finaldelivery
explicitlyattributed finalv15runtime terminal reviewin its formerdraft. Package/test
files mustremainhelduntilbeforeevidence/patch authorizationfromroot (useralready
authorizesactualfixes). No runtimebyagents.

## Retained current v15 freeze and B150 acceptance

V15 frozenarchive candidate-v15/alder_0.1.0.tar.gz is556816bytes,SHA256
305c736b0a32cf15c2043e67aa211d7aa260d8372694babb1bbe884327a4ad0b.
Freeze-v15 passesstatic/lint/build/source/strictresources0/0,84regularfiles,
83byteidentical+normalizedDESCRIPTION. Independent V15-REVIEW.md and archiveJSON:
onlyworker/bootstraptest/NEWS/Packagedtimestamp differfromv14; all32activeaudit
inputs andthreefrontendassets unchanged. Nativecorrespondence frozen-v15-native-assets.json.
Callerrestartroot/cold-v15-1-restart.json:started02:33:06.952108257Z,exit0before
coldstart02:34:53Z; restart2073closed. No successfulfinalcold yet.

B150 workerSHA b2fb85cfd8c2750d02c2ee49f0b5a7f62d3e88548a4f9feed378767ca924434c.
BootstraptestSHA bdec9d9af86d5c979e3fb16869a4e8998f6f91fdf5bf1df789eace7974ac5e3c.
Loopdefersnativeinterrupts inprotocolwork, guardsidleread/eval, separatelyignores
idleinterruptvsEOF, drainsobsoletependingSIGINT atguardedrealcheckpoint beforedispatch.
Corrected sleep-free permanentbefore31/13fail →final31/31→no-drainmutant31/4fail;
allzeroerrorswarnskip/strict0. Final standalone17/17; rawno-drainmutantfresh43
retainsfullInterruptedpayload whileworker/otherresponsespreserved.
PureR activeStop19/19; removeevalallowmutant19/5specificfail, noerrorswarnskip,
4.1s successfuloutputinsteadoftimelyInterrupted; sameworkerfresh42recoverystillpasses.
Focused1 fivecompletefiles745/78zeroother, currentprivateinstall/heldsource/strict0.
Detailed-after1 current-installed originalslider85/85fivecases, zeroR/JSobserver
errors/strict0; independent16actualviews/60boundaryJSONs/20POST202/194matchedbodies.
Fivepreobserverstatebodygaps/twopendingordinarypollsatcutoffexplicit. Fullv15source
hasnofailures intheseB150cases. Originalv14slidercausallinkremainsunconfirmed.

AllB150attempts/failures/harnesscorrections/sourceRinterruptdiagnosis andscoped
independentreportsretained in root/trusted-slider-recovery andfinaldelivery.
EarliernonzeroSys.sleepgap observerconfoundedafter1 (R_SelectEx overridesinterrupt
suspension); correctv2removesonlychildnonzerosleep. FirstCPUrunneromittedfile-local
bootstrap_eval, correctedbyexacthelperASTextraction; preserved0assert/1setup-error.
Currentrunners/resultsnevermislabelthesenegativeattempts. Detailedcheckpointat
release-completion/task-state-B150-before-B151-20260906.md.

## Retained v14 and previous full validation

candidate-v14/alder_0.1.0.tar.gz is554,390bytes, SHA-256:
a9b180e93834e3f9beec5366dfabe414de2249549484f77f9bff345783d93142.
Its freeze static/lint/build/source identity passes:84files,83exact plus normalized
DESCRIPTION. It differs from v13 only in two corrected packaged subprocess tests
and DESCRIPTION Packaged timestamp; product bytes were identical then. B150 now
requires a successor freeze; v14 is retained as before evidence.

Exact-v13 full source/browser suite:3,901 expectations/398tests, zero failures,
errors/warnings/skips. Corrected complete v14 subprocess source files:314/21,
zero other outcomes; real focused installed check314PASS/StatusOK. B149 worker
library bootstrap falsifier54/54positive→intendedworkerfailure→freshpositive,
strict0. Separate source scopes were accepted for v14's test-only delta; do not
claim a full v14 source run or carry that composition across the new worker fix.

cold-v14-1:independent restart00:40:40.572496386Z, driver00:41:15Z. All22installed
audits (262publishing/286MCP),227inventoryfiles and25directvisuals pass. Full
check00:55:23–01:26:40Z fails3895PASS/10FAIL/0WARN/0SKIP in the slidercase.
Strict finalresources pass01:26:41Z; mainfalse/resource0, failedphase05-check;
post-check identity gates not reached. Exec28633closed. This is a failed cold.

Earlier v13cold attempts are also failed, preserved evidence: missing review-only
DuckDB, obsolete full parser message/audit-count expectations, MCP ordinary-error
fixture assumptions, then installed-context subprocess test roots/library paths.
Those B145–149 fixture/environment corrections are reviewed and pass scoped and
subsequent complete installed audits/check portions. B148/149 pass in v14 full
check. No previous failed cold counts as success. Product fixes through B144 and
native editor34/34review are indexed in the release report/ledger. Actual advanced
native frontend assets are unchanged throughv14 and independently SHA-matched.

## Remaining work

1. Freeze-v16passed andcallerrestart57401closed. Independentfinaldeliveryfinishespermanent8screens/
   ASTreviewthen successorarchivevsV15,currentnative12assetcorrespondence and
   all32heldauditinputs. Native34currentandallfocusedbefore/fix/mutantaccepted.
2. Callerindependentcontainerrestartwithroot/restart-container-for-cold.py;
   thenfirstcold-v16-1 onexactfrozenSHA with--source-suite, freshcold/private roots,
   belowone tinitree. Fullcurrentunfilteredsource/browserrequiredagainbecause
   app.jshaschanged; failedv15sourcecanonlysupportscopedunchangedruntimefacts.
3. TWOcompletecoldsonSAMEfinalarchiveafterseparatecallerrestarts, eachall22audits,
   fullinstalledR CMDcheck/browser,25newactualimage/state/channelreviews, exact
   source/archive/driver/activeinputcorrespondence, strictzeroresources/actual99
   passed. Secondmayomitonlyoptionalextrasourcerepetition. No partialpasscounts.
4. Close all26flows/eachpendingB83–151ledgerrow and12NorthStarscores/fourthcycle/
   release report onlyafterbothactualsuccessfulcoldsandindependentreviews. User
   askedcompletion, notpartialreport. Continueuntilactualfirstreleasequality.

## Execution and environment

Edit/Git on host. All install/build/test/lint/app commands run only through:
docker exec -i -w /workspace/alder codex-universal bash -lc '<command>'
Map host/root/workspace to container/workspace. Use one long-lived tini -s through
final strict observer. Never run overlapping R/Chrome gates. Tool handles may
expire early; inspect actual processidentity and terminalreceipts before restart
or newgate. Observers do not kill unrelatedworkloads. Preserve failedattempts.

Containerf1dc274eb26369d5faa5982923627f990ea2c1069d772179edaeb7514e909a3a.
Ubuntu24.04.4,R4.6.1,Chrome152.0.7977.82,Quarto1.10.18,Pandoc3.1.3,
Node20.20.2/npm11.4.2,tini0.19,ShellCheck0.9,Python3.12.13.
105 restored R dependency versions and39namespaces verified; DuckDB1.5.5 official
recommended PositManyLinuxbinary added and actualDBIa3/b4 verified. Toolchain
backup alder-release-toolchain:2026-09-05-duckdb digest
sha256:d5c66166794f3a51ee189cf7cc8b9d127aceb0caa45c230a0c549635feabd3c4.
It excludes workspacebind; no newimage needed for source changes. Cold means
independentcontainerrestart+freshprivateAlderinstall with verifieddependencies,
not bareOSrebuild. Latestdisk~6.8GBfree; monitor occasionally.

Rfloor4.6.0, localR4.6.1. R-devel/nativeWindows CI configured, not executed here.
Cycles1–3historical evidence must not be relabelledstrictzero: cycle3 had941
unchanged preexistingzombies. Finalstrictgates requirezero. TrustedRcode executes
with userpermissions; external/referenceeffects are nottransactional. Static
restrictions remain bounded/documented. No suppressed conditions or arbitrarybans.

Earlier detailed checkpoint retained at
release-completion/task-state-before-B150-consolidation-20260906.md.

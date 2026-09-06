# Alder user flows

These flows describe externally observable work a scientist or package maintainer
must be able to complete. Add flows when functionality is added; remove one only when
the underlying feature is deliberately removed.

## Installation and launch

- **UF-01 Install:** Install Alder from a source package into a clean R library with
  declared dependencies resolved and no installation warnings; install the
  platform-appropriate `alder`/`alder.cmd` command atomically on Unix or Windows.
- **UF-02 First launch:** Run one `alder` command for an existing `.R` notebook,
  receive a usable browser session, and see every source cell without changing
  the file or manually starting an interactive R process/server. Passing a new
  `.R` path must be announced and create the file only on the first Save.
- **UF-03 Stop:** Interrupt or terminate that command, including while a browser
  request is active, and leave no Alder worker/server process; after browser
  loss, atomically save acknowledged edits before automatic shutdown and pause
  visibly on conflict; programmatic R start/stop remains available as an API.

## Editing and execution

- **UF-04 Create and save:** Launch an announced new notebook path without creating
  an empty file, add R and Markdown cells, save it for the first time, reopen it,
  and recover identical source, cell ordering, and metadata. Save, Ctrl-S
  (Cmd-S on macOS), and optional autosave must persist the latest acknowledged
  edits. The save shortcut must also work immediately after typing, before the
  next state poll enables the toolbar button. Enabling Format before saving
  must keep visible and saved source in sync.
- **UF-05 Reactive calculation:** Run an upstream cell and observe dependencies run
  once in dependency order with downstream output matching visible source.
- **UF-06 Lazy calculation:** Switch to lazy mode, change an upstream cell, observe
  descendants become stale, then request a descendant and see stale ancestors run.
- **UF-07 Recover from failure:** Run code that errors, see the complete actionable
  error, correct it, rerun, and obtain a non-busy consistent notebook.
- **UF-08 Conditions:** Run code that emits messages and warnings and verify neither
  is suppressed, mislabelled, or lost after reruns.
- **UF-09 Interrupt:** Start a long calculation, activate Stop, observe prompt
  cancellation, and successfully execute another cell afterward.
- **UF-10 Broad R syntax:** Run representative base R, functions, formulas, pipes,
  namespaces, S3 objects, and tidy-evaluation code unless a precise safety diagnostic
  explains a necessary static-analysis restriction.

## Scientific outputs

- **UF-11 Base plot:** Produce and layer a base graphics plot with calls such as
  `plot(); abline(); legend()`, preserve multiple independent plots in one cell,
  and inspect crisp visible images.
- **UF-12 ggplot:** Produce a ggplot2 visualization, rerun its data dependency, and
  see the updated plot without duplicate or stale output.
- **UF-13 Data inspection:** Display a data frame/tibble, paginate, sort, filter,
  search, inspect columns/missingness, and export or copy useful data.
- **UF-14 Rich values:** Display model summaries, HTML widgets, Markdown, multiple
  outputs, and streaming progress with accurate ordering and final state.

## Interactivity and app delivery

- **UF-16 Widgets:** Create each supported widget, including named widgets nested
  inside hstack, vstack, tabs, accordions, callouts, sidebars, and resolved lazy
  outputs; change it and observe its value, dependent cells, validation, and
  displayed control remain synchronized. One-shot controls must reset, unlock,
  and work again without replacing a focused continuous control during state
  polling. Multiple tabs and accordions must expose unique linked controls and
  panels with selected/expanded state matching what is visibly open.
- **UF-17 App mode:** Open app mode and see notebook outputs/widgets in order with code
  and editor-only controls absent; interactions must still update outputs.
- **UF-18 Navigation:** Navigate a large notebook through its outline, named cells,
  navigator, Dataflow graph, and keyboard cell commands. Search the current cell
  with Ctrl-F (Cmd-F on macOS), filter variables, and follow a variable owner,
  References or Descendants link to the correct source cell. Ctrl-click
  (Cmd-click on macOS) a reactive reference to focus its definition. State polls
  must preserve focused navigation controls and graph scrolling while showing
  current names, values, status, ordering and graph geometry.
- **UF-19 Editor assistance:** Use RStudio-like tab completion, toggleable
  completion and argument/signature help, and native R hover documentation.
  Open and focus full help with F1, scroll long help within its panel,
  and use Escape or Close to return to the source. Ordinary state polling must
  preserve requested help; Escape, source/cursor changes and focus loss must
  cancel pending help without reopening it or stealing focus. Preserve readable
  headings, argument tables, and code examples within desktop and narrow layouts.
  Format the focused cell using Ctrl-Shift-F or Ctrl-Alt-F (Cmd replaces Ctrl
  on macOS); preserve selection content/direction, focus, cell boundaries, and
  metadata. Subsequent typing must use the acknowledged formatted revision,
  newer typing must survive a pending formatting request, and a genuine
  external edit must remain a visible conflict. Format before saving applies
  to manual Save and optional autosave. Keep Alder parse/safety diagnostics
  visible while continuous lintr notes remain off unless explicitly enabled;
  displayed cell and document notes must describe the acknowledged visible
  source. Clear obsolete notes while edits are pending, and restore only fresh
  notes after acknowledgement, retry, or recovery.

## Reproducibility and interoperability

- **UF-20 Cache:** Cache an expensive computation, reuse the valid result, invalidate
  it after relevant source/input change, and recover safely from cache corruption.
- **UF-21 Environment:** Inspect package requirements, create/restore an environment,
  and receive surfaced package-install errors rather than silent failure.
- **UF-22 Export:** Independently render through knitr-backed Quarto and direct
  Pandoc paths, plus supported R/HTML forms, and verify each result is readable,
  ordered, reproducible, and does not mutate the notebook. Both engines execute
  enabled cells once in dependency order while preserving authored display
  order, and exclude disabled cells and their transitive descendants. Reject direct,
  canonical, symlink, or hard-link input/output aliases before execution, and
  preserve any existing destination when execution or serialization fails.
  HTML and Markdown retain console output, conditions, and appended results in
  execution order; session JSON retains structured cell logs and error details.
- **UF-23 External source/test:** Source or test a notebook non-interactively,
  exclude disabled cells and their transitive descendants while running
  independent cells, execute setup and marked test cells exactly once in
  dependency order, and receive correct output plus a failing process status
  for errors or unexpected warnings.
- **UF-24 Agent access:** Inspect/edit/run cells and query state/diagnostics through
  MCP while preserving the same correctness and security rules as the browser,
  including exact nonnegative-integer source revisions without lossy coercion.
  Reject stale variable-value inspection after invalidation and restore it only
  after the defining cell reruns; labelled historical cell outputs remain visible.
  Reject ambiguous duplicate keys anywhere in a bounded raw stdio request before
  tool dispatch, preserve state, and continue with the next valid request.
  Correlate every request with an exact scalar string or safe-integer ID, reject
  invalid IDs and method parameters before effects, and require complete MCP
  initialization negotiation. Execute valid JSON-RPC notifications without
  writing a response, while rejecting ID-bearing notification-only methods.

## Safety and resilience

- **UF-25 Conflict safety:** Detect an external file change before saving and preserve
  both the on-disk work and unsaved browser edits.
- **UF-26 Connection loss:** Surface server/worker disconnection, reconnect or restart
  safely, and never imply that stale output is current. If Restart R fails,
  retain prior outputs as stale, clear old inspected values, keep source editable
  and saveable, and recover on a later successful restart.
- **UF-27 Local security:** Bind only to `127.0.0.1`, `localhost`, or `::1`; reject
  non-loopback `--host` values until a real authentication design exists. Treat
  `--allowed-origin` as an exact browser-origin control, never authentication or
  network sharing. Reject hostile origins, traversal, oversized requests, and
  malformed input while ordinary loopback use remains functional; strictly
  validate and bound client log reports and normalize each to one physical record.
  Apply equivalent bounded UTF-8, structural-complexity, and duplicate-key
  validation to line-delimited MCP input before either local or URL dispatch.

# Alder release-quality task

## Task

You are the lead developer, project manager, and final quality owner for this project. Perform all actual work, either yourself or delegating to subagents; do not answer with only a plan or incremental step. The user will be likely be unavailable. Make conservative, reversible assumptions, record them, and continue. Configure the development container as necessary, installing any programs, libraries, or packages common to a project of this nature. Stop only for credentials, potentially destructive external actions, or an ambiguity that cannot be resolved without materially changing the authorized project. Continue until every explicit quality gate is satisfied, not merely until functionality is improved or an alpha build is nominally completed.

## Environment

Before committing to implementation, thoroughly inspect this repository, the droplet environment, and the codex-universal container. Missing libraries must not become blockers; any R package or necessary packages may be installed on the droplet or into the codex-universal container. Thoroughly read the codex-universal documentation to correctly configure it. Keep all ‘alder’-related code in this ‘alder’ repository. Record this prompt into a file called ALDER_TASK.md. Keep a file called TASK_STATE.md to record completed work, the worst current problems, and next actions. If context is compacted or work resumes later, read ALDER_TASK.md and TASK_STATE.md then continue from instruction in there rather than continuing blindly. Keep TASK_STATE.md carrying the last successful commands and task output evidence, known failures, and the current status of the task—as judged by final quality criteria—so any future session can resume mid-flight.

## Review loop

Use the list of user flows and test suite for reviews. Perform at least four full cycles of

> build or change -> complete user flows -> inspect outputs and evidence -> diagnose -> fix -> inspect outputs and evidence under identical input conditions -> run full test suite

Criticism must be based on visible outputs, not code or the worker’s summary. For each finding, record the evidence, severity, affected subsystem, likely root cause, and an actionable correction. Repair systemic issues before isolated polish.

Use fresh-context specialist subagents to review. If it does not exist, create a file called SUBAGENTS.md with the personas of subagents, including their 1-5 line prompts and recommended models for each. As an example, start with a front end subagent and a backend subagent. Subagent identities may evolve as the project progresses: modify subagent prompts if failures arise clearly due to their instructions, and create new subagents or split subagents into sub specialists as infrastructure builds.

## User flows

Generate a file called USER_FLOWS.md if it does not already exist. Record short and precise descriptions of flows that real users would experience. Consider how a scientist may need or want to use this program. Flows should be added over time as functionality is added. Flows may be removed only if the underlying functionality is deliberately removed.

## Cold-start completion validation

Before declaring completion, save all files, close any current development processes, build the project, and execute the full review loop twice. Confirm that all dependencies resolve, no errors occur, and no warnings occur unless they are unavoidable package interactions.

## Documentation and design

The only permanent rule is the North Star. All other ADRs are subservient to the North Star. Use your best judgment to make decisions, including superseding ADRs if necessary. If an existing framework or decision conflicts with the North Star, remove it or supersede it. Generate a rubric of criteria necessary to assess your adherence to the North Star. Use the rubric in all subagent reviews.

## Project brief — Alder: a modern reactive R notebook

### 1. Project objective

Create a reactive R notebook for scientific coding and data analysis. The design North Star: What if marimo had originally been designed from the ground up to focus on R? Complete all necessary steps to make this an installable R package and software suite. This is not a prototype or proof of concept; it must be a functioning R notebook application that real scientists can use to do safe, stable, accurate, and reproducible R analyses. The goal is the same level of maturity as existing notebook formats like Jupyter and Quarto. The visual target is elegant, friendly, authoritative, and polished style of modern notebook frameworks.

### 2. Scope

Marimo is a reactive notebook designed for Python programming. In the same manner, Alder must be a reactive notebook designed for R programming. Any more or less than that is too narrow or too broad. Alder must allow as comprehensive R programming as is possible given the few complexity constraints necessary for static code analysis; all constraints imposed by static code analysis must be as minimal as possible, and they must be reevaluated at project milestones to see if any can be removed. Alder must allow widgets but must allow standard R plotting methods, including ggplot and other libraries, to display plots similar to Quarto or Jupyter notebooks. The visual style of chunk execution and output should be similar to Quarto notebooks.

### 3. Technical organization

Alder must be easy to install and launch for regular R users. It must include clear and concise documentation for installation and use.

### 4. Critical failures

The following conditions make the final product unacceptable:

- suppressed or ignored errors or warnings
- buttons that do not react upon interaction
- an arbitrary line of R code is disallowed from running except for carefully bounded restrictions necessary for static code analysis

## Subsequent product direction — 2026-09-02

Recorded from the user while the cycle-1 full suite was running. These items are
requirements to integrate into the existing priority order; they did not cancel
the active quality gate.

- User-facing SQL chunks are a non-goal unless there is a compelling reason for
  them. Backend SQL is not constrained. The current implementation has no
  indispensable reason to expose a special SQL cell because ordinary R code can
  use DBI/dbplyr, so the user-facing SQL surface is scheduled for removal.
- An Alder notebook must launch with one command that owns the notebook and its
  backend lifecycle. Starting a server manually from an interactive R process is
  not an acceptable primary workflow.
- Editing should feel like RStudio: regular R tab completion and argument/signature
  help are required, and the assistance must be toggleable in settings.
- Rendering/export must offer a knitr-backed Quarto path as well as a direct
  Pandoc path.
- Alder must not impose continuous lintr notes or style diagnostics on user
  code. Linting is a user choice, not a mandatory notebook service. Language
  assistance may surface R parse/language-server diagnostics, but any lint
  integration must be explicitly opt-in and independently disableable.

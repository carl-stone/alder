\name{alder_render}
\alias{alder_render}
\title{Render an Alder notebook with Quarto/knitr or direct Pandoc}
\usage{
alder_render(
  path,
  engine = c("quarto", "pandoc"),
  format = "html",
  out = NULL,
  include_code = TRUE,
  timeout = 300000L
)
}
\arguments{
\item{path}{Path to an Alder \code{.R} notebook.}

\item{engine}{Either \code{"quarto"} or \code{"pandoc"}.}

\item{format}{Output format. HTML is currently supported by both engines.}

\item{out}{Optional output file. Defaults beside the notebook.}

\item{include_code}{Include source code in the rendered report.}

\item{timeout}{Maximum external-render time in milliseconds.}
}
\value{
The normalized output path invisibly, with engine and command-output
attributes for provenance.
}
\description{
Blocking syntax, duplicate-definition, dependency-cycle, and dynamic
analysis diagnostics are reported before execution or destination change.
The output must not identify the input notebook, including through a
symlink or hard link.

\code{engine = "quarto"} creates a temporary qmd document with an explicit
knitr engine and lets Quarto execute the R cells once in dependency order,
while presenting the resulting chunks in notebook order. Disabled cells
and their transitive descendants do not execute in either engine.
Alder Markdown and layouts retain their content, composed native values
use the engine's scientific renderers, and Alder input widget values are static
snapshots. Tabs and accordions show all sections, progress shows its final
state, and unresolved lazy outputs retain their label without evaluation.
Console output, conditions, and appended results retain execution order.
\code{engine = "pandoc"}
executes the reactive notebook once through Alder, creates static Markdown
containing its visible conditions and outputs, and invokes Pandoc directly;
Pandoc never executes R code.
}
\examples{
\dontrun{
alder_render("analysis.R", engine = "quarto")
alder_render("analysis.R", engine = "pandoc")
}
}

\name{ui}
\alias{ui}
\title{Notebook UI widgets}
\description{
  \code{ui\$slider()}, \code{ui\$dropdown()}, \code{ui\$text_input()},
  \code{ui\$number()}, \code{ui\$run_button()} and \code{ui\$checkbox()}
  create interactive widgets (ADR 0003). A widget is a plain classed list
  whose current value is read explicitly through \code{\$value}; the web UI
  renders an interactive control for it.
}
\usage{
ui
}
\value{
  \code{ui} is a list of widget constructors (\code{slider},
  \code{dropdown}, \code{text_input}, \code{number}, \code{run_button},
  \code{checkbox}); each constructor returns an object of class
  \code{alder_widget} with public fields \code{kind}, \code{label},
  \code{value}, and kind-specific constraint fields. Notebook code reads
  the current value as \code{x\$value}.
}
\details{
  Widget constructors are list members of \code{ui} and are called with
  \code{ui$slider(...)}, \code{ui$dropdown(...)}, \code{ui$text_input(...)},
  \code{ui$number(...)}, \code{ui$run_button(...)} and
  \code{ui$checkbox(...)}.

  A widget is \emph{not} interchangeable with its value: use
  \code{x\$value} explicitly in computations, plots, and tidy-eval
  predicates. Widget interactions rerun the cells that reference the widget
  (and their descendants) automatically and in every app view; the cell
  that defines the widget never reruns on its own widget change.

  \itemize{
    \item \code{slider(min, max, value = min, step = 1, label = NULL)}:
      numeric range control.
    \item \code{dropdown(choices, value = choices[[1L]], label = NULL)}:
      pick one of \code{choices}.
    \item \code{text_input(value = "", label = NULL)}: free text.
    \item \code{number(value = 0, min = NULL, max = NULL, step = 1,
      label = NULL)}: numeric entry with optional bounds.
    \item \code{run_button(label = "Run")}: Boolean one-shot input; set to
      \code{TRUE} when clicked and reset to \code{FALSE} after its consumers
      finish.
    \item \code{checkbox(value = FALSE, label = NULL)}: logical toggle.
  }
}
\examples{
n <- ui$slider(10, 1000, value = 300)
mean(c(n$value, 100))
}

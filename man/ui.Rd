\name{ui}
\alias{ui}
\title{Notebook UI widgets}
\description{
  \code{ui\$slider()}, \code{ui\$dropdown()}, \code{ui\$text_input()},
  \code{ui\$number()}, \code{ui\$button()} and \code{ui\$checkbox()} create
  widget proxies (ADR 0003). The proxy \emph{is} the value: in notebook code
  the bound name behaves like the underlying value under arithmetic,
  comparison, coercion, subsetting and aggregation, while the web UI renders
  an interactive control for it.
}
\usage{
ui
}
\value{
  \code{ui} is a list of widget constructors (\code{slider},
  \code{dropdown}, \code{text_input}, \code{number}, \code{button},
  \code{checkbox}); each constructor returns an S3 object of class
  \code{alder_widget_proxy} carrying the current value (field
  \code{.value}; \code{value} is the public accessor). Rendering as a UI
  control happens in the notebook output.
}
\details{
  Widget constructors are list members of \code{ui} and are called with
  \code{ui$slider(...)}, \code{ui$dropdown(...)}, \code{ui$text_input(...)},
  \code{ui$number(...)}, \code{ui$button(...)} and \code{ui$checkbox(...)}.

  In notebook code the bound proxy behaves as the underlying value under
  coercion (\code{as.numeric}, \code{as.character}, \code{as.logical},
  \code{as.matrix}, \code{as.data.frame}), arithmetic and comparison
  (Ops), \code{Math} and \code{Summary} group generics, \code{mean()},
  subsetting, and formatting; \code{x$value} always returns the current
  underlying value.

  \itemize{
    \item \code{slider(min, max, value = min, step = 1, label = NULL)}:
      numeric range control.
    \item \code{dropdown(choices, value = choices[[1L]], label = NULL)}:
      pick one of \code{choices}.
    \item \code{text_input(value = "", label = NULL)}: free text.
    \item \code{number(value, min = NA_real_, max = NA_real_, step = 1,
      label = NULL)}: numeric entry with optional bounds.
    \item \code{button(label = "Run", value = 0L)}: one-shot action.
    \item \code{checkbox(value = FALSE, label = NULL)}: logical toggle.
  }
}
\examples{
n <- ui$slider(10, 1000, value = 300)
mean(c(n, 100))
}
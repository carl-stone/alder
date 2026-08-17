\name{start_alder}
\alias{start_alder}
\alias{stop_alder}
\title{Serve an alder notebook}
\usage{
start_alder(path = NULL, host = "127.0.0.1", port = 8899L, open = FALSE,
  execution_mode = c("automatic", "lazy"), run_on_startup = TRUE,
  allowed_origins = NULL)

stop_alder(srv)
}
\arguments{
  \item{path}{Path to a notebook file (plain \code{.R} with \code{# \%\%}
    cells, per ADR 0001). Must be \code{NULL} or one nonempty valid-UTF-8
    string. When \code{NULL}, an empty notebook with no save path is
    served; a nonexistent path is created only on Save.}

  \item{host}{Interface to bind; defaults to loopback only. A non-loopback
    bind requires an explicit \code{allowed_origins}.}

  \item{port}{TCP port for the local web server; one integer in 1--65535.}

  \item{open}{Open a browser tab after the server is ready.}

  \item{execution_mode}{Reactivity mode: \code{"automatic"} (default) runs
    a cell's ancestors, the target, and all descendants; \code{"lazy"}
    runs ancestors and the target and leaves descendants stale. App views
    always use automatic widget reactivity.}

  \item{run_on_startup}{If \code{TRUE} (default), all code cells run once
    when the server starts; if \code{FALSE}, opening the editor or an app
    URL never triggers execution.}

  \item{allowed_origins}{For loopback binds, optional explicit trusted
    origins; for non-loopback binds, required. \code{NULL} on loopback
    allows exactly \code{http://127.0.0.1:<port>},
    \code{http://localhost:<port>}, and \code{http://[::1]:<port>}.}

  \item{srv}{An \code{alder_server} object returned by \code{start_alder}.}
}
\value{
  \code{start_alder} returns an \code{alder_server} list wrapping the httpuv
  server and the notebook \code{Session}. \code{stop_alder} returns it
  invisibly and is idempotent.
}
\description{
  Start the local alder web app for a notebook: a derivation DAG over
  \code{# \%\%} cells is computed, cells execute in dependency order in a
  dedicated R worker process, and the UI supports editing, reactive
  execution (ADR 0002), \code{ui\$} widgets with explicit \code{\$value}
  (ADR 0003), and interruptible execution.
}
\details{
  Only the worker is executed as a separate process for isolation; it is
  not a security sandbox, so only trusted notebook code should be run.
}
\seealso{\code{\link{ui}}}

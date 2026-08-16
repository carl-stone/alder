\name{start_alder}
\alias{start_alder}
\alias{stop_alder}
\title{Serve an alder notebook}
\usage{
start_alder(path = NULL, host = "127.0.0.1", port = 8899, open = FALSE)

stop_alder(srv)
}
\arguments{
  \item{path}{Path to a notebook file (plain \code{.R} with \code{# \%\%}
    cells, per ADR 0001). When \code{NULL} or missing, an empty notebook is
    served.}

  \item{host}{Interface to bind; defaults to loopback only.}

  \item{port}{TCP port for the local web server.}

  \item{open}{Open a browser tab after the server is ready.}

  \item{srv}{An \code{alder_server} object returned by \code{start_alder}.}
}
\value{
  \code{start_alder} returns an \code{alder_server} list wrapping the httpuv
  server and the notebook \code{Session}. \code{stop_alder} returns it
  invisibly.
}
\description{
  Start the local alder web app for a notebook: a derivation DAG over
  \code{# %%} cells is computed, cells execute in dependency order in a
  dedicated R worker process, and the UI supports editing, stale marking
  (ADR 0002), \code{ui\$} widgets (ADR 0003), and interruptible execution.
}
\seealso{\code{\link{ui}}}
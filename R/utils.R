# Package-internal helpers shared across R/ modules.
#
`%||%` <- function(a, b) if (is.null(a)) b else a

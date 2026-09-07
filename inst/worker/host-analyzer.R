# Persistent static-analysis and pure R service adapter for the TypeScript host.
# Notebook source is parsed and walked by Alder's analyzer; it is never evaluated.

suppressPackageStartupMessages(library(alder))
get("alder_host_apply_library_policy", asNamespace("alder"))()

# Initialize opt-in tracing before the readiness handshake so creation-only
# profiles contain analyzer startup rather than beginning at the first request.
get(".alder_perf_initialize", envir = asNamespace("alder"))()

local({
  `%||%` <- function(left, right) if (is.null(left)) right else left
  peer_role <- Sys.getenv("ALDER_HOST_ROLE", unset = "")
  Sys.unsetenv("ALDER_HOST_ROLE")
  if (!(peer_role %in% c("analyzer", "service"))) {
    stop("invalid Alder static peer role", call. = FALSE)
  }
  perf_begin <- get(".alder_perf_begin", asNamespace("alder"))
  perf_end <- get(".alder_perf_end", asNamespace("alder"))
  package_path <- find.package("alder", quiet = FALSE)
  package_version <- as.character(utils::packageVersion("alder"))
  r_version <- as.character(getRversion())
  framing_path <- file.path(package_path, "worker", "host-framing.R")
  if (!file.exists(framing_path)) {
    stop("installed Alder host framing module not found", call. = FALSE)
  }
  framing <- new.env(parent = baseenv())
  sys.source(framing_path, envir = framing)

  input <- framing$open_input()
  output <- framing$open_output()
  on.exit(tryCatch(close(input), error = function(error) NULL), add = TRUE)
  on.exit(tryCatch(close(output), error = function(error) NULL), add = TRUE)

  scalar_string <- function(value, allow_empty = FALSE,
                            max_bytes = 32L * 1024L * 1024L) {
    is.character(value) && length(value) == 1L && !is.na(value) &&
      (allow_empty || nzchar(value)) &&
      nchar(value, type = "bytes") <= max_bytes
  }
  scalar_integer <- function(value) {
    is.numeric(value) && length(value) == 1L && !is.na(value) &&
      is.finite(value) && value == floor(value) && value >= 0 &&
      value <= 9007199254740991
  }
  require_object <- function(value, label) {
    if (!is.list(value) || is.null(names(value)) || any(!nzchar(names(value))) ||
        anyDuplicated(names(value))) {
      stop(label, " must be a JSON object with unique fields", call. = FALSE)
    }
    invisible(value)
  }
  require_request <- function(request) {
    require_object(request, "host request")
    if (!identical(request[["protocol"]], framing$PROTOCOL)) {
      stop("incompatible Alder engine protocol", call. = FALSE)
    }
    if (!scalar_integer(request[["req"]]) || request[["req"]] < 1 ||
        !scalar_string(request[["cmd"]], max_bytes = 64L) ||
        !grepl("^[a-z][a-z0-9_]*$", request[["cmd"]])) {
      stop("invalid host request identity", call. = FALSE)
    }
    invisible(request)
  }
  decode_source <- get("alder_host_decode_source", asNamespace("alder"))
  max_cells <- get("ALDER_HOST_MAX_CELLS", asNamespace("alder"))

  empty_analysis <- function() {
    list(
      defs = I(character()), refs = I(character()),
      self_refs = I(character()), locals = I(character()),
      barrier = FALSE, opaque = FALSE, diagnostics = I(list()), error = NULL
    )
  }

  analyze_request <- function(request) {
    if (!scalar_integer(request[["revision"]])) {
      stop("analysis revision must be a non-negative integer", call. = FALSE)
    }
    cells <- request[["cells"]]
    if (!is.list(cells) || length(cells) > max_cells) {
      stop("analysis cells must be a bounded JSON array", call. = FALSE)
    }
    ids <- character()
    results <- lapply(cells, function(cell) {
      require_object(cell, "analysis cell")
      source <- decode_source(cell, "source_base64", "source",
                              "analysis source")
      if (!scalar_string(cell[["id"]], max_bytes = 1024L) ||
          !scalar_integer(cell[["revision"]]) ||
          !scalar_string(cell[["type"]], max_bytes = 16L) ||
          !(cell[["type"]] %in% c("code", "markdown")) ||
          !scalar_string(source, allow_empty = TRUE)) {
        stop("invalid analysis cell snapshot", call. = FALSE)
      }
      ids <<- c(ids, cell[["id"]])
      analysis <- if (identical(cell[["type"]], "code")) {
        analysis_span <- perf_begin("analyzer.cell_defs_refs", list(
          req = request[["req"]], revision = request[["revision"]],
          cell = cell[["id"]], cell_revision = cell[["revision"]]
        ))
        analysis_result <- list(ok = FALSE)
        on.exit(perf_end(analysis_span, analysis_result), add = TRUE)
        value <- get("cell_defs_refs", asNamespace("alder"))(source)
        analysis_result <- list(
          ok = TRUE,
          defs = length(value$defs %||% character()),
          refs = length(value$refs %||% character()),
          diagnostics = length(value$diagnostics %||% list())
        )
        value
      } else {
        empty_analysis()
      }
      list(
        id = cell[["id"]],
        revision = cell[["revision"]],
        defs = I(analysis$defs %||% character()),
        refs = I(analysis$refs %||% character()),
        self_refs = I(analysis$self_refs %||% character()),
        locals = I(analysis$locals %||% character()),
        barrier = isTRUE(analysis$barrier),
        opaque = isTRUE(analysis$opaque),
        diagnostics = I(analysis$diagnostics %||% list()),
        error = analysis$error %||% NULL
      )
    })
    if (anyDuplicated(ids)) stop("analysis cell ids must be unique", call. = FALSE)
    policy <- Sys.getenv("ALDER_ANALYSIS_POLICY", unset = "alder-static-v1")
    if (!scalar_string(policy, max_bytes = 256L)) {
      stop("invalid analysis policy identity", call. = FALSE)
    }
    list(
      ok = TRUE,
      revision = request[["revision"]],
      cells = I(results),
      analyzer = list(
        package_version = package_version,
        r_version = r_version,
        policy = policy
      )
    )
  }

  service_commands <- c(
    "codec.decode", "codec.document", "codec.encode", "config.resolve", "config.validate",
    "config.encode", "layout.validate", "layout.read", "layout.encode",
    "markdown.render", "help.render", "app.validate", "format", "graph", "export.render"
  )
  service_request <- function(request) {
    command <- request[["command"]]
    if (!scalar_string(command, max_bytes = 64L) ||
        !(command %in% service_commands)) {
      stop("unknown Alder host service", call. = FALSE)
    }
    helper <- get("alder_host_service", asNamespace("alder"))
    payload <- request[["payload"]]
    require_object(payload, "service payload")
    list(ok = TRUE, result = helper(command, payload))
  }

  respond <- function(request, response) {
    response$req <- request[["req"]]
    response$cmd <- request[["cmd"]]
    # Echo correlation fields even on request errors. The host validates these
    # before exposing an R service error to its caller.
    if (!is.null(request[["revision"]])) {
      response$revision <- request[["revision"]]
    }
    framing$write_frame(output, response)
  }

  dispatch_request <- function(request) {
    fields <- list(req = request[["req"]], cmd = request[["cmd"]])
    if (!is.null(request[["revision"]])) fields$revision <- request[["revision"]]
    if (identical(request[["cmd"]], "service") &&
        !is.null(request[["command"]])) {
      fields$service <- request[["command"]]
    }
    stage <- if (identical(peer_role, "analyzer")) {
      "analyzer.request"
    } else {
      "services.request"
    }
    request_span <- perf_begin(stage, fields)
    request_result <- list(ok = FALSE)
    on.exit(perf_end(request_span, request_result), add = TRUE)
    allowed <- if (identical(peer_role, "analyzer")) {
      c("ping", "analyze", "shutdown")
    } else {
      c("ping", "service", "shutdown")
    }
    response <- tryCatch(
      if (!(request[["cmd"]] %in% allowed)) {
        list(ok = FALSE, error = list(
          code = "unknown_command",
          message = paste0("unknown ", peer_role, " command: ",
                           request[["cmd"]])
        ))
      } else {
        switch(
          request[["cmd"]],
          ping = list(ok = TRUE),
          analyze = analyze_request(request),
          service = service_request(request),
          shutdown = list(ok = TRUE)
        )
      },
      error = function(error) list(ok = FALSE, error = list(
        code = "service_error", message = conditionMessage(error)
      ))
    )
    request_result <- list(ok = isTRUE(response$ok))
    if (!is.null(response$error$code)) {
      request_result$error_code <- response$error$code
    }
    respond(request, response)
    invisible()
  }

  # This adapter is sourced at process startup and therefore bypasses the
  # package byte compiler. Profiles showed R's JIT compiling framing and
  # dispatch closures during the first real analysis request. Compile the
  # bounded internal path before advertising readiness; no notebook source is
  # parsed or evaluated here.
  for (name in c(
    "read_exact", "frame_length", "frame_header", "check_json_text",
    "check_json_value", "read_frame", "write_frame"
  )) {
    assign(name, compiler::cmpfun(get(name, envir = framing, inherits = FALSE)),
           envir = framing)
  }
  target <- environment(dispatch_request)
  hot_helpers <- c(
    "scalar_string", "scalar_integer", "require_object", "require_request",
    "respond", "dispatch_request",
    if (identical(peer_role, "analyzer")) c("empty_analysis", "analyze_request")
    else "service_request"
  )
  for (name in hot_helpers) {
    assign(name, compiler::cmpfun(get(name, envir = target, inherits = FALSE)),
           envir = target)
  }

  framing$write_frame(output, list(
    kind = "handshake",
    protocol = framing$PROTOCOL,
    role = peer_role,
    engine = list(name = paste0("alder-r-", peer_role), version = "1"),
    package_version = package_version,
    r_version = r_version,
    capabilities = I(if (identical(peer_role, "analyzer")) {
      "analysis"
    } else {
      "pure-services"
    }),
    readiness = list(
      initialized = TRUE,
      analysis = identical(peer_role, "analyzer"),
      services = identical(peer_role, "service")
    )
  ))

  repeat {
    request <- framing$read_frame(input)
    if (is.null(request)) break
    require_request(request)
    dispatch_request(request)
    if (identical(request[["cmd"]], "shutdown")) break
  }
})

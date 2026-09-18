# ---
# title: Package from the notebook project
# ---

# %%
library(jsonlite)
expected_library <- Sys.getenv("ALDER_EXAMPLE_PROJECT_LIB", unset = "")
if (nzchar(expected_library)) {
  expected_package <- normalizePath(
    file.path(expected_library, "jsonlite"), mustWork = TRUE
  )
  loaded_package <- normalizePath(
    getNamespaceInfo(asNamespace("jsonlite"), "path"), mustWork = TRUE
  )
  stopifnot(identical(loaded_package, expected_package))
}

# %%
cat(toJSON(list(value = 42L, label = "project"), auto_unbox = TRUE), "\n")

# Expected output: {"value":42,"label":"project"}. For a project library
# check, install jsonlite in a project-owned directory and set
# ALDER_EXAMPLE_PROJECT_LIB to that directory. The first cell fails if an
# already-loaded global jsonlite namespace overrides the project copy.

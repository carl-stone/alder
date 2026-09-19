# ---
# title: Ordinary dynamic R and best-effort reactivity
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
assign("hidden_value", 10L)
hidden_value

# %%
looked_up <- get("hidden_value")
stopifnot(identical(looked_up, 10L))
looked_up

# %%
called <- do.call("sum", list(1L, 2L, 3L))
stopifnot(identical(called, 6L))
called

# %%
evaluated <- eval(parse(text = "40L + 2L"))
stopifnot(identical(evaluated, 42L))
evaluated

# %%
source_file <- tempfile(fileext = ".R")
writeLines("sourced_value <- 7L", source_file)
source(source_file, local = TRUE)
stopifnot(identical(sourced_value, 7L))
sourced_value

# %%
image_file <- tempfile(fileext = ".RData")
saved_value <- 9L
save(saved_value, file = image_file)
rm(saved_value)
load(image_file)
stopifnot(identical(saved_value, 9L))
saved_value

# All cells run as an ordinary R script and produce 10, 10, 6, 42, 7, and 9.
# If the first cell changes hidden_value to 20, static analysis does not invent
# a dependency through the string passed to get(). Run the second cell (or the
# whole notebook) explicitly to refresh looked_up.

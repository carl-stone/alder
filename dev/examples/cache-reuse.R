# ---
# title: Reuse computed results
# runtime:
#   on_cell_change: automatic
#   on_startup: false
#   cache:
#     enabled: true
# ---

# %%
library(alder)

# %%
multiplier <- 2L

# %%
memo <- cache$memory(function(x) {
  message("compute memory")
  x * multiplier
})
c(memo(3L), memo(3L))

# %%
saved <- cache$disk(function(x) {
  message("compute disk")
  x * multiplier
})
c(saved(4L), saved(4L))

# The first repeated calls return c(6, 6) and c(8, 8), each with one
# "compute" message. Edit the multiplier cell to 3L and rerun its affected
# cells: the calls return c(9, 9) and c(12, 12), with one new message each.
# Editing either function body also recomputes its result. In Alder, valid
# disk results survive a kernel restart; the project cache directory setting
# selects where cache$disk writes them.

# ---
# title: Barrier restart preserves earlier bindings
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
seed <- 5L
seed

# %%
library(stats)
marker <- 1L
marker

# %%
result <- seed + marker
result

# Ordinary R, top to bottom: 5, 1, 6.
# In Alder, edit marker in the library cell from 1 to 2. Its barrier restarts
# the kernel, so seed must execute again before the changed cell and result.
# The current outputs become 5, 2, 7 after one clean restart.

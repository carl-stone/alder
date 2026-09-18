# ---
# title: Outdated reactive result
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
x <- 1L
x

# %%
Sys.sleep(2)
slow <- x * 10L
slow

# %%
unrelated <- 100L
unrelated

# Ordinary R, top to bottom: 1, 10, 100.
# In Alder, start the slow cell, then change x to 2 while it is running.
# Its old 10 must never replace a newer result. After the affected cells
# run for the new revision, the outputs are 2, 20, 100.

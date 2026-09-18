# ---
# title: Reactive error and recovery
# runtime:
#   on_cell_change: automatic
#   on_startup: true
# ---

# %%
x <- 2L
x

# %%
if (x < 0L) stop("x must be nonnegative")
doubled <- x * 2L
doubled

# %%
after <- doubled + 1L
after

# Ordinary R, top to bottom: 2, 4, 5.
# In Alder, changing x to -1 produces the stated error in cell 2; cell 3
# must not show its old 5 as current. Changing x back to 3 recovers to 3, 6, 7.

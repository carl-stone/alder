# ---
# title: Reactive branches
# runtime:
#   on_cell_change: automatic
#   on_startup: true
# ---

# %%
x <- 2L
x

# %%
left <- x * 3L
left

# %%
right <- x + 5L
right

# %%
independent <- 100L
independent

# Ordinary R, top to bottom: 2, 6, 7, 100.
# In Alder, change x to 4: the first three outputs become 4, 12, 9 in
# dependency order. The independent cell stays at 100 without executing again.

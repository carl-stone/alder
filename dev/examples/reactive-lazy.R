# ---
# title: Lazy dependencies
# runtime:
#   on_cell_change: lazy
#   on_startup: false
# ---

# %%
x <- 2L
x

# %%
answer <- x * 7L
answer

# Ordinary R, top to bottom: 2, 14.
# In Alder lazy mode, opening and editing do not execute either cell.
# Running the answer cell resolves x first. After changing x to 3, both
# outputs are stale until an explicit Run updates them to 3 and 21.

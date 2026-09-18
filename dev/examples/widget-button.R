# ---
# title: Button trigger
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
library(alder)

# %%
clicks <- ui$button(label = "Count")
clicks

# %%
seen <- clicks$value
seen

# Ordinary R starts with clicks$value = 0 and seen = 0.
# Each click increments the integer counter once. After two clicks the
# current values are clicks$value = 2 and seen = 2.

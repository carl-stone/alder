# ---
# title: Slider input
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
library(alder)

# %%
gain <- ui$slider(0, 10, value = 2, step = 1, label = "Gain")
gain

# %%
scaled <- gain$value * 7
scaled

# %%
unrelated <- 100L
unrelated

# Ordinary R starts with gain$value = 2 and scaled = 14.
# Setting the slider to 4 changes gain$value to 4 and reruns only scaled,
# producing 28. The unrelated value remains 100 without another evaluation.

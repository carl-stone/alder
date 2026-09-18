# ---
# title: Ordered scientific output
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
library(alder)

# %%
out$append(out$md("**First**: six observations"))
cat("Second: calculated table\n")
out$append(data.frame(group = c("a", "b"), total = c(6L, 15L)))
"Fourth: complete"

# %%
plot(1:3, c(2, 4, 6), type = "b", main = "Three points")

# The second cell displays Markdown, the console line, a two-row table, and
# the final text in that order. The plot cell displays one three-point image.
# As ordinary R, the table values are 6 and 15 and the final value is the
# string "Fourth: complete".

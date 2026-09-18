# ---
# title: Progress and deferred output
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
library(alder)

# %%
progress <- out$progress(total = 3, label = "Rows")
for (i in 1:3) progress$update(i)
progress$close()
sum(1:3)

# %%
out$lazy(function() out$vstack(
  out$md("**Deferred**: six"),
  data.frame(i = 1:3, doubled = c(2L, 4L, 6L))
), label = "Show detail")

# The progress cell reaches 3/3 and returns 6. Its progress indicator clears
# when the cell completes. In Alder, the last cell initially shows only
# "Show detail"; selecting it reveals Markdown followed by the three-row
# table. As ordinary R, out$lazy evaluates immediately and returns the layout.
# An interrupted or edited source must not attach an older detail result.

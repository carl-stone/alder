# ---
# title: Submit a composite input
# runtime:
#   on_cell_change: automatic
#   on_startup: false
# ---

# %%
library(alder)

# %%
settings <- ui$form(ui$array(
  factor = ui$slider(0, 10, value = 2),
  enabled = ui$checkbox(FALSE)
), submit_label = "Apply")
settings

# %%
result <- if (is.null(settings$value)) "not submitted" else {
  if (settings$value$enabled) settings$value$factor * 7 else 0
}
result

# Ordinary R starts with settings$value = NULL and result = "not submitted".
# Changing the draft factor to 4 and enabled to TRUE leaves that result alone.
# Apply submits both values at once: settings$value is list(factor=4,enabled=TRUE)
# and the dependent result becomes 28 after one rerun.

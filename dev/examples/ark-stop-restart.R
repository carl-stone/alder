# ---
# title: Stop and restart
# ---

# %%
session_count <- 1L
session_count

# %%
for (step in seq_len(40L)) {
  if (step %% 10L == 0L) {
    cat("completed step", step, "\n")
    flush.console()
  }
  Sys.sleep(0.15)
}
"long cell completed"

# %%
session_count <- session_count + 1L
session_count

# Plain Rscript completes steps 10, 20, 30 and 40, then prints 2. In Alder,
# Stop during the middle cell should interrupt it; the next cell can run after
# recovery and return 2. After a kernel restart, the next cell alone errors
# because session_count is gone; rerunning the first cell returns 1.

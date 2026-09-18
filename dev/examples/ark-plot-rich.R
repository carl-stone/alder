# ---
# title: Base plot and rich table
# ---

# %%
samples <- data.frame(group = c("a", "b", "c"), value = c(2L, 4L, 6L))
samples

# %%
plot(samples$value, type = "b", pch = 19, xlab = "sample", ylab = "value")

# Expected: a three-row table (a/2, b/4, c/6), followed by a plot with three
# connected points. Plain Rscript writes its plot to Rplots.pdf in the working
# directory; Alder should display the image with the plot cell.

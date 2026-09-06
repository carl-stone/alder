# ---
# title: Iris, reactively
# ---

# %% [markdown]
# # Iris, reactively
#
# Change the slider to update the table, plot, and model below.
# Edit a code cell and run it to recalculate its dependents.
# Choose App mode to share the same local notebook with its code hidden.

# %%
library(alder)

# %%
minimum_length <- ui$slider(
  4, 7, value = 5, step = 0.1, label = "Minimum sepal length (cm)"
)
minimum_length

# %%
selected <- subset(iris, Sepal.Length >= minimum_length$value)
selected

# %% [markdown]
# ## Explore the relationship
#
# The table supports sorting, filtering, paging, and export. The plot and
# model use the selected observations. No additional R packages are required.

# %%
fit <- lm(Sepal.Width ~ Sepal.Length, data = selected)
summary(fit)

# %%
plot(
  selected$Sepal.Length, selected$Sepal.Width,
  col = as.integer(selected$Species), pch = 19,
  xlab = "Sepal length (cm)", ylab = "Sepal width (cm)",
  main = paste(nrow(selected), "selected flowers")
)
abline(fit, lty = 2)
legend("topright", legend = levels(iris$Species), col = 1:3, pch = 19)

# %% [markdown]
# ## Keep and publish your work
#
# Save writes this ordinary R file. Use Lazy runtime when an expensive analysis
# should wait for an explicit run. See `?ui`, `?out`, and `?alder_render` in R
# for inputs, presentation, and Quarto or Pandoc publishing.

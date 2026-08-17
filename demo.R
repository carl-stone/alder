# ---
# title: alder demo
# ---

# %% [markdown]
# # Iris
#
# A reactive notebook: edit cells, rerun dependents, drag the slider.

# %%
library(alder)
library(ggplot2)

# %%
peng <- iris
nrow(peng)

# %%
min_wt <- ui$slider(1, 8, value = 3, label = "min sepal length")
min_wt

# %%
heavy <- peng[peng$Sepal.Length >= min_wt$value & !is.na(peng$Sepal.Length), ]
nrow(heavy)

# %%
ggplot(heavy, aes(x = .data$Sepal.Length, y = .data$Sepal.Width,
                  color = .data$Species)) +
  geom_point()

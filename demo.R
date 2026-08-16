# ---
# title: alder demo
# ---

# %% [markdown]
# # Iris
#
# A reactive notebook: edit cells, rerun dependents, drag the slider.

# %%
library(ggplot2)

# %%
peng <- iris
nrow(peng)

# %%
min_wt <- ui$slider(1, 8, value = 3, label = "min sepal length")
min_wt

# %%
heavy <- subset(peng, Sepal.Length >= min_wt & !is.na(Sepal.Length))
nrow(heavy)

# %%
ggplot(heavy, aes(x = Sepal.Length, y = Sepal.Width, color = Species)) +
  geom_point()

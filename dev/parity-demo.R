# ---
# title: alder parity demo
# ---

# %% [markdown]
# # alder parity demo
#
# Exercises the marimo-parity feature surface: streaming progress,
# appended outputs, base graphics capture, rich tables, SQL cells,
# disk caching, composite widget forms, disabled and tested cells,
# lazy outputs and media. Runnable as plain Rscript (ADR 0001).

# %%
library(alder)

# %%
p <- out$progress(20, label = "parity loop")
for (i in seq_len(20)) {
  p$update()
  Sys.sleep(0.05)
}
p$close()
"progress done"

# %%
out$append(head(iris))
"appended"

# %%
plot(1:10)

# %%
df <- data.frame(x = seq_len(500), y = rnorm(500))
nrow(df)

# %% [sql]
result <- sql(r"---(
SELECT count(*) AS n FROM df
)---")

# %%
result$n

# %%
f <- cache$disk(function(n) { Sys.sleep(1); n * 2 })
f(21)
f(21)

# %%
s <- ui$form(ui$array(a = ui$slider(0, 10, 5), b = ui$checkbox()))
s$value

# %%
#| disabled: true
skip_me <- "this cell is disabled"

# %%
#| test: true
testthat::expect_equal(nrow(df), 500)

# %%
out$lazy(function() summary(df))

# %%
img <- tempfile(fileext = ".png")
png(img)
plot(runif(10), main = "media")
dev.off()
out$image(img)
"media"

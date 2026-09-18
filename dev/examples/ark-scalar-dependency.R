# ---
# title: Scalar dependency
# ---

# %%
input <- 6L
input

# %%
answer <- input * 7L
answer

# Expected in ordinary R: 6, then 42. In Alder, changing input to 8 and
# rerunning its dependent cell should yield 56 without changing cell identity.

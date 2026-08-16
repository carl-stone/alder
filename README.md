# alder

A modern reactive notebook for R.

Cells are statically analyzed into a dependency DAG, execute in dependency order, and update when upstream code changes. Notebooks are plain-text `.R` files you can run with `Rscript`. See `VISION.md` for the full product brief and `dev/` for design decisions.
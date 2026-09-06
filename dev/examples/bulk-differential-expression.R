# ---
# title: Bulk RNA-seq differential expression
# ---

# %% [markdown]
#| name: introduction
# # Bulk RNA-seq differential expression
# A reproducible, moderately sized analysis of 6,000 genes in 24 samples.
# Counts and gene identifiers are simulated; no biological finding is implied.
# The experimental unit is one independent biological sample. Both conditions
# occur in every batch, so the treatment effect is estimable after adjustment.
# Install Alder, ggplot2, edgeR and statmod before running this notebook.
# Method: https://bioconductor.org/packages/release/bioc/vignettes/edgeR/inst/doc/edgeRUsersGuide.pdf
# Raw integer counts enter edgeR; transformed values are used only for QC plots.

# %%
#| name: dependencies
library(alder)
stopifnot(
  requireNamespace("edgeR", quietly = TRUE),
  requireNamespace("limma", quietly = TRUE),
  requireNamespace("statmod", quietly = TRUE),
  requireNamespace("ggplot2", quietly = TRUE)
)
package_versions <- data.frame(
  package = c("alder", "edgeR", "limma", "statmod", "ggplot2"),
  version = vapply(
    c("alder", "edgeR", "limma", "statmod", "ggplot2"),
    function(package) as.character(utils::packageVersion(package)),
    character(1)
  )
)
package_versions

# %%
#| name: analysis_settings
analysis_settings <- list(
  seed = 20260906L,
  genes = 6000L,
  samples_per_group_per_batch = 4L,
  batches = c("batch_1", "batch_2", "batch_3"),
  conditions = c("control", "treated"),
  min_count = 10,
  min_total_count = 15,
  prior_count = 2,
  truth_up = 300L,
  truth_down = 300L,
  truth_log2fc = 1.5,
  fdr = 0.05
)
stopifnot(
  analysis_settings$genes > 1000L,
  analysis_settings$samples_per_group_per_batch >= 3L,
  analysis_settings$truth_up + analysis_settings$truth_down <
    analysis_settings$genes
)
analysis_settings

# %%
#| name: sample_metadata
samples <- expand.grid(
  replicate = seq_len(analysis_settings$samples_per_group_per_batch),
  condition = analysis_settings$conditions,
  batch = analysis_settings$batches,
  KEEP.OUT.ATTRS = FALSE,
  stringsAsFactors = FALSE
)
samples$sample_id <- sprintf("sample_%02d", seq_len(nrow(samples)))
samples$condition <- factor(
  samples$condition,
  levels = analysis_settings$conditions
)
samples$batch <- factor(
  samples$batch,
  levels = analysis_settings$batches
)
rownames(samples) <- samples$sample_id
samples <- samples[, c("sample_id", "condition", "batch", "replicate")]
stopifnot(
  nrow(samples) == 24L,
  !anyDuplicated(samples$sample_id),
  !anyNA(samples)
)
samples

# %%
#| name: simulation_function
simulate_bulk_counts <- function(settings, metadata) {
  set.seed(settings$seed)
  gene_ids <- sprintf("gene_%05d", seq_len(settings$genes))
  baseline <- exp(stats::rnorm(settings$genes, log(35), 1.7))
  dispersion <- 0.04 + 1 / sqrt(baseline + 1)
  log2_effect <- rep(0, settings$genes)
  log2_effect[seq_len(settings$truth_up)] <- settings$truth_log2fc
  down_indices <- settings$truth_up + seq_len(settings$truth_down)
  log2_effect[down_indices] <- -settings$truth_log2fc
  batch_slope <- stats::rnorm(settings$genes, 0, 0.18)
  library_multiplier <- exp(stats::rnorm(nrow(metadata), 0, 0.25))
  condition_indicator <- as.numeric(metadata$condition == "treated")
  batch_indicator <- as.numeric(metadata$batch) - 2
  log_means <- outer(log(baseline), rep(1, nrow(metadata))) +
    outer(log2_effect * log(2), condition_indicator) +
    outer(batch_slope, batch_indicator) +
    outer(rep(1, settings$genes), log(library_multiplier))
  means <- exp(log_means)
  counts <- matrix(
    stats::rnbinom(
      length(means),
      mu = as.vector(means),
      size = rep(1 / dispersion, nrow(metadata))
    ),
    nrow = settings$genes,
    ncol = nrow(metadata),
    dimnames = list(gene_ids, metadata$sample_id)
  )
  storage.mode(counts) <- "integer"
  annotation <- data.frame(
    gene_id = gene_ids,
    baseline_mean = baseline,
    dispersion = dispersion,
    true_log2fc = log2_effect,
    truth = ifelse(
      log2_effect > 0, "up",
      ifelse(log2_effect < 0, "down", "null")
    ),
    stringsAsFactors = FALSE,
    row.names = gene_ids
  )
  list(
    counts = counts,
    annotation = annotation,
    library_multiplier = stats::setNames(
      library_multiplier, metadata$sample_id
    )
  )
}

# %%
#| name: simulated_input
simulated_input <- simulate_bulk_counts(analysis_settings, samples)
counts <- simulated_input$counts
gene_annotation <- simulated_input$annotation
stopifnot(
  identical(dim(counts), c(6000L, 24L)),
  identical(colnames(counts), samples$sample_id),
  identical(rownames(counts), gene_annotation$gene_id),
  all(is.finite(counts)),
  all(counts >= 0),
  all(counts == floor(counts)),
  all(colSums(counts) > 0)
)
input_dimensions <- data.frame(
  genes = nrow(counts),
  samples = ncol(counts),
  observations = length(counts),
  zeros = sum(counts == 0),
  matrix_mib = as.numeric(object.size(counts)) / 1024^2
)
input_dimensions

# %% [markdown]
#| name: quality_control_intro
# ## Sample quality control
# Check sample identities and design balance before selecting genes or fitting.
# Library size and detected-gene counts can flag outliers, but this notebook
# does not automatically discard samples using a post hoc threshold.

# %%
#| name: design_balance
design_balance <- as.data.frame(table(
  batch = samples$batch,
  condition = samples$condition
))
stopifnot(
  nrow(design_balance) == 6L,
  all(design_balance$Freq == 4L)
)
design_balance

# %%
#| name: sample_qc
sample_qc <- data.frame(
  samples,
  library_size = colSums(counts),
  detected_genes = colSums(counts > 0),
  genes_at_least_ten = colSums(counts >= 10),
  zero_fraction = colMeans(counts == 0),
  median_count = apply(counts, 2, stats::median),
  upper_quartile = apply(counts, 2, stats::quantile, probs = 0.75),
  row.names = samples$sample_id
)
sample_qc$library_millions <- sample_qc$library_size / 1e6
sample_qc$relative_library <- sample_qc$library_size /
  stats::median(sample_qc$library_size)
sample_qc

# %%
#| name: plotting_theme
analysis_theme <- ggplot2::theme_minimal(base_size = 12) +
  ggplot2::theme(
    panel.grid.minor = ggplot2::element_blank(),
    plot.title.position = "plot",
    legend.position = "bottom",
    axis.text.x = ggplot2::element_text(angle = 45, hjust = 1),
    plot.margin = ggplot2::margin(12, 16, 12, 12)
  )
condition_colours <- c(control = "#2878A5", treated = "#B94A48")
direction_colours <- c(down = "#2878A5", not_selected = "#A7ADB4", up = "#B94A48")

# %%
#| name: library_size_plot
library_size_plot <- ggplot2::ggplot(
  sample_qc,
  ggplot2::aes(
    x = .data$sample_id,
    y = .data$library_millions,
    fill = .data$condition
  )
) +
  ggplot2::geom_col(width = 0.75) +
  ggplot2::scale_fill_manual(values = condition_colours) +
  ggplot2::labs(
    title = "Sequencing depth across biological samples",
    x = "Sample",
    y = "Simulated counts (millions)",
    fill = "Condition"
  ) +
  analysis_theme
library_size_plot

# %%
#| name: detection_plot
detection_plot <- ggplot2::ggplot(
  sample_qc,
  ggplot2::aes(
    x = .data$library_millions,
    y = .data$detected_genes,
    colour = .data$condition,
    shape = .data$batch
  )
) +
  ggplot2::geom_point(size = 3) +
  ggplot2::scale_colour_manual(values = condition_colours) +
  ggplot2::labs(
    title = "Depth and gene detection",
    x = "Simulated counts (millions)",
    y = "Genes with at least one count",
    colour = "Condition",
    shape = "Batch"
  ) +
  analysis_theme
detection_plot

# %%
#| name: gene_qc
gene_qc <- data.frame(
  gene_id = rownames(counts),
  mean_count = rowMeans(counts),
  variance_count = apply(counts, 1, stats::var),
  total_count = rowSums(counts),
  detected_samples = rowSums(counts > 0),
  max_count = apply(counts, 1, max),
  stringsAsFactors = FALSE
)
gene_qc$variance_to_mean <- gene_qc$variance_count /
  pmax(gene_qc$mean_count, 1)
gene_qc_summary <- data.frame(
  metric = c("mean count", "total count", "detected samples"),
  median = c(
    stats::median(gene_qc$mean_count),
    stats::median(gene_qc$total_count),
    stats::median(gene_qc$detected_samples)
  )
)
gene_qc_summary

# %%
#| name: count_mean_variance_plot
mean_variance_plot <- ggplot2::ggplot(
  gene_qc,
  ggplot2::aes(
    x = .data$mean_count + 1,
    y = .data$variance_count + 1
  )
) +
  ggplot2::geom_point(alpha = 0.18, size = 0.7, colour = "#2878A5") +
  ggplot2::geom_abline(slope = 1, intercept = 0, linetype = "dashed") +
  ggplot2::scale_x_log10() +
  ggplot2::scale_y_log10() +
  ggplot2::labs(
    title = "Count variability exceeds a simple Poisson model",
    x = "Mean count + 1",
    y = "Count variance + 1"
  ) +
  analysis_theme
mean_variance_plot

# %% [markdown]
#| name: filtering_intro
# ## Filtering and normalization
# Filtering uses the experimental design and expression, not differential-test
# p-values. TMM adjusts effective library sizes; it does not replace raw counts.
# The model below uses batch and condition without batch-removing the counts.

# %%
#| name: design_matrix
design <- stats::model.matrix(~ batch + condition, data = samples)
stopifnot(
  nrow(design) == ncol(counts),
  qr(design)$rank == ncol(design),
  nrow(design) > ncol(design),
  "conditiontreated" %in% colnames(design)
)
design_diagnostics <- data.frame(
  samples = nrow(design),
  coefficients = ncol(design),
  rank = qr(design)$rank,
  residual_df = nrow(design) - qr(design)$rank,
  condition_number = kappa(design)
)
design_diagnostics

# %%
#| name: raw_dge
dge_raw <- edgeR::DGEList(
  counts = counts,
  samples = samples,
  genes = gene_annotation
)
stopifnot(
  identical(colnames(dge_raw), samples$sample_id),
  identical(rownames(dge_raw), gene_annotation$gene_id)
)

# %%
#| name: expression_filter
keep_genes <- edgeR::filterByExpr(
  dge_raw,
  design = design,
  min.count = analysis_settings$min_count,
  min.total.count = analysis_settings$min_total_count
)
filter_summary <- data.frame(
  status = c("retained", "removed"),
  genes = c(sum(keep_genes), sum(!keep_genes)),
  fraction = c(mean(keep_genes), mean(!keep_genes))
)
stopifnot(
  length(keep_genes) == nrow(counts),
  sum(keep_genes) > 1000L,
  sum(!keep_genes) > 0L
)
filter_summary

# %%
#| name: filter_diagnostics
filter_diagnostics <- data.frame(
  gene_qc,
  retained = keep_genes,
  truth = gene_annotation$truth
)
filter_by_truth <- as.data.frame(table(
  truth = filter_diagnostics$truth,
  retained = filter_diagnostics$retained
))
filter_by_truth

# %%
#| name: normalized_dge
dge_filtered <- dge_raw[keep_genes, , keep.lib.sizes = FALSE]
dge_normalized <- edgeR::normLibSizes(dge_filtered, method = "TMM")
effective_library_sizes <- dge_normalized$samples$lib.size *
  dge_normalized$samples$norm.factors
normalization_qc <- data.frame(
  sample_id = samples$sample_id,
  condition = samples$condition,
  batch = samples$batch,
  filtered_library = dge_normalized$samples$lib.size,
  tmm_factor = dge_normalized$samples$norm.factors,
  effective_library = effective_library_sizes
)
stopifnot(
  all(is.finite(effective_library_sizes)),
  all(effective_library_sizes > 0),
  abs(sum(log(normalization_qc$tmm_factor))) < 1e-8
)
normalization_qc

# %%
#| name: normalization_plot
normalization_plot <- ggplot2::ggplot(
  normalization_qc,
  ggplot2::aes(
    x = .data$sample_id,
    y = .data$tmm_factor,
    fill = .data$condition
  )
) +
  ggplot2::geom_col(width = 0.75) +
  ggplot2::geom_hline(yintercept = 1, linetype = "dashed") +
  ggplot2::scale_fill_manual(values = condition_colours) +
  ggplot2::labs(
    title = "TMM composition factors",
    x = "Sample",
    y = "Normalization factor",
    fill = "Condition"
  ) +
  analysis_theme
normalization_plot

# %%
#| name: log_expression
log_cpm <- edgeR::cpm(
  dge_normalized,
  log = TRUE,
  prior.count = analysis_settings$prior_count
)
raw_log_cpm <- edgeR::cpm(
  dge_filtered,
  log = TRUE,
  prior.count = analysis_settings$prior_count,
  normalized.lib.sizes = FALSE
)
stopifnot(
  identical(dim(log_cpm), dim(dge_normalized$counts)),
  all(is.finite(log_cpm)),
  identical(colnames(log_cpm), samples$sample_id)
)

# %%
#| name: expression_distribution
expression_quantiles <- data.frame(
  sample_id = samples$sample_id,
  condition = samples$condition,
  lower = apply(log_cpm, 2, stats::quantile, probs = 0.1),
  median = apply(log_cpm, 2, stats::median),
  upper = apply(log_cpm, 2, stats::quantile, probs = 0.9),
  raw_median = apply(raw_log_cpm, 2, stats::median)
)
distribution_plot <- ggplot2::ggplot(
  expression_quantiles,
  ggplot2::aes(
    x = .data$sample_id,
    y = .data$median,
    colour = .data$condition
  )
) +
  ggplot2::geom_linerange(ggplot2::aes(
    ymin = .data$lower,
    ymax = .data$upper
  )) +
  ggplot2::geom_point(size = 2.5) +
  ggplot2::scale_colour_manual(values = condition_colours) +
  ggplot2::labs(
    title = "Normalized expression distributions",
    subtitle = "Median and 10th–90th percentiles of retained genes",
    x = "Sample", y = "Log2 CPM", colour = "Condition"
  ) +
  analysis_theme
distribution_plot

# %% [markdown]
#| name: exploratory_intro
# ## Exploratory sample structure
# PCA uses the 1,000 most variable retained genes, centered but not scaled to
# unit gene variance. Distances and correlations are descriptive QC. Treatment
# separation in a PCA plot is not itself a differential-expression test.

# %%
#| name: variable_genes
gene_variance <- apply(log_cpm, 1, stats::var)
variable_gene_order <- order(gene_variance, decreasing = TRUE)
pca_gene_ids <- rownames(log_cpm)[
  head(variable_gene_order, min(1000L, length(variable_gene_order)))
]
pca_input <- t(log_cpm[pca_gene_ids, , drop = FALSE])
pca_fit <- stats::prcomp(
  pca_input,
  center = TRUE,
  scale. = FALSE
)
pca_variance <- pca_fit$sdev^2 / sum(pca_fit$sdev^2)
pca_scores <- data.frame(
  samples,
  PC1 = pca_fit$x[, 1],
  PC2 = pca_fit$x[, 2],
  PC3 = pca_fit$x[, 3],
  row.names = samples$sample_id
)
head(pca_scores)

# %%
#| name: pca_plot
pca_plot <- ggplot2::ggplot(
  pca_scores,
  ggplot2::aes(
    x = .data$PC1,
    y = .data$PC2,
    colour = .data$condition,
    shape = .data$batch
  )
) +
  ggplot2::geom_point(size = 3.5) +
  ggplot2::scale_colour_manual(values = condition_colours) +
  ggplot2::labs(
    title = "Sample structure before model fitting",
    x = sprintf("PC1 (%.1f%%)", 100 * pca_variance[1]),
    y = sprintf("PC2 (%.1f%%)", 100 * pca_variance[2]),
    colour = "Condition",
    shape = "Batch"
  ) +
  analysis_theme +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 0))
pca_plot

# %%
#| name: pca_scree
scree_data <- data.frame(
  component = seq_along(pca_variance),
  variance_percent = 100 * pca_variance,
  cumulative_percent = 100 * cumsum(pca_variance)
)
scree_plot <- ggplot2::ggplot(
  head(scree_data, 10),
  ggplot2::aes(
    x = .data$component,
    y = .data$variance_percent
  )
) +
  ggplot2::geom_col(fill = "#2878A5", width = 0.7) +
  ggplot2::scale_x_continuous(breaks = seq_len(10)) +
  ggplot2::labs(
    title = "Variance explained by principal components",
    x = "Principal component",
    y = "Variance explained (%)"
  ) +
  analysis_theme
scree_plot

# %%
#| name: sample_correlations
sample_correlation <- stats::cor(log_cpm, method = "pearson")
correlation_long <- data.frame(
  sample_x = rep(colnames(sample_correlation), each = nrow(sample_correlation)),
  sample_y = rep(rownames(sample_correlation), times = ncol(sample_correlation)),
  correlation = as.vector(sample_correlation),
  stringsAsFactors = FALSE
)
correlation_long$sample_x <- factor(
  correlation_long$sample_x, levels = samples$sample_id
)
correlation_long$sample_y <- factor(
  correlation_long$sample_y, levels = rev(samples$sample_id)
)
correlation_plot <- ggplot2::ggplot(
  correlation_long,
  ggplot2::aes(
    x = .data$sample_x,
    y = .data$sample_y,
    fill = .data$correlation
  )
) +
  ggplot2::geom_tile() +
  ggplot2::scale_fill_gradient(low = "#F4EAD5", high = "#245C7C") +
  ggplot2::coord_equal() +
  ggplot2::labs(
    title = "Pairwise sample correlations",
    x = NULL, y = NULL, fill = "Pearson r"
  ) +
  analysis_theme
correlation_plot

# %%
#| name: sample_distance
sample_distance <- stats::dist(t(log_cpm[pca_gene_ids, , drop = FALSE]))
sample_tree <- stats::hclust(sample_distance, method = "average")
sample_distance_summary <- data.frame(
  minimum = min(as.vector(sample_distance)),
  median = stats::median(as.vector(sample_distance)),
  maximum = max(as.vector(sample_distance)),
  genes_used = length(pca_gene_ids)
)
plot(
  sample_tree,
  labels = paste(samples$sample_id, samples$condition, sep = " / "),
  main = "Sample clustering on variable genes",
  xlab = "Biological samples",
  sub = "Average linkage; Euclidean distance on log2 CPM",
  cex = 0.65
)

# %% [markdown]
#| name: model_intro
# ## Batch-adjusted differential expression
# The tested coefficient is treated minus control, adjusted for batch.
# edgeR estimates negative-binomial dispersions and fits a robust
# quasi-likelihood model. BH adjustment applies across all retained genes.
# Simulation truth is used only in the later benchmarking section, never to
# select genes, choose a model, estimate dispersion or calculate p-values.

# %%
#| name: dispersion_estimation
dge_dispersion <- edgeR::estimateDisp(
  dge_normalized,
  design = design,
  robust = TRUE
)
dispersion_summary <- data.frame(
  common_dispersion = dge_dispersion$common.dispersion,
  median_trended = stats::median(dge_dispersion$trended.dispersion),
  median_tagwise = stats::median(dge_dispersion$tagwise.dispersion),
  minimum_tagwise = min(dge_dispersion$tagwise.dispersion),
  maximum_tagwise = max(dge_dispersion$tagwise.dispersion)
)
stopifnot(
  all(is.finite(dge_dispersion$tagwise.dispersion)),
  all(dge_dispersion$tagwise.dispersion > 0)
)
dispersion_summary

# %%
#| name: biological_variation_plot
edgeR::plotBCV(
  dge_dispersion,
  main = "Biological coefficient of variation",
  xlab = "Average log2 CPM",
  ylab = "Biological coefficient of variation"
)

# %%
#| name: quasi_likelihood_fit
ql_fit <- edgeR::glmQLFit(
  dge_dispersion,
  design = design,
  robust = TRUE
)
fit_completed_at <- format(Sys.time(), "%Y-%m-%dT%H:%M:%OS6Z", tz = "UTC")
fit_signature <- c(
  genes = nrow(ql_fit$coefficients),
  coefficients = ncol(ql_fit$coefficients),
  coefficient_sum = sum(ql_fit$coefficients),
  fitted_sum = sum(ql_fit$fitted.values)
)
stopifnot(
  all(is.finite(ql_fit$coefficients)),
  nrow(ql_fit$coefficients) == sum(keep_genes),
  all(ql_fit$fitted.values > 0)
)
list(signature = fit_signature, completed_at = fit_completed_at)

# %%
#| name: ql_dispersion_plot
edgeR::plotQLDisp(
  ql_fit,
  main = "Quasi-likelihood dispersion moderation",
  xlab = "Average log2 CPM",
  ylab = "Quarter-root quasi-likelihood dispersion"
)

# %%
#| name: differential_test
de_test <- edgeR::glmQLFTest(
  ql_fit,
  coef = "conditiontreated"
)
de_results <- edgeR::topTags(
  de_test,
  n = Inf,
  adjust.method = "BH",
  sort.by = "PValue"
)$table
de_results$gene_id <- rownames(de_results)
de_results$rank <- seq_len(nrow(de_results))
de_results <- de_results[, c(
  "gene_id", "logFC", "logCPM", "F", "PValue", "FDR", "rank"
)]
stopifnot(
  nrow(de_results) == sum(keep_genes),
  !anyDuplicated(de_results$gene_id),
  all(is.finite(de_results$PValue)),
  all(de_results$PValue >= 0 & de_results$PValue <= 1),
  all(de_results$FDR >= 0 & de_results$FDR <= 1),
  isTRUE(all.equal(
    de_results$FDR,
    stats::p.adjust(de_results$PValue, method = "BH")
  ))
)
head(de_results, 12)

# %%
#| name: overall_de_summary
overall_de_summary <- data.frame(
  comparison = "treated - control (batch adjusted)",
  tested = nrow(de_results),
  significant = sum(de_results$FDR <= analysis_settings$fdr),
  up = sum(de_results$FDR <= analysis_settings$fdr & de_results$logFC > 0),
  down = sum(de_results$FDR <= analysis_settings$fdr & de_results$logFC < 0),
  median_absolute_log2fc = stats::median(abs(de_results$logFC)),
  minimum_p = min(de_results$PValue)
)
overall_de_summary

# %%
#| name: p_value_histogram
p_value_plot <- ggplot2::ggplot(
  de_results,
  ggplot2::aes(x = .data$PValue)
) +
  ggplot2::geom_histogram(
    breaks = seq(0, 1, length.out = 41),
    fill = "#2878A5",
    colour = "white"
  ) +
  ggplot2::labs(
    title = "Raw p-value distribution",
    subtitle = "All retained genes; BH adjustment is applied separately",
    x = "Quasi-likelihood F-test p-value",
    y = "Genes"
  ) +
  analysis_theme
p_value_plot

# %% [markdown]
#| name: interactive_intro
# ## Explore the results
# These display controls depend on the completed test table. Changing a cutoff
# must update the selection, plots and summary without rerunning normalization
# or the statistical model. An effect-size display cutoff is not a test of a
# minimum effect size; a separate glmTreat analysis follows below.

# %%
#| name: fdr_control
fdr_cutoff <- ui$slider(
  0.01, 0.10,
  value = 0.05,
  step = 0.01,
  label = "BH FDR cutoff"
)
fdr_cutoff

# %%
#| name: effect_control
effect_cutoff <- ui$slider(
  0, 2,
  value = 0.5,
  step = 0.1,
  label = "Minimum absolute log2 fold change (display)"
)
effect_cutoff

# %%
#| name: display_results
display_results <- de_results
display_results$selected <- display_results$FDR <= fdr_cutoff$value &
  abs(display_results$logFC) >= effect_cutoff$value
display_results$direction <- ifelse(
  display_results$selected,
  ifelse(display_results$logFC > 0, "up", "down"),
  "not_selected"
)
display_results$negative_log10_fdr <- -log10(
  pmax(display_results$FDR, .Machine$double.xmin)
)
selected_results <- display_results[
  display_results$selected,
  c("gene_id", "logFC", "logCPM", "PValue", "FDR", "direction")
]
head(selected_results, 20)

# %%
#| name: selection_summary
selection_summary <- data.frame(
  fdr_cutoff = fdr_cutoff$value,
  effect_cutoff = effect_cutoff$value,
  tested_genes = nrow(display_results),
  selected_genes = nrow(selected_results),
  up = sum(selected_results$direction == "up"),
  down = sum(selected_results$direction == "down")
)
selection_count <- nrow(selected_results)
selection_summary

# %%
#| name: volcano_plot
volcano_plot <- ggplot2::ggplot(
  display_results,
  ggplot2::aes(
    x = .data$logFC,
    y = .data$negative_log10_fdr,
    colour = .data$direction
  )
) +
  ggplot2::geom_point(alpha = 0.5, size = 0.9) +
  ggplot2::geom_vline(
    xintercept = c(-effect_cutoff$value, effect_cutoff$value),
    linetype = "dashed"
  ) +
  ggplot2::geom_hline(
    yintercept = -log10(fdr_cutoff$value),
    linetype = "dashed"
  ) +
  ggplot2::scale_colour_manual(values = direction_colours) +
  ggplot2::labs(
    title = "Differential expression: treated versus control",
    subtitle = sprintf("%d genes meet the display criteria", selection_count),
    x = "Log2 fold change (treated / control)",
    y = "-log10 BH-adjusted p-value",
    colour = "Selection"
  ) +
  analysis_theme
volcano_plot

# %%
#| name: mean_difference_plot
mean_difference_plot <- ggplot2::ggplot(
  display_results,
  ggplot2::aes(
    x = .data$logCPM,
    y = .data$logFC,
    colour = .data$direction
  )
) +
  ggplot2::geom_point(alpha = 0.4, size = 0.8) +
  ggplot2::geom_hline(yintercept = 0, colour = "#545B64") +
  ggplot2::scale_colour_manual(values = direction_colours) +
  ggplot2::labs(
    title = "Effect size across expression abundance",
    x = "Average log2 CPM",
    y = "Log2 fold change (treated / control)",
    colour = "Selection"
  ) +
  analysis_theme
mean_difference_plot

# %%
#| name: top_gene_heatmap_data
heatmap_gene_ids <- head(de_results$gene_id, 30)
heatmap_expression <- log_cpm[heatmap_gene_ids, , drop = FALSE]
heatmap_centered <- heatmap_expression - rowMeans(heatmap_expression)
heatmap_order <- order(samples$condition, samples$batch, samples$sample_id)
heatmap_data <- data.frame(
  gene_id = rep(rownames(heatmap_centered), times = ncol(heatmap_centered)),
  sample_id = rep(colnames(heatmap_centered), each = nrow(heatmap_centered)),
  centered_log_cpm = as.vector(heatmap_centered),
  stringsAsFactors = FALSE
)
heatmap_data$gene_id <- factor(
  heatmap_data$gene_id,
  levels = rev(heatmap_gene_ids)
)
heatmap_data$sample_id <- factor(
  heatmap_data$sample_id,
  levels = samples$sample_id[heatmap_order]
)

# %%
#| name: top_gene_heatmap
top_gene_heatmap <- ggplot2::ggplot(
  heatmap_data,
  ggplot2::aes(
    x = .data$sample_id,
    y = .data$gene_id,
    fill = .data$centered_log_cpm
  )
) +
  ggplot2::geom_tile() +
  ggplot2::scale_fill_gradient2(
    low = "#2878A5",
    mid = "#FAFAFA",
    high = "#B94A48",
    midpoint = 0
  ) +
  ggplot2::labs(
    title = "Top 30 genes by statistical evidence",
    subtitle = "Gene-centered log2 CPM; samples ordered by condition and batch",
    x = "Sample", y = "Simulated gene", fill = "Centered\nlog2 CPM"
  ) +
  analysis_theme +
  ggplot2::theme(axis.text.y = ggplot2::element_text(size = 7))
top_gene_heatmap

# %%
#| name: gene_control
gene_choice <- ui$dropdown(
  choices = head(de_results$gene_id, 20),
  value = de_results$gene_id[1],
  label = "Inspect a leading gene"
)
gene_choice

# %%
#| name: selected_gene_data
selected_gene_id <- gene_choice$value
selected_gene_data <- data.frame(
  samples,
  raw_count = as.numeric(counts[selected_gene_id, ]),
  log_cpm = as.numeric(log_cpm[selected_gene_id, ]),
  normalized_cpm = as.numeric(edgeR::cpm(dge_normalized)[selected_gene_id, ])
)
selected_gene_statistics <- de_results[
  de_results$gene_id == selected_gene_id,
  , drop = FALSE
]
stopifnot(
  nrow(selected_gene_statistics) == 1L,
  nrow(selected_gene_data) == nrow(samples)
)
selected_gene_statistics

# %%
#| name: selected_gene_plot
selected_gene_plot <- ggplot2::ggplot(
  selected_gene_data,
  ggplot2::aes(
    x = .data$condition,
    y = .data$log_cpm,
    colour = .data$condition,
    shape = .data$batch
  )
) +
  ggplot2::geom_point(
    size = 3,
    position = ggplot2::position_jitter(width = 0.1, height = 0, seed = 42)
  ) +
  ggplot2::scale_colour_manual(values = condition_colours) +
  ggplot2::labs(
    title = paste("Expression of", selected_gene_id),
    subtitle = "Each point is one independent biological sample",
    x = "Condition", y = "Log2 CPM", colour = "Condition", shape = "Batch"
  ) +
  analysis_theme
selected_gene_plot

# %% [markdown]
#| name: minimum_effect_intro
# ## A separate minimum-effect hypothesis
# Filtering a zero-null test by estimated fold change is a display decision.
# glmTreat instead tests against a prespecified minimum effect. Its adjusted
# p-values answer a different question and are reported in a separate table.
# The minimum effect here is fixed at log2(1.5), independent of the UI controls.

# %%
#| name: minimum_effect_test
treat_log2_threshold <- log2(1.5)
treat_test <- edgeR::glmTreat(
  ql_fit,
  coef = "conditiontreated",
  lfc = treat_log2_threshold
)
treat_results <- edgeR::topTags(
  treat_test,
  n = Inf,
  adjust.method = "BH",
  sort.by = "PValue"
)$table
treat_results$gene_id <- rownames(treat_results)
treat_results <- treat_results[, c("gene_id", "logFC", "logCPM", "PValue", "FDR")]
treat_summary <- data.frame(
  null = "Absolute effect does not exceed the specified threshold",
  minimum_fold_change = 2^treat_log2_threshold,
  tested = nrow(treat_results),
  discoveries = sum(treat_results$FDR <= analysis_settings$fdr)
)
treat_summary

# %%
#| name: threshold_sensitivity
threshold_grid <- expand.grid(
  fdr = c(0.01, 0.05, 0.10),
  absolute_log2fc = c(0, 0.5, 1),
  KEEP.OUT.ATTRS = FALSE
)
threshold_sensitivity <- do.call(rbind, lapply(
  seq_len(nrow(threshold_grid)),
  function(index) {
    fdr <- threshold_grid$fdr[index]
    effect <- threshold_grid$absolute_log2fc[index]
    selected <- de_results$FDR <= fdr & abs(de_results$logFC) >= effect
    data.frame(
      fdr = fdr,
      absolute_log2fc = effect,
      selected = sum(selected),
      up = sum(selected & de_results$logFC > 0),
      down = sum(selected & de_results$logFC < 0)
    )
  }
))
threshold_sensitivity

# %%
#| name: sensitivity_plot
sensitivity_plot <- ggplot2::ggplot(
  threshold_sensitivity,
  ggplot2::aes(
    x = factor(.data$fdr),
    y = factor(.data$absolute_log2fc),
    fill = .data$selected
  )
) +
  ggplot2::geom_tile(colour = "white", linewidth = 1) +
  ggplot2::geom_text(ggplot2::aes(label = .data$selected)) +
  ggplot2::scale_fill_gradient(low = "#F4EAD5", high = "#75B6CB") +
  ggplot2::labs(
    title = "Selection sensitivity to display cutoffs",
    subtitle = "Descriptive comparison; not a search for an optimal cutoff",
    x = "BH FDR cutoff",
    y = "Minimum absolute log2 fold change",
    fill = "Genes"
  ) +
  analysis_theme
sensitivity_plot

# %% [markdown]
#| name: truth_intro
# ## Simulation checks
# Known effects let us check directions and quantify recovery in this one
# realization. The realized false-discovery proportion is not a guarantee of
# long-run FDR control. A power/calibration study would need repeated simulations.
# The tested-gene universe is the expression-filtered universe, not all genes.

# %%
#| name: truth_alignment
benchmark_results <- merge(
  de_results,
  gene_annotation[, c("gene_id", "true_log2fc", "truth")],
  by = "gene_id",
  sort = FALSE
)
benchmark_results <- benchmark_results[
  match(de_results$gene_id, benchmark_results$gene_id),
  , drop = FALSE
]
benchmark_results$is_alternative <- benchmark_results$true_log2fc != 0
benchmark_results$discovered <- benchmark_results$FDR <= analysis_settings$fdr
stopifnot(
  identical(benchmark_results$gene_id, de_results$gene_id),
  !anyNA(benchmark_results$true_log2fc),
  sum(gene_annotation$truth == "up") == analysis_settings$truth_up,
  sum(gene_annotation$truth == "down") == analysis_settings$truth_down
)

# %%
#| name: recovery_metrics
recovery_metrics <- data.frame(
  true_positives = sum(
    benchmark_results$discovered & benchmark_results$is_alternative
  ),
  false_positives = sum(
    benchmark_results$discovered & !benchmark_results$is_alternative
  ),
  false_negatives = sum(
    !benchmark_results$discovered & benchmark_results$is_alternative
  ),
  true_negatives = sum(
    !benchmark_results$discovered & !benchmark_results$is_alternative
  )
)
recovery_metrics$recall <- recovery_metrics$true_positives /
  sum(benchmark_results$is_alternative)
recovery_metrics$realized_fdp <- recovery_metrics$false_positives /
  max(1, sum(benchmark_results$discovered))
recovery_metrics$direction_agreement <- mean(
  sign(benchmark_results$logFC[benchmark_results$is_alternative]) ==
    sign(benchmark_results$true_log2fc[benchmark_results$is_alternative])
)
recovery_metrics

# %%
#| name: effect_recovery
effect_recovery <- do.call(rbind, lapply(
  c("down", "null", "up"),
  function(direction) {
    values <- benchmark_results[
      benchmark_results$truth == direction,
      , drop = FALSE
    ]
    data.frame(
      truth = direction,
      genes = nrow(values),
      median_estimated_log2fc = stats::median(values$logFC),
      median_true_log2fc = stats::median(values$true_log2fc),
      median_bias = stats::median(values$logFC - values$true_log2fc),
      rmse = sqrt(mean((values$logFC - values$true_log2fc)^2)),
      discoveries = sum(values$discovered)
    )
  }
))
effect_recovery

# %%
#| name: effect_recovery_plot
effect_recovery_plot <- ggplot2::ggplot(
  benchmark_results,
  ggplot2::aes(
    x = factor(.data$truth, levels = c("down", "null", "up")),
    y = .data$logFC
  )
) +
  ggplot2::geom_boxplot(outlier.shape = NA, fill = "#B9D9E6", width = 0.6) +
  ggplot2::geom_hline(yintercept = 0, linetype = "dashed") +
  ggplot2::labs(
    title = "Estimated effects by planted truth",
    subtitle = "Planted nonzero effects are -1.5 and +1.5 log2 units",
    x = "Simulation truth",
    y = "Estimated log2 fold change"
  ) +
  analysis_theme
effect_recovery_plot

# %%
#| name: null_p_value_check
null_p_values <- benchmark_results$PValue[!benchmark_results$is_alternative]
null_p_value_check <- data.frame(
  nominal = c(0.001, 0.01, 0.05, 0.10),
  observed_fraction = vapply(
    c(0.001, 0.01, 0.05, 0.10),
    function(cutoff) mean(null_p_values <= cutoff),
    numeric(1)
  ),
  null_genes = length(null_p_values)
)
null_p_value_check

# %%
#| name: expression_stratified_recovery
stratified_results <- benchmark_results
stratified_results$abundance_bin <- cut(
  stratified_results$logCPM,
  breaks = unique(stats::quantile(
    stratified_results$logCPM,
    probs = seq(0, 1, by = 0.25)
  )),
  include.lowest = TRUE
)
stratified_recovery <- do.call(rbind, lapply(
  levels(stratified_results$abundance_bin),
  function(bin) {
    selected <- stratified_results$abundance_bin == bin
    alternative <- selected & stratified_results$is_alternative
    discoveries <- selected & stratified_results$discovered
    data.frame(
      abundance_bin = bin,
      tested = sum(selected),
      alternatives = sum(alternative),
      discoveries = sum(discoveries),
      recovered = sum(alternative & stratified_results$discovered),
      recall = sum(alternative & stratified_results$discovered) /
        max(1, sum(alternative)),
      realized_fdp = sum(discoveries & !stratified_results$is_alternative) /
        max(1, sum(discoveries))
    )
  }
))
stratified_recovery

# %% [markdown]
#| name: deliverables_intro
# ## Deliverables and reproducibility
# Complete tables and QC objects remain available as ordinary R values below.
# The notebook does not write analysis files automatically when widgets change.
# To export from a sourced environment, use write.csv(results$de_results, path)
# or saveRDS(results$analysis_bundle, path) with an explicit destination.
# For real data, replace the simulated input with a gene-by-sample integer
# count matrix and matching sample metadata; reevaluate design and QC decisions.

# %%
#| name: analysis_manifest
analysis_manifest <- data.frame(
  key = c(
    "dataset", "seed", "genes_input", "genes_tested", "samples",
    "design", "coefficient", "normalization", "test",
    "multiple_testing", "minimum_effect_test", "R_version"
  ),
  value = c(
    "Synthetic negative-binomial bulk RNA-seq counts",
    as.character(analysis_settings$seed),
    as.character(nrow(counts)),
    as.character(nrow(de_results)),
    as.character(ncol(counts)),
    "~ batch + condition",
    "conditiontreated",
    "TMM",
    "Robust quasi-likelihood F-test",
    "Benjamini-Hochberg over retained genes",
    "glmTreat with lfc = log2(1.5)",
    as.character(getRversion())
  ),
  stringsAsFactors = FALSE
)
analysis_manifest

# %%
#| name: deliverable_bundle
analysis_bundle <- list(
  manifest = analysis_manifest,
  packages = package_versions,
  settings = analysis_settings,
  sample_metadata = samples,
  sample_qc = sample_qc,
  filtering = filter_summary,
  normalization = normalization_qc,
  design = design,
  differential_expression = de_results,
  minimum_effect_results = treat_results,
  selected_results = selected_results,
  threshold_sensitivity = threshold_sensitivity,
  simulation_recovery = recovery_metrics
)
bundle_inventory <- data.frame(
  component = names(analysis_bundle),
  size_kib = vapply(
    analysis_bundle,
    function(component) as.numeric(object.size(component)) / 1024,
    numeric(1)
  )
)
bundle_inventory

# %%
#| name: analysis_checks
analysis_checks <- c(
  input_samples_aligned = identical(colnames(counts), samples$sample_id),
  filtered_genes_aligned = identical(rownames(log_cpm), rownames(dge_normalized)),
  full_rank_design = qr(design)$rank == ncol(design),
  retained_gene_count = nrow(de_results) == sum(keep_genes),
  finite_coefficients = all(is.finite(ql_fit$coefficients)),
  fdr_reproduces_bh = isTRUE(all.equal(
    de_results$FDR, stats::p.adjust(de_results$PValue, "BH")
  )),
  selection_reconciles = selection_count == sum(display_results$selected),
  direction_recovery = recovery_metrics$direction_agreement > 0.9,
  nontrivial_signal_recovery = recovery_metrics$recall > 0.5,
  up_effect_positive = effect_recovery$median_estimated_log2fc[
    effect_recovery$truth == "up"
  ] > 0,
  down_effect_negative = effect_recovery$median_estimated_log2fc[
    effect_recovery$truth == "down"
  ] < 0
)
stopifnot(all(analysis_checks))
data.frame(check = names(analysis_checks), passed = unname(analysis_checks))

# %%
#| name: final_summary
validation_signature <- c(
  input_genes = nrow(counts),
  samples = ncol(counts),
  tested = nrow(de_results),
  selected = selection_count,
  discoveries = overall_de_summary$significant,
  coefficient_sum = sum(ql_fit$coefficients),
  p_value_sum = sum(de_results$PValue),
  fdr_sum = sum(de_results$FDR),
  recall = recovery_metrics$recall,
  realized_fdp = recovery_metrics$realized_fdp
)
summary_text <- sprintf(
  "BULK_DE_COMPLETE genes=%d samples=%d tested=%d selected=%d discoveries=%d",
  nrow(counts), ncol(counts), nrow(de_results),
  selection_count, overall_de_summary$significant
)
summary_text

"""The quant research stack: predictive models (features -> forecast -> trading rule) and volatility models (HAR-RV vs
implied vol -> options trades), validated the way real quant shops do it: walk-forward retraining with a purge gap,
out-of-sample information coefficients, permutation nulls, a sealed holdout, costs, and a multiple-testing bar."""

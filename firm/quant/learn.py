"""Learners. Linear models in numpy (fast, transparent); gradient-boosted trees from scikit-learn when it's installed.
Each fit() returns a Model with predict(X) and importance() (which features drive the forecast)."""
import numpy as np

try:
    from sklearn.ensemble import HistGradientBoostingRegressor
except Exception:          # scikit-learn not installed: trees are unavailable, linear models still work
    HistGradientBoostingRegressor = None

LEARNERS = {
    "ridge": "ridge regression (linear, shrunk toward zero)",
    "logit": "logistic regression (probability the move is up)",
    "gbm": "gradient-boosted trees (non-linear, interactions)",
    "ensemble": "average of ridge and gradient-boosted trees",
}


def available():
    return [k for k in LEARNERS if HistGradientBoostingRegressor is not None or k in ("ridge", "logit")]


class Model:
    def __init__(self, kind, mu, sd, coef=None, b0=0.0, tree=None, parts=None):
        self.kind, self.mu, self.sd, self.coef, self.b0, self.tree, self.parts = kind, mu, sd, coef, b0, tree, parts

    def _z(self, X):
        Z = (np.asarray(X, float) - self.mu) / self.sd
        return np.nan_to_num(Z, nan=0.0)                     # a missing feature counts as "average"

    def predict(self, X):
        if self.kind == "ensemble":
            a, b = (m.predict(X) for m in self.parts)
            return 0.5 * (a / (np.std(a) or 1)) + 0.5 * (b / (np.std(b) or 1))
        Z = self._z(X)
        if self.kind == "gbm":
            return self.tree.predict(Z)
        p = Z @ self.coef + self.b0
        return 1 / (1 + np.exp(-p)) - 0.5 if self.kind == "logit" else p

    def importance(self, names):
        if self.kind == "ensemble":
            a, b = self.parts[0].importance(names), self.parts[1].importance(names)
            return {k: 0.5 * a.get(k, 0) + 0.5 * b.get(k, 0) for k in names}
        if self.kind == "gbm":
            return {k: float(v) for k, v in zip(names, getattr(self, "imp", [0.0] * len(names)))}
        w = np.abs(self.coef)
        tot = w.sum() or 1
        return {k: float(v / tot) for k, v in zip(names, w)}

    def signed(self, names):
        """Direction of each linear effect (+: higher value -> higher forecast)."""
        if self.kind in ("ridge", "logit"):
            return {k: float(np.sign(v)) for k, v in zip(names, self.coef)}
        if self.kind == "ensemble":
            return self.parts[0].signed(names)
        return {}


def fit(kind, X, y, alpha=10.0, seed=0):
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    mu = np.nanmean(X, axis=0)
    sd = np.nanstd(X, axis=0)
    sd[~np.isfinite(sd) | (sd < 1e-9)] = 1.0
    mu[~np.isfinite(mu)] = 0.0
    if kind == "ensemble":
        return Model("ensemble", mu, sd, parts=[fit("ridge", X, y, alpha), fit("gbm", X, y, seed=seed)])
    m = Model(kind, mu, sd)
    Z = m._z(X)
    n, k = Z.shape
    if kind == "ridge":
        ym = y.mean()
        A = Z.T @ Z + alpha * n / 100 * np.eye(k)
        m.coef = np.linalg.solve(A, Z.T @ (y - ym))
        m.b0 = ym
    elif kind == "logit":
        t = (y > 0).astype(float)
        w, b = np.zeros(k), 0.0
        lam = alpha / 100
        for _ in range(25):                                     # Newton / IRLS with an L2 penalty
            p = 1 / (1 + np.exp(-(Z @ w + b)))
            g = Z.T @ (p - t) / n + lam * w
            W = p * (1 - p)
            H = (Z * W[:, None]).T @ Z / n + lam * np.eye(k)
            step = np.linalg.solve(H, g)
            w -= step
            b -= float((p - t).mean() / max(W.mean(), 1e-6))
            if np.abs(step).max() < 1e-6:
                break
        m.coef, m.b0 = w, b
    elif kind == "gbm":
        if HistGradientBoostingRegressor is None:
            raise RuntimeError("gradient-boosted trees need scikit-learn")
        m.tree = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=120, min_samples_leaf=300,
                                               l2_regularization=1.0, random_state=seed).fit(Z, y)
        # permutation importance on a slice of the training data (cheap, model-agnostic)
        rng = np.random.default_rng(seed)
        idx = rng.choice(n, size=min(n, 6000), replace=False)
        Zs, ys = Z[idx], y[idx]
        base = np.mean((m.tree.predict(Zs) - ys) ** 2)
        imp = []
        for j in range(k):
            Zp = Zs.copy()
            Zp[:, j] = rng.permutation(Zp[:, j])
            imp.append(max(0.0, np.mean((m.tree.predict(Zp) - ys) ** 2) - base))
        tot = sum(imp) or 1
        m.imp = [v / tot for v in imp]
    else:
        raise ValueError(kind)
    return m

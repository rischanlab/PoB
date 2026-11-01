"""Plot the baseline real-data replay (data/results/real-replay-daily-baseline.csv).

Usage: python3 scripts/plot-real-replay.py [OUT.pdf]
Default output: figures/real-replay-baseline.pdf (used in the paper).
"""
import csv
import datetime as dt
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

out = sys.argv[1] if len(sys.argv) > 1 else "figures/real-replay-baseline.pdf"
rows = list(csv.DictReader(open("data/results/real-replay-daily-baseline.csv")))
d = [dt.date.fromisoformat(r["date"]) for r in rows]
obs = [float(r["observed_value_usd"]) / 1e9 for r in rows]
mod = [float(r["model_token_liabilities_usd"]) / 1e9 for r in rows]
bcr = [float(r["onchain_bcr_pct"]) if r["onchain_bcr_pct"] else None for r in rows]
pend = [float(r["pending_usd"]) / 1e6 for r in rows]

BLUE, ORANGE, INK, MUTED, GRID = "#2a78d6", "#eb6834", "#1f1f1e", "#6b6a64", "#e4e3de"
plt.rcParams.update({"font.size": 8, "axes.edgecolor": MUTED, "axes.labelcolor": INK,
                     "xtick.color": MUTED, "ytick.color": MUTED, "axes.spines.top": False,
                     "axes.spines.right": False})
fig, ax = plt.subplots(3, 1, figsize=(7.0, 5.2), sharex=True,
                       gridspec_kw={"height_ratios": [1.2, 1, 0.8]})
ax[0].plot(d, obs, color=BLUE, lw=1.4, label="Observed USDY token value, RWA.xyz (proxy liability)")
ax[0].plot(d, mod, color=ORANGE, lw=1.4, ls="--", label="Modelled token liabilities")
ax[0].set_ylabel("USD billion")
ax[0].legend(frameon=False, loc="upper left")
ax[1].plot(d, [b if b is not None else float("nan") for b in bcr], color=BLUE, lw=1.2)
ax[1].axhline(101, color=MUTED, lw=1, ls=":")
ax[1].text(d[5], 101.08, r"$\theta_S$ = 101%", color=MUTED, fontsize=7)
ax[1].set_ylabel("On-chain BCR (%)")
ax[2].fill_between(d, pend, color=BLUE, alpha=0.35, lw=0)
ax[2].plot(d, pend, color=BLUE, lw=0.8)
ax[2].set_ylabel("Pending (USD m)")
for a in ax:
    a.grid(axis="y", color=GRID, lw=0.6)
ax[2].xaxis.set_major_locator(mdates.MonthLocator(bymonth=[1, 7]))
ax[2].xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
fig.align_ylabels(ax)
fig.tight_layout()
fig.savefig(out)
fig.savefig(out.replace(".pdf", ".png"), dpi=160)
print("wrote", out)

"""Render versioned benchmark receipts as accessible SVGs. Requires matplotlib 3.11.2.

Run from the repository root with --native <receipt> and/or --frameworks <receipt>.
Images are derived from the recorded measurements, with no hand-entered bar values.
"""

import argparse
import copy
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/performance"
ORANGE = "#E8501F"
INK = "#14181F"
GREEN = "#245c4f"
GRAY = "#dce3e1"
SVG = "http://www.w3.org/2000/svg"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
                     "text.color": INK, "axes.labelcolor": INK,
                     "svg.fonttype": "none", "svg.hashsalt": "html-next-performance"})


def save(fig, name, title, description):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    fig.savefig(path, format="svg", facecolor="white", metadata={"Date": None})
    plt.close(fig)
    ET.register_namespace("", SVG)
    tree = ET.parse(path)
    root = tree.getroot()
    root.set("role", "img")
    root.set("aria-labelledby", "chart-title chart-description")
    ET.SubElement(root, f"{{{SVG}}}title", {"id": "chart-title"}).text = title
    ET.SubElement(root, f"{{{SVG}}}desc", {"id": "chart-description"}).text = description
    mark = ET.parse(ROOT / "assets/brand/html-next-mark.svg").getroot()
    # Inline the official mark so package registries need no secondary image fetch.
    mark.set("x", "24")
    mark.set("y", "18")
    mark.set("width", "29")
    mark.set("height", "29")
    root.append(copy.deepcopy(mark))
    tree.write(path, encoding="utf-8", xml_declaration=True)
    print(path.relative_to(ROOT))


def style(ax):
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color(GRAY)
    ax.tick_params(axis="y", length=0)
    ax.tick_params(axis="x", colors=GREEN)
    ax.set_axisbelow(True)
    ax.grid(axis="x", color="#eef1f0")
    ax.invert_yaxis()


def native(path):
    data = json.loads(path.read_text())
    labels = {"card": "Escaped card", "cart-100": "Computed cart · 100 rows",
              "list-10": "Product list · 10 rows", "list-100": "Product list · 100 rows",
              "list-1000": "Product list · 1,000 rows"}
    cases = data["cases"]
    ratios = [c["medianNativeFluidRatio"] for c in cases]
    fig, ax = plt.subplots(figsize=(10, 6.4))
    fig.subplots_adjust(left=.29, right=.91, bottom=.27, top=.72)
    fig.text(.085, .925, "HTML Next for C#", fontsize=18, weight="bold")
    fig.text(.055, .84, "23–37% less rendering time than Fluid", fontsize=21, weight="bold")
    fig.text(.055, .79, "Five warm template workloads · lower is better", color=GREEN)
    ax.barh(range(len(cases)), [1] * len(cases), color=GRAY, height=.58, label="Fluid 2.41.1 = 1.00")
    ax.barh(range(len(cases)), ratios, color=ORANGE, height=.34, label="HTML Next alpha.2")
    ax.set_yticks(range(len(cases)), [labels[c["name"]] for c in cases])
    ax.set_xlim(0, 1.12)
    ax.set_xlabel("Rendering time relative to Fluid (the .NET Liquid engine)", labelpad=12)
    for i, ratio in enumerate(ratios):
        ax.text(1.025, i, f"{(1-ratio)*100:.0f}% less", va="center", fontsize=10, color=INK)
    style(ax)
    fig.legend(*ax.get_legend_handles_labels(), loc="upper left",
               bbox_to_anchor=(.055, .175), frameon=False, ncol=2, borderaxespad=0)
    fig.text(.055, .115, "November 10, 2026 · Apple M4 Pro · .NET 10.0.5 · BenchmarkDotNet 0.15.8", fontsize=9)
    fig.text(.055, .08, "Median of three independent within-run ratios. Complete equivalent outputs checked before timing.", fontsize=9)
    fig.text(.055, .045, "Compile/parse once; warm inert Render only. HTTP, cold requests and interactive graphs are not measured.", fontsize=9)
    save(fig, "native-fluid-2026-11-10.svg", "HTML Next C# rendering compared with Fluid",
         "; ".join(f"{labels[c['name']]}: {r:.3f} times Fluid rendering time" for c, r in zip(cases, ratios))
         + ". Three independent warm-rendering runs on one Apple M4 Pro. See the linked benchmark receipt and limitations.")


def frameworks(path):
    data = json.loads(path.read_text())
    assert data["complete"] and data["runner_success"] and data["standard_samples"]
    assert data["protocol"] == "full_standard"
    entries = [("HTML Next · Vite", "html-next-vite-candidate"),
               ("HTML Next · live", "html-next-live-candidate"),
               ("Vanilla JavaScript", "vanillajs"), ("Solid", "solid"),
               ("Svelte", "svelte"), ("Vue", "vue"), ("React Hooks", "react-hooks")]
    scores = []
    sizes = []
    labels = []
    for label, entry in entries:
        keys = [k for k in data["scores"] if k.startswith(entry + "-")]
        assert len(keys) == 1, (entry, keys)
        scores.append(data["scores"][keys[0]])
        sizes.append(data["bundles"][entry]["gzip"] / 1024)
        version = keys[0][len(entry) + 1:].removesuffix("-keyed").split("+")[0]
        labels.append(label + (" " + version if version.startswith("v") else ""))
    colors = [ORANGE, "#b45432"] + [GREEN] * 5
    fig, axes = plt.subplots(1, 2, figsize=(12, 7.4))
    fig.subplots_adjust(left=.23, right=.94, top=.72, bottom=.29, wspace=.35)
    fig.text(.075, .935, "HTML Next in js-framework-benchmark", fontsize=20, weight="bold")
    fig.text(.055, .855, "Browser update speed and shipped JavaScript", fontsize=20, weight="bold")
    fig.text(.055, .81, "All seven entries · nine keyed workloads · lower is better", color=GREEN)
    for ax, values, xlabel in zip(axes, [scores, sizes],
                                  ["Weighted duration score", "Benchmark app JavaScript · KiB gzip"]):
        bars = ax.barh(range(len(entries)), values, color=colors, height=.58)
        ax.set_yticks(range(len(entries)), labels if ax is axes[0] else [""] * len(entries))
        ax.set_xlim(0, max(values) * 1.2)
        ax.set_xlabel(xlabel, labelpad=12, fontsize=10)
        for bar, value in zip(bars, values):
            ax.text(value + max(values) * .025, bar.get_y() + bar.get_height()/2,
                    f"{value:.2f}", va="center", fontsize=10)
        style(ax)
    fig.text(.055, .19, "One full standard sweep · 15 CPU samples per workload, 25 for selection · November 10, 2026", fontsize=10)
    fig.text(.055, .145, "Duration: weighted geometric mean of medians, normalized to each workload's fastest entry.", fontsize=9)
    fig.text(.055, .11, "Size: the production benchmark app plus its used runtime, gzip level 6. This is not npm package size.", fontsize=9)
    fig.text(.055, .075, "Apple M4 Pro · pinned fork 1ff9927 · SDK alpha.94. Individual workloads can rank differently.", fontsize=9)
    fig.text(.055, .04, "Browser rendering only; this comparison does not measure server rendering or hydration.", fontsize=9)
    save(fig, "frameworks-speed-size-2026-11-10.svg", "HTML Next framework speed and JavaScript size comparison",
         "; ".join(f"{label}: duration score {score:.3f}, {size:.2f} KiB gzip" for label, score, size in zip(labels, scores, sizes))
         + ". One full standard js-framework-benchmark sweep. Lower is better. See the linked raw data and method.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--frameworks", type=Path)
    args = parser.parse_args()
    if not args.native and not args.frameworks:
        parser.error("provide --native and/or --frameworks")
    if args.native:
        native(args.native)
    if args.frameworks:
        frameworks(args.frameworks)

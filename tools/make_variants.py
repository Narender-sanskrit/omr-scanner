#!/usr/bin/env python3
"""Prove the app is not tied to the default 90-question sheet.

Builds several differently-shaped sheets (30 questions, 5 options, no
class/section field, ...), renders them, fakes a phone photo of each, and
writes template + truth + raw grayscale so test_variants.js can check them.
"""
import copy
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_sheet as G  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "samples", "variants")

BASE_FIELDS = copy.deepcopy(G.DEFAULT_TEMPLATE["fields"])


def variant(name, count, columns, options, per_row_pitch, col_pitch,
            fields="all", x0=130, y0=560):
    tpl = copy.deepcopy(G.DEFAULT_TEMPLATE)
    tpl["name"] = name
    tpl["questions"] = {
        "count": count, "columns": columns, "perColumn": count // columns,
        "options": options, "x0": x0, "y0": y0,
        "dxOption": 40, "dyRow": per_row_pitch, "dxColumn": col_pitch, "r": 7.5,
    }
    tpl["optionLabels"] = list("ABCDEFGHIJ")[:options]
    if fields == "rollonly":
        tpl["fields"] = [BASE_FIELDS[0]]
    elif fields == "none":
        tpl["fields"] = []
    else:
        tpl["fields"] = copy.deepcopy(BASE_FIELDS)
    return tpl


VARIANTS = [
    # name,        questions, cols, options, rowPitch, colPitch, fields
    ("q30-1col", 30, 1, 4, 25, 310, "all"),
    ("q30-2col", 30, 2, 4, 40, 400, "all"),
    ("q20-5opt", 20, 1, 5, 33, 310, "rollonly"),
    ("q51-3col", 51, 3, 4, 40, 310, "all"),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(11)
    summary = []

    for (name, count, cols, opts, pitch, cpitch, fields) in VARIANTS:
        tpl = variant(name, count, cols, opts, pitch, cpitch, fields)

        # fill: one answer per question, plus one deliberate double mark
        answers, truth_answers = {}, {}
        for qi in range(count):
            if qi == 3:
                answers[qi] = [0, min(2, opts - 1)]      # double mark
                truth_answers[qi] = answers[qi]
            elif qi == 7:
                continue                                  # left blank
            else:
                a = int(rng.integers(0, opts))
                answers[qi] = [a]
                truth_answers[qi] = [a]

        fills = {"answers": answers, "ink": 55,
                 "fields": {"roll": "24680", "class": "12", "section": "C"}}
        sheet = G.render_sheet(tpl, 300, fills)

        quad = [[120, 90], [1520, 160], [1460, 2130], [80, 2060]]
        photo = G.warp_photo(sheet, quad, 1600, 2200, seed=abs(hash(name)) % 1000)

        stem = os.path.join(OUT, name)
        photo.save(stem + ".jpg", quality=85, optimize=True)
        with open(stem + ".raw", "wb") as f:
            f.write(np.array(photo, dtype=np.uint8).tobytes())
        with open(stem + ".template.json", "w") as f:
            json.dump(tpl, f, indent=2)
        with open(stem + ".truth.json", "w") as f:
            json.dump({
                "count": count, "options": opts,
                "roll": "24680", "class": "12", "section": "C",
                "answers": {str(k): v for k, v in truth_answers.items()},
                "blank": [7], "multi": [3],
                "size": [photo.width, photo.height],
            }, f, indent=2)
        summary.append((name, count, opts, fields))

    for row in summary:
        print("built", row)
    print("in", OUT)


if __name__ == "__main__":
    main()

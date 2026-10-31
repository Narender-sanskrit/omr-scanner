#!/usr/bin/env python3
"""
OMR Sheet Generator + synthetic test-sheet maker.

Outputs:
  samples/omr-sheet-blank.png / .pdf   -> printable default sheet (A4)
  templates/default-a4-90q.json        -> bubble coordinates (canonical space)
  samples/demo-*.jpg                   -> fake "phone photos" for testing
  samples/demo-*.raw                   -> raw grayscale dumps for the Node test

Canonical space is 1000 x 1414 units == A4 (210 x 297 mm).
Every template stores bubble centres in that space, so the scanner only has to
map the four corner markers and everything else follows.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# --------------------------------------------------------------------------
# default template
# --------------------------------------------------------------------------
DEFAULT_TEMPLATE = {
    "name": "Default A4 - 90 Questions x 4 Options",
    "version": 2,
    "canvas": {"w": 1000, "h": 1414},
    # order is always: top-left, top-right, bottom-right, bottom-left
    "markers": [[70, 70], [930, 70], [930, 1344], [70, 1344]],
    "markerSize": 50,
    # each field is a column grid of bubbles. "labels" gives the rows,
    # "digits" is how many columns (one per character of the value).
    "fields": [
        {"key": "roll", "label": "ROLL NUMBER", "digits": 5,
         "labels": "0123456789", "x0": 110, "y0": 326, "dx": 34, "dy": 20, "r": 7},
        {"key": "class", "label": "CLASS", "digits": 2,
         "labels": "0123456789", "x0": 315, "y0": 326, "dx": 34, "dy": 20, "r": 7},
        {"key": "section", "label": "SECTION", "digits": 1,
         "labels": "ABCDEFGH", "x0": 430, "y0": 326, "dx": 34, "dy": 20, "r": 7},
    ],
    "questions": {
        "count": 90,
        "columns": 3,
        "perColumn": 30,
        "options": 4,
        "x0": 130, "y0": 566, "dxOption": 40, "dyRow": 24, "dxColumn": 310, "r": 7.5,
    },
    "optionLabels": ["A", "B", "C", "D"],
}


def px(v, dpi):
    """canonical units -> pixels at given dpi"""
    return v * dpi * 0.21 / 25.4


def font(size_canon, dpi, bold=False):
    try:
        return ImageFont.truetype(FONT_B if bold else FONT, max(6, int(px(size_canon, dpi))))
    except Exception:
        return ImageFont.load_default()


def bubble_centers_questions(tpl):
    q = tpl["questions"]
    out = []  # (q_index, opt_index, x, y)
    for i in range(q["count"]):
        col = i // q["perColumn"]
        row = i % q["perColumn"]
        x = q["x0"] + col * q["dxColumn"]
        y = q["y0"] + row * q["dyRow"]
        for o in range(q["options"]):
            out.append((i, o, x + o * q["dxOption"], y))
    return out


def template_fields(tpl):
    """normalise old (tpl["roll"]) and new (tpl["fields"]) templates"""
    if tpl.get("fields"):
        return tpl["fields"]
    r = tpl.get("roll")
    if not r:
        return []
    return [{"key": "roll", "label": "ROLL NUMBER", "digits": r["digits"],
             "labels": "0123456789"[: r["rows"]], "x0": r["x0"], "y0": r["y0"],
             "dx": r["dx"], "dy": r["dy"], "r": r["r"]}]


def bubble_centers_fields(tpl):
    out = []  # (field_key, char_index, row_index, x, y)
    for f in template_fields(tpl):
        for d in range(f["digits"]):
            for v in range(len(f["labels"])):
                out.append((f["key"], d, v, f["x0"] + d * f["dx"], f["y0"] + v * f["dy"]))
    return out


def render_sheet(tpl, dpi=300, fills=None):
    """fills = {"roll": [1,2,3,4,5], "answers": {q_index: [opt,...]}}"""
    fills = fills or {}
    s = dpi * 0.21 / 25.4
    W = int(round(tpl["canvas"]["w"] * s))
    H = int(round(tpl["canvas"]["h"] * s))
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    # ---- corner markers -------------------------------------------------
    half = tpl["markerSize"] / 2
    for (mx, my) in tpl["markers"]:
        d.rectangle([px(mx - half, dpi), px(my - half, dpi),
                     px(mx + half, dpi), px(my + half, dpi)], fill="black")

    # ---- header ---------------------------------------------------------
    d.text((px(70, dpi), px(108, dpi)), "OMR ANSWER SHEET",
           font=font(34, dpi, True), fill="black")
    d.text((px(70, dpi), px(150, dpi)), "Default A4  |  90 Questions  |  4 Options (A-D)",
           font=font(16, dpi), fill=(70, 70, 70))

    y = 182
    d.text((px(70, dpi), px(y, dpi)), "Name:", font=font(18, dpi), fill="black")
    d.line([px(150, dpi), px(y + 26, dpi), px(560, dpi), px(y + 26, dpi)], fill="black", width=2)
    y += 38
    d.text((px(70, dpi), px(y, dpi)), "Class / Section:", font=font(18, dpi), fill="black")
    d.line([px(250, dpi), px(y + 26, dpi), px(560, dpi), px(y + 26, dpi)], fill="black", width=2)
    d.text((px(600, dpi), px(y, dpi)), "Date:", font=font(18, dpi), fill="black")
    d.line([px(660, dpi), px(y + 26, dpi), px(930, dpi), px(y + 26, dpi)], fill="black", width=2)

    # instructions box
    box = [px(600, dpi), px(276, dpi), px(930, dpi), px(500, dpi)]
    d.rectangle(box, outline=(120, 120, 120), width=2)
    tips = [
        "INSTRUCTIONS",
        "1. Use a blue or black ball pen only.",
        "2. Fill one circle fully:",
        "3. Do not tick, cross or write on circles.",
        "4. More than one filled circle is marked",
        "    for manual review, not guessed.",
        "5. Fill class and section too.",
        "6. Do not fold or staple this sheet.",
    ]
    ty = 288
    for i, line in enumerate(tips):
        d.text((px(614, dpi), px(ty, dpi)), line,
               font=font(14 if i else 16, dpi, i == 0), fill="black")
        if i == 2:
            tw = d.textlength(line, font=font(14, dpi))
            cxp = px(614, dpi) + tw + px(22, dpi)
            d.ellipse([cxp - px(7, dpi), px(ty + 6, dpi) - px(7, dpi),
                       cxp + px(7, dpi), px(ty + 6, dpi) + px(7, dpi)], fill="black")
        ty += 28

    # ---- header field grids (roll / class / section) -------------------
    for f in template_fields(tpl):
        nrows = len(f["labels"])
        d.text((px(f["x0"] - 40, dpi), px(266, dpi)), f["label"],
               font=font(15, dpi, True), fill="black")
        # one light box around the whole field
        d.rectangle([px(f["x0"] - 16, dpi), px(f["y0"] - 16, dpi),
                     px(f["x0"] + (f["digits"] - 1) * f["dx"] + 16, dpi),
                     px(f["y0"] + (nrows - 1) * f["dy"] + 16, dpi)],
                    outline=(198, 198, 198), width=1)
        for col in range(f["digits"]):
            cx = f["x0"] + col * f["dx"]
            for v in range(nrows):
                cy = f["y0"] + v * f["dy"]
                rr = f["r"]
                d.ellipse([px(cx - rr, dpi), px(cy - rr, dpi),
                           px(cx + rr, dpi), px(cy + rr, dpi)],
                          outline="black", width=max(1, int(px(1.6, dpi))))
                if col == 0:
                    d.text((px(cx - 32, dpi), px(cy - 7, dpi)), f["labels"][v],
                           font=font(11, dpi), fill=(60, 60, 60))

    # ---- question grid --------------------------------------------------
    q = tpl["questions"]
    for i in range(q["count"]):
        col = i // q["perColumn"]
        row = i % q["perColumn"]
        x = q["x0"] + col * q["dxColumn"]
        y = q["y0"] + row * q["dyRow"]
        d.text((px(x - 34, dpi), px(y - 8, dpi)), f"{i + 1}.",
               font=font(13, dpi), fill="black")
        for o in range(q["options"]):
            cx = x + o * q["dxOption"]
            rr = q["r"]
            d.ellipse([px(cx - rr, dpi), px(y - rr, dpi),
                       px(cx + rr, dpi), px(y + rr, dpi)],
                      outline="black", width=max(1, int(px(1.6, dpi))))
            # letters go above the FIRST row only: on tightly packed rows a
            # per-row letter would sit on top of the bubble above it and read
            # as a stray mark.
            if row == 0:
                d.text((px(cx - 4, dpi), px(y - 22, dpi)), tpl["optionLabels"][o],
                       font=font(10, dpi), fill=(90, 90, 90))
        # column separator
        if row == 0 and col > 0:
            d.line([px(x - 70, dpi), px(y - 26, dpi), px(x - 70, dpi),
                    px(y + (q["perColumn"] - 1) * q["dyRow"] + 14, dpi)],
                   fill=(200, 200, 200), width=1)

    # ---- apply fills ----------------------------------------------------
    if fills:
        def fill_circle(cx, cy, rr, value):
            val = int(value)
            d.ellipse([px(cx - rr, dpi), px(cy - rr, dpi),
                       px(cx + rr, dpi), px(cy + rr, dpi)], fill=(val, val, val))

        ink = fills.get("ink", 55)
        fvals = fills.get("fields") or {}
        if fills.get("roll") and "roll" not in fvals:
            fvals = dict(fvals); fvals["roll"] = fills["roll"]
        for f in template_fields(tpl):
            val = fvals.get(f["key"])
            if not val:
                continue
            for dg, ch in enumerate(val):
                if dg >= f["digits"]:
                    break
                try:
                    v = f["labels"].index(str(ch))
                except ValueError:
                    continue
                cx = f["x0"] + dg * f["dx"]
                cy = f["y0"] + v * f["dy"]
                fill_circle(cx, cy, f["r"] * 0.82, ink)

        for qi, opts in (fills.get("answers") or {}).items():
            qi = int(qi)
            col = qi // q["perColumn"]
            row = qi % q["perColumn"]
            x = q["x0"] + col * q["dxColumn"]
            y = q["y0"] + row * q["dyRow"]
            for o in opts:
                fill_circle(x + o * q["dxOption"], y, q["r"] * 0.82, ink)
    return img


# --------------------------------------------------------------------------
# perspective + photo simulation
# --------------------------------------------------------------------------
def homography(src, dst):
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    h = np.linalg.solve(np.array(A, float), np.array(b, float))
    return np.append(h, 1.0).reshape(3, 3)


def warp_photo(sheet, dest_quad, out_w, out_h, seed=0, blur=0.6, noise=6.0):
    """Place `sheet` into an out_w x out_h canvas at dest_quad, like a phone photo."""
    src = np.array(sheet, dtype=np.float32)
    hs, ws = src.shape[:2]
    M = homography([[0, 0], [ws, 0], [ws, hs], [0, hs]], dest_quad)
    Minv = np.linalg.inv(M)

    ys, xs = np.mgrid[0:out_h, 0:out_w]
    ones = np.ones_like(xs)
    pts = np.stack([xs, ys, ones], axis=-1).reshape(-1, 3).T
    sp = Minv @ pts
    sx = (sp[0] / sp[2]).reshape(out_h, out_w)
    sy = (sp[1] / sp[2]).reshape(out_h, out_w)

    inside = (sx >= 0) & (sx < ws - 1) & (sy >= 0) & (sy < hs - 1)
    sx = np.clip(sx, 0, ws - 1.001)
    sy = np.clip(sy, 0, hs - 1.001)
    x0 = sx.astype(np.int32); y0 = sy.astype(np.int32)
    fx = sx - x0; fy = sy - y0

    g = src.mean(axis=2)
    a = g[y0, x0]; b = g[y0, x0 + 1]; c = g[y0 + 1, x0]; e = g[y0 + 1, x0 + 1]
    out = (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + e * fx * fy)

    # paper outside the quad = dark desk
    out = np.where(inside, out, 95.0)

    # uneven lighting across the sheet
    yy, xx = np.mgrid[0:out_h, 0:out_w]
    shade = 1.0 - 0.22 * (xx / out_w) - 0.10 * (yy / out_h)
    out = out * shade

    rng = np.random.default_rng(seed)
    out = out + rng.normal(0, noise, out.shape)
    out = np.clip(out, 0, 255).astype(np.uint8)

    im = Image.fromarray(out, mode="L")
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    return im


# --------------------------------------------------------------------------
def main():
    dpi = 300
    os.makedirs(os.path.join(ROOT, "samples"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "templates"), exist_ok=True)

    tpl_path = os.path.join(ROOT, "templates", "default-a4-90q.json")
    with open(tpl_path, "w") as f:
        json.dump(DEFAULT_TEMPLATE, f, indent=2)

    blank = render_sheet(DEFAULT_TEMPLATE, dpi)
    blank.save(os.path.join(ROOT, "samples", "omr-sheet-blank.png"))
    blank.save(os.path.join(ROOT, "samples", "omr-sheet-blank.pdf"), resolution=dpi)

    rng = np.random.default_rng(7)

    demos = [
        # name, roll, quad, multi-marks, blanks
        ("demo-1", "12345", "08", "A",
         [[120, 90], [1520, 150], [1470, 2140], [90, 2080]], {}, []),
        ("demo-2", "20267", "08", "A",
         [[60, 40], [1560, 210], [1500, 2120], [130, 2030]], {12: [0, 2], 47: [1, 2, 3]}, [5, 60]),
        ("demo-3", "98765", "09", "B",
         [[180, 160], [1490, 60], [1560, 2060], [70, 2150]], {33: [2, 3]}, [88]),
        # harsh: strong rotation, small frame, heavy noise
        ("demo-4", "45678", "10", "C",
         [[250, 30], [1215, 300], [985, 1725], [25, 1450]], {7: [1, 2], 71: [0, 3]}, [20, 55]),
        # harsh: light pencil marks, washed out, low contrast
        ("demo-5", "31415", "07", "D",
         [[150, 120], [1450, 180], [1520, 2080], [90, 2020]], {50: [0, 1]}, [11]),
    ]

    answer_key = []
    for qi in range(DEFAULT_TEMPLATE["questions"]["count"]):
        answer_key.append(qi % 4)  # key = A,B,C,D,A,B,C,D ...

    inks = {"demo-5": 135}
    for name, roll, klass, section, quad, multi, blanks in demos:
        answers = {}
        for qi in range(DEFAULT_TEMPLATE["questions"]["count"]):
            if qi in blanks:
                continue
            if qi in multi:
                answers[qi] = multi[qi]
            else:
                answers[qi] = [answer_key[qi]]
        sheet = render_sheet(DEFAULT_TEMPLATE, dpi,
                             {"fields": {"roll": roll, "class": klass, "section": section},
                              "answers": answers, "ink": inks.get(name, 55)})
        ow, oh = (1250, 1750) if name == "demo-4" else (1600, 2200)
        photo = warp_photo(sheet, quad, ow, oh, seed=abs(hash(name)) % 1000,
                           noise=11.0 if name == "demo-5" else 6.0)
        jpg = os.path.join(ROOT, "samples", f"{name}.jpg")
        photo.save(jpg, quality=80, optimize=True)
        raw = os.path.join(ROOT, "samples", f"{name}.raw")
        with open(raw, "wb") as f:
            f.write(np.array(photo, dtype=np.uint8).tobytes())
        # ground truth for the automated test
        gt = {
            "roll": roll, "class": klass, "section": section,
            "answers": {str(k): v for k, v in answers.items()},
            "multi": {str(k): v for k, v in multi.items()},
            "blank": blanks,
            "size": [photo.width, photo.height],
        }
        with open(os.path.join(ROOT, "samples", f"{name}.truth.json"), "w") as f:
            json.dump(gt, f, indent=2)

    # answer key file the app can load
    with open(os.path.join(ROOT, "samples", "answer-key.json"), "w") as f:
        json.dump({"name": "Demo Key", "answers": answer_key}, f, indent=2)

    # roster csv
    with open(os.path.join(ROOT, "samples", "roster.csv"), "w") as f:
        f.write("roll,name,class,section\n")
        for roll, nm, cl, sec in [("12345", "Aarav Sharma", "8", "A"),
                                  ("20267", "Diya Patel", "8", "A"),
                                  ("98765", "Kabir Singh", "9", "B"),
                                  ("45678", "Meera Nair", "10", "C"),
                                  ("31415", "Rohan Verma", "7", "D")]:
            f.write(f"{roll},{nm},{cl},{sec}\n")

    print("generated:", sorted(os.listdir(os.path.join(ROOT, "samples"))))


if __name__ == "__main__":
    main()

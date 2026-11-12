"""Dev-only independent encoder for the CC0 triangle fixtures; prints JSON, writes no files.

Requires FontTools 4.67.0. Normal tests consume the frozen bytes in font-reference.js;
Python/FontTools are not product or test-run dependencies. No third-party font input.
"""
import base64
import hashlib
import io
import json
import platform
import zlib

import fontTools
from fontTools.cffLib.CFFToCFF2 import convertCFFToCFF2
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont

assert fontTools.__version__ == "4.67.0", "Use the pinned reference encoder"


def build(advance, weight, style):
    builder = FontBuilder(1000, isTTF=False)
    builder.font.recalcTimestamp = False
    builder.font["head"].created = builder.font["head"].modified = 3406620158
    builder.font["head"].macStyle = 1 if weight == 700 else 0
    builder.setupGlyphOrder([".notdef", "A"])
    builder.setupCharacterMap({65: "A"})
    missing = T2CharStringPen(advance, None)
    triangle = T2CharStringPen(advance, None)
    triangle.moveTo((0, 0))
    triangle.lineTo((600, 0))
    triangle.lineTo((300, 700))
    triangle.closePath()
    name = "ReferenceFamily-" + style
    builder.setupCFF(name, {"FullName": name, "FamilyName": "Reference Family", "Weight": style}, {".notdef": missing.getCharString(), "A": triangle.getCharString()}, {})
    builder.setupHorizontalMetrics({".notdef": (advance, 0), "A": (advance, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Reference Family", "styleName": style, "uniqueFontIdentifier": name + "-1", "fullName": name, "psName": name, "version": "Version 1.0", "copyright": "Own synthetic triangle font. CC0."})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, usWeightClass=weight, fsSelection=32 if weight == 700 else 64)
    builder.setupPost()
    return builder.font


regular = build(600, 400, "Regular")
regular.flavor = "woff"
bold = build(900, 700, "Bold")
convertCFFToCFF2(bold)
result = {"encoder": "fonttools@" + fontTools.__version__, "python": platform.python_version(), "zlib": zlib.ZLIB_RUNTIME_VERSION}
for key, font, outline in [("cff1Woff", regular, "CFF "), ("cff2Otf", bold, "CFF2")]:
    output = io.BytesIO()
    font.save(output)
    data = output.getvalue()
    decoded = TTFont(io.BytesIO(data))
    assert outline in decoded and ("CFF2" if outline == "CFF " else "CFF ") not in decoded
    assert decoded["hmtx"].metrics["A"][0] == (600 if key == "cff1Woff" else 900)
    result[key] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode("ascii")}
print(json.dumps(result, sort_keys=True))

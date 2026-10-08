#!/usr/bin/env python3
"""One-off generator for data/boundaries.json (not needed to build the app).

Source: Natural Earth 1:10m admin-1 (public domain), downloaded from
https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
Usage: python3 make_boundaries.py ne_10m_admin_1_states_provinces.geojson > boundaries.json
Needs: pip install shapely
"""
import json, sys
from shapely.geometry import shape, box, mapping
from shapely.ops import unary_union
import shapely

BBOX = box(2.6, 50.7, 7.6, 54.0)     # lon/lat window a little larger than the route map
TOLERANCE = 0.0015                   # degrees, about 150 m: well under 1 px at map scale
DECIMALS = 3
# Province names are placed inside this window, which is roughly what the route map shows
LABEL_BOX = box(3.3, 51.45, 6.5, 53.5)
RENAME = {"Fryslân": "Friesland"}
COUNTRIES = {"NLD": ("NL", "Netherlands"), "BEL": ("BE", "Belgium"), "DEU": ("DE", "Germany")}

features = json.load(open(sys.argv[1]))["features"]
by_country, nl = {}, []
for f in features:
    code = f["properties"].get("adm0_a3")
    if code not in COUNTRIES:
        continue
    geom = shape(f["geometry"]).intersection(BBOX)
    if geom.is_empty:
        continue
    by_country.setdefault(code, []).append(geom)
    if code == "NLD":
        name = f["properties"]["name"]
        nl.append((RENAME.get(name, name), geom))

def rings(geom):
    polys = [geom] if geom.geom_type == "Polygon" else [g for g in geom.geoms if g.geom_type == "Polygon"]
    out = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            pts = [[round(x, DECIMALS), round(y, DECIMALS)] for x, y in ring.coords]
            if len(pts) >= 4:
                out.append(pts)
    return out

# simplify the provinces together so shared borders stay aligned
simple = shapely.coverage_simplify([g for _, g in nl], TOLERANCE)
provinces = []
for (name, _), g in zip(nl, simple):
    visible = g.intersection(LABEL_BOX)
    label = (visible if not visible.is_empty else g).representative_point()
    provinces.append({"name": name, "label": [round(label.x, DECIMALS), round(label.y, DECIMALS)], "rings": rings(g)})
countries = []
for code, geoms in by_country.items():
    union = unary_union(geoms).simplify(TOLERANCE, preserve_topology=True)
    countries.append({"code": COUNTRIES[code][0], "name": COUNTRIES[code][1], "rings": rings(union)})

json.dump({"source": "Natural Earth 1:10m admin-1, public domain", "countries": countries, "provinces": provinces},
          sys.stdout, separators=(",", ":"), ensure_ascii=False)

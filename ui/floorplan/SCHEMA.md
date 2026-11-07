# Floor-plan schema assumptions

This importer was checked against the public NeonPlan 3D import note
(`format: "neonplan-import"`) and against the `building.version` shape
described for the private file. The private file was not available here.
Compare it with the rules below before relying on a drawing.

Units are meters after conversion. The second point component is drawn
downward (NeonPlan `z`, or plan `y`). Use **Flip vertical** if the file
uses mathematical y-up. `cut_height` is kept as metadata and is not used
to re-slice 3D solids. `area_id` is a label only and is not joined to
sensing zones.

## Accepted documents

1. `building` object, the shape requested for the private plan:

```json
{
  "building": {
    "version": 1,
    "floors": [{
      "id": "level-1",
      "name": "Level 1",
      "elevation": 0,
      "height": 2.5,
      "cut_height": 1.2,
      "rooms": [{
        "id": "room-a",
        "name": "Room A",
        "area_id": "area-a",
        "points": [[0, 0], [1, 0], [1, 1]],
        "floor_material": "generic",
        "climate": "unspecified"
      }]
    }]
  }
}
```

2. Public NeonPlan import: `{ "format": "neonplan-import", "units": "m", "floors": [...] }`.
3. A bare `{ "floors": [...] }`, or `levels` / `storeys` in place of `floors`.
4. `rooms` may also be named `spaces` or `areas`.
5. Room outlines may be `points`, `polygon`, `outline`, `corners`, or `vertices`.
   Each corner is `[x, y]`, `[x, z]`, or `{ "x", "y" }` / `{ "x", "z" }`.
   A repeated closing corner is dropped. Fewer than 3 finite corners skips that room.

`units` at the root or on `building` may be `m` (default), `cm`, or `mm`.
The toolbar can override the file unit. A version other than 1 warns and
still parses. Unknown keys are ignored and counted. Values of unknown keys
are not shown.

If `buildings` or `plans` contains more than one building, only the first
is drawn and a warning is shown.

## Openings and furniture

These optional arrays are read on a floor and on a room. Missing arrays
are fine.

| Array | Drawn as |
|---|---|
| `doors` | door |
| `windows`, `glass` | window |
| `openings`, `portals`, `holes` | opening |

An item may use:

- `at` / `position` / `center` as `[x, y]` plus `width` (snapped to the nearest room edge within 0.75 m)
- `from`/`to` or `a`/`b` or a two-point `points` segment
- `edge` or `wall` index plus `pos` or `t` along that room edge
- `type` or `kind` (`door`, `window`, otherwise opening)

`walls[]` with `from`, `to`, and optional `thickness` are extra partitions.
`furniture[]` needs a center (`at`, `position`, `center`, or `x`/`y`) and
optional `width`, `depth` or `size: [w, d, h]`, `rotation` degrees, and
`name` or `type`. Furniture without a center is skipped.

## What this will not do

- It will not turn Wi-Fi estimates into per-room occupancy, a heatmap, or a person marker.
- It will not upload the file. Remembering the plan is off unless the checkbox is used, and then it stays in this browser only.
- A full NeonPlan editor backup that is not JSON, or that uses none of the keys above, is rejected with an error instead of a guessed outline.

The synthetic fixture at `fixtures/synthetic-apartment.json` is the regression sample. It is not a real building.

# Rooms in Stage

Stage can draw a private room model instead of the generic venue. Open Stage's
room controls to import a room JSON file, place fixtures, and edit or remove
bindings. Room data lives in `config/stage-room.json`, served through the same
authenticated API as the lighting controls. It is not part of a packaged build
or a public source checkout.

Use Download room JSON to preserve saved placements before replacement. Replacing
or clearing a room with saved positions asks for confirmation, as does discarding
changed placement fields.

Room geometry changes the preview. It does not move fixtures in the engine's
Rig plot, alter effect targets or arm outputs. Keep those placements consistent
when commissioning the room. Estimated dimensions and bindings remain marked
as estimates; a detailed model does not prove measured optical timing.

An imported room displays explicit fixture bindings. Fixtures without a binding
remain listed for placement instead of being assigned an invented location.
One output unit can have several visual bindings when a shared channel drives
several physical lights. `unit` is the zero-based light/cell within a fixture,
not a DMX channel or an index in the entire rig.

## Room format

Version 1 uses metres and radians. The floor is centred on the origin: `x` is
left/right, `y` is height, and `z` is floor depth. Apply the same transform to
walls, furniture and fixture positions when exporting a floor plan. A source's
revision and measurement confidence can be retained in the model.

```json
{
  "version": 1,
  "name": "Example room",
  "source": { "name": "Room survey", "revision": "1", "confidence": "estimated" },
  "bounds": { "width": 6, "depth": 4, "height": 3 },
  "rooms": [{
    "id": "main", "label": "Main room",
    "polygon": [[-3, -2], [3, -2], [3, 2], [-3, 2]]
  }],
  "objects": [{
    "id": "back-wall", "kind": "box", "role": "wall",
    "position": { "x": 0, "y": 1.5, "z": -2 },
    "size": { "x": 6, "y": 3, "z": 0.1 }
  }],
  "bindings": [{
    "id": "lamp", "fixtureId": 17, "unit": 0,
    "position": { "x": -1, "y": 2.2, "z": 0 },
    "confidence": "estimated"
  }]
}
```

Objects are `box`, `cylinder`, `prism` or `mesh`, with role `wall` or `furniture`.
Position is the object's centre; size is its local width, height and depth.
Optional `rotation` contains `x`, `y`, `z` Euler angles in radians. A cylinder's
local axis is Y; X/Z sizes are diameters. A prism also needs a local X/Z polygon
within its width/depth. Room polygons use world X/Z coordinates. Colours are
optional `#RRGGBB` values. IDs must be unique within each collection.

A `mesh` contains `mesh: { vertices: [[x, y, z], ...], triangles: [[i, j, k], ...] }`.
Vertices are normalized local coordinates in −0.5…0.5, scaled by the object's
`size`, then rotated and placed at `position`. Centre the geometry around its
local origin when exporting. Triangle indices are zero-based and must refer to
three different existing vertices enclosing a nonzero area; winding determines
the outside face. Near-zero triangles (cross-product squared length ≤ 1e-20) are
rejected. Meshes support furniture and walls; screen meshes need texture coordinates
and are not accepted. Meshes accept at most 32,768 vertices and 65,536 triangles each,
and a room at most 65,536 mesh vertices and 131,072 triangles. The 4 MB
request limit also applies, so decimate detailed source models and round exported
coordinates. Stage computes smooth surface normals and uses fixed neutral lighting
to show relief without drawing triangle outlines. Object colours affect the preview
only; they do not change fixture output colours. Mesh data is inline and private,
with no external model URL or source asset needed by the public application.

A physical light driven by several output units can use `aggregation: "weightedMean"`
and `sources: [{ "fixtureId": 17, "unit": 0, "weight": 1 }, ...]` instead of
`fixtureId`/`unit`. It draws one marker whose linear RGB is the weighted mean of
the sources. Weights must be positive and their sum finite; a binding accepts up
to 64 unique source units. Missing sources count as black and appear as incomplete
coverage. This estimates the whole lamp's colour, without inventing segment
positions. The placement editor can add, change or remove source units and weights.
Shared source units are listed explicitly: changing one output can affect several
physical lights, regardless of their separate preview markers.

A room binding may include a surveyed `path` of 2–128 points in room metres. Stage draws
its corners as a continuous strip using that binding's source colour, including weighted
sources. Moving its position translates the whole path. Point-only imports remain markers;
re-export known strip geometry to give them their physical shape. Room imports accept at most
8192 strip edges and reject zero-length edges and paths outside the room bounds.

Models accept up to 128 room polygons, 1,500 objects and 4,096 bindings, with up
to 128 vertices per polygon, 8,192 total source references and a 1 MB JSON
request limit. External asset URLs, scripts and unrecognised fields are rejected. Keep the original floor-plan
source and measurements separately; this is a rendering format, not an archive
of the floor-plan source.

## API and concurrent changes

`GET /api/stage/room` returns `{ ok, room, revision }`. With no imported model,
`room` is `null` and `revision` is `empty`. GET supports `If-None-Match` and 304
responses, so clients can check for updates without downloading unchanged
geometry.

`PUT /api/stage/room` accepts the room object above. `DELETE /api/stage/room`
returns to the generic venue. Both require `If-Match` with the revision from
GET: missing revisions return 428; an intervening edit returns 412. Reload and
review that edit before replacing it. Failed validation or disk writes preserve
the previously loaded model.

A furniture object may set `lightBindingId` to an existing binding ID. Its surface
retains its base colour while off and emits that binding's current Stage RGB, including weighted
source mixtures and missing-source black contributions. The binding's separate
marker is replaced by the object; its coverage and source data are retained. This
uses the same live/rehearsal frame and power-state semantics as other Stage lights.
Lit surfaces blend their neutral diffuse colour toward 0.35 × the current linear RGB and
add restrained emission (intensity 0.25), preserving hue and directional relief.
An off frame removes emission while leaving the physical shell visible. Multiple
object parts may share one binding; unbound parts remain ordinary scenery. This is
preview rendering only and never moves or changes an output fixture.

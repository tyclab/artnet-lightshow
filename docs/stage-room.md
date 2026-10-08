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

Objects are `box`, `cylinder` or `prism`, with role `wall` or `furniture`.
Position is the object's centre; size is its local width, height and depth.
Optional `rotation` contains `x`, `y`, `z` Euler angles in radians. A cylinder's
local axis is Y; X/Z sizes are diameters. A prism also needs a local X/Z polygon
within its width/depth. Room polygons use world X/Z coordinates. Colours are
optional `#RRGGBB` values. IDs must be unique within each collection.

Models accept up to 128 room polygons, 1,500 objects and 4,096 bindings, with up
to 128 vertices per polygon and a 1 MB JSON request limit. External asset URLs,
scripts and unrecognised fields are rejected. Keep the original floor-plan
source and measurements separately; this is a rendering format, not an archive
of the source application.

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

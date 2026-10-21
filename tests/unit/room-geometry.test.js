import test from 'node:test';
import assert from 'node:assert/strict';
import { roomObjectGeometry } from '../../public-src/stage3d/room-geometry.js';

test('a mesh preserves indexed topology, scales local coordinates and computes surface normals', () => {
  const geometry = roomObjectGeometry({ kind: 'mesh', size: { x: 2, y: 4, z: 6 }, mesh: {
    vertices: [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0, 0.5, 0.5]], triangles: [[0, 1, 2]],
  } });
  assert.deepEqual(Array.from(geometry.attributes.position.array), [-1, -2, 0, 1, -2, 0, 0, 2, 3]);
  assert.deepEqual(Array.from(geometry.index.array), [0, 1, 2]);
  const normals = Array.from(geometry.attributes.normal.array);
  for (let i = 0; i < normals.length; i += 3) {
    assert.ok(Math.abs(normals[i]) < 1e-6);
    assert.ok(Math.abs(normals[i + 1] + 0.6) < 1e-6);
    assert.ok(Math.abs(normals[i + 2] - 0.8) < 1e-6);
  }
  geometry.dispose();
});

test('existing box, cylinder and prism geometry keeps its local extents', () => {
  for (const kind of ['box', 'cylinder', 'prism']) {
    const geometry = roomObjectGeometry({ kind, size: { x: 2, y: 4, z: 6 }, polygon: [[-1, -3], [1, -3], [1, 3], [-1, 3]] });
    geometry.computeBoundingBox();
    assert.deepEqual(geometry.boundingBox.min.toArray(), [-1, -2, -3]);
    assert.deepEqual(geometry.boundingBox.max.toArray(), [1, 2, 3]);
    geometry.dispose();
  }
});

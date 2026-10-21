import * as THREE from 'three';

export function roomObjectGeometry(object) {
  if (object.kind === 'mesh') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(object.mesh.vertices.flat(), 3));
    geometry.setIndex(object.mesh.triangles.flat());
    geometry.scale(object.size.x, object.size.y, object.size.z);
    geometry.computeVertexNormals();
    return geometry;
  }
  if (object.kind === 'prism') {
    const shape = new THREE.Shape(object.polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
    return new THREE.ExtrudeGeometry(shape, { depth: object.size.y, bevelEnabled: false })
      .rotateX(-Math.PI / 2).translate(0, -object.size.y / 2, 0);
  }
  if (object.kind === 'cylinder') return new THREE.CylinderGeometry(0.5, 0.5, 1, 16).scale(object.size.x, object.size.y, object.size.z);
  return new THREE.BoxGeometry(object.size.x, object.size.y, object.size.z);
}

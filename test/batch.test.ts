import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  type InterleavedBuffer,
  type InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
  RawShaderMaterial,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector3,
} from "three";
import { Batch, type BatchOptions } from "../src/batch.ts";
import { Owner } from "../src/index.ts";

/** A batch's mesh, whatever its values and its material. */
type Drawn = Pick<Batch, "mesh">;

function batchOf(owner: Owner, shared?: Readonly<Record<string, number>>) {
  return new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, ...(shared === undefined ? {} : { shared }) });
}

/** The attributes that hold a batch's values, in the order they lie in each instance. */
function valueAttributes(batch: Drawn): InterleavedBufferAttribute[] {
  return Object.values(batch.mesh.geometry.attributes)
    .filter((attribute): attribute is InterleavedBufferAttribute => "isInterleavedBufferAttribute" in attribute)
    .toSorted((one, other) => one.offset - other.offset);
}

/**
 * What a shader reads for the instances drawn, one after another: each value's numbers through its own attribute, as
 * Three.js hands them to the GPU, in the order the values lie in an instance.
 */
function written(batch: Drawn): number[] {
  const attributes = valueAttributes(batch);
  const numbers: number[] = [];
  for (let instance = 0; instance < batch.mesh.geometry.instanceCount; instance++) {
    for (const attribute of attributes) {
      for (let part = 0; part < attribute.itemSize; part++) numbers.push(attribute.getComponent(instance, part));
    }
  }
  return numbers;
}

/** What a shader reads as the value `name` of one instance. */
function read(batch: Drawn, name: string, instance: number): number[] {
  const attribute = batch.mesh.geometry.getAttribute(name);
  return Array.from({ length: attribute.itemSize }, (_, part) => attribute.getComponent(instance, part));
}

/** The buffer a batch's values go to the GPU in. */
function buffer(batch: Drawn): InterleavedBuffer {
  const [first] = valueAttributes(batch);
  assert.ok(first);
  return first.data;
}

function fill(values: Float32Array, ...numbers: number[]): void {
  values.set(numbers);
}

/** `count` values of 4 numbers each. */
function manyValues(count: number): Readonly<Record<string, number>> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`value${index}`, 4]));
}

test("flush writes runs in the order they were added, each over the one before", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const first = batch.add(owner, 1);
  const second = batch.add(owner, 2);
  fill(first.values, 1, 2);
  fill(second.values, 3, 4, 5, 6);
  batch.flush();
  assert.deepEqual(written(batch), [1, 2, 3, 4, 5, 6]);
  assert.equal(batch.mesh.geometry.instanceCount, 3);
  // Each run knows which it was to be added, counting from 0.
  assert.deepEqual([first.added, second.added], [0, 1]);
});

test("the mesh draws its shape once for each instance, and is never left out as off screen", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  batch.add(owner, 3);
  batch.flush();
  assert.equal(batch.mesh.geometry.isInstancedBufferGeometry, true);
  // The values step once for each instance, where a plain buffer would step once for each corner of the shape.
  const values = buffer(batch);
  assert.equal("isInstancedInterleavedBuffer" in values && "meshPerAttribute" in values && values.meshPerAttribute, 1);
  // They change from frame to frame, and the GPU is told so.
  assert.equal(buffer(batch).usage, DynamicDrawUsage);
  assert.equal(batch.mesh.frustumCulled, false);
});

test("flush sends the GPU just the part of the buffer in use, and nothing when nothing changed", () => {
  const owner = new Owner();
  const batch = batchOf(owner, { anchor: 1 });
  batch.add(owner, 3);
  batch.flush();
  // Three instances of three numbers each: the anchor, then the place.
  assert.deepEqual(buffer(batch).updateRanges, [{ start: 0, count: 9 }]);
  const version = buffer(batch).version;
  batch.flush();
  assert.equal(buffer(batch).version, version);
  // A later flush sends the part in use by then.
  batch.add(owner, 1);
  batch.flush();
  assert.deepEqual(buffer(batch).updateRanges, [{ start: 0, count: 12 }]);
});

test("with nothing shown, flush sends the GPU nothing", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 1);
  batch.flush();
  const version = buffer(batch).version;
  run.visible = false;
  batch.flush();
  assert.equal(batch.mesh.geometry.instanceCount, 0);
  // A range of nothing would have WebGL copy the whole buffer.
  assert.equal(buffer(batch).version, version);
});

test("a run's order decides what paints over what, and changing it repaints", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const first = batch.add(owner, 1);
  const second = batch.add(owner, 1);
  fill(first.values, 1, 1);
  fill(second.values, 2, 2);
  first.order = 5;
  batch.flush();
  assert.deepEqual(written(batch), [2, 2, 1, 1]);
  first.order = -5;
  batch.flush();
  assert.deepEqual(written(batch), [1, 1, 2, 2]);
});

test("runs of the same order paint in the order they were added, whatever came between", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const first = batch.add(owner, 1);
  const second = batch.add(owner, 1);
  fill(first.values, 1, 1);
  fill(second.values, 2, 2);
  second.order = -1;
  batch.flush();
  assert.deepEqual(written(batch), [2, 2, 1, 1]);
  second.order = 0;
  batch.flush();
  assert.deepEqual(written(batch), [1, 1, 2, 2]);
});

test("a run added later is sorted into its place", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const over = batch.add(owner, 1);
  fill(over.values, 5, 5);
  over.order = 5;
  batch.flush();
  // A new run's order is 0, so it paints under the one of order 5, though it was added after.
  const under = batch.add(owner, 1);
  fill(under.values, 1, 1);
  batch.flush();
  assert.deepEqual(written(batch), [1, 1, 5, 5]);
});

test("a run reordered while hidden comes back where its new order puts it", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const first = batch.add(owner, 1);
  const second = batch.add(owner, 1);
  fill(first.values, 1, 1);
  fill(second.values, 2, 2);
  first.visible = false;
  batch.flush();
  first.order = 5;
  batch.flush();
  first.visible = true;
  batch.flush();
  assert.deepEqual(written(batch), [2, 2, 1, 1]);
});

test("shared values reach every instance of a run, before its own", () => {
  const owner = new Owner();
  const batch = batchOf(owner, { anchor: 1 });
  const run = batch.add(owner, 2);
  run.shared[0] = 9;
  fill(run.values, 1, 2, 3, 4);
  batch.flush();
  assert.deepEqual(written(batch), [9, 1, 2, 9, 3, 4]);
});

test("a run's values can be set by name", () => {
  const owner = new Owner();
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2, tint: 1 }, shared: { lift: 1 } });
  const hand = batch.add(owner, 2);
  const { place, tint, lift } = hand.fields;
  place.set(10, 20);
  place.setAt(1, 30, 40);
  tint.setAt(1, 0.5);
  // A shared value has one place, whichever instance it's set for.
  lift.setAt(1, 7);
  batch.flush();
  assert.deepEqual(written(batch), [7, 10, 20, 0, 7, 30, 40, 0.5]);
  // Each name reads its own numbers, as many as it has.
  assert.deepEqual([read(batch, "lift", 1), read(batch, "place", 1), read(batch, "tint", 1)], [[7], [30, 40], [0.5]]);
  assert.equal(hand.fields.place, place);
});

test("a value set by name writes its own numbers and no others", () => {
  const owner = new Owner();
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { spot: 3, tint: 4, lift: 1, edge: 2 } });
  const run = batch.add(owner, 1);
  const { spot, tint, lift, edge } = run.fields;
  spot.set(1, 2, 3);
  tint.set(4, 5, 6, 7);
  edge.set(9, 10);
  // Set last, and it leaves the numbers on either side of it as they were.
  lift.set(8);
  batch.flush();
  assert.deepEqual(
    [read(batch, "spot", 0), read(batch, "tint", 0), read(batch, "lift", 0), read(batch, "edge", 0)],
    [[1, 2, 3], [4, 5, 6, 7], [8], [9, 10]],
  );
});

test("a value can't take a name its shape's own attributes have", () => {
  const owner = new Owner();
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { position: 2 } }), /position/);
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, shared: { position: 2 } }), /position/);
  // Only the shape's own attributes are taken, not every name an object has.
  assert.doesNotThrow(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { toString: 2 } }));
});

test("a shape and its values take at most 16 attributes, as many as WebGL 2 promises", () => {
  const owner = new Owner();
  // A raw material's shader declares only what's written in it, so the square's corners take one and the values the rest.
  assert.doesNotThrow(() => new Batch(owner, { material: new RawShaderMaterial(), fields: manyValues(15) }));
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: manyValues(16) }), /17 attributes/);
});

test("the position, normal and uv Three.js declares for any other material count toward the 16", () => {
  const owner = new Owner();
  // Chrome draws the square with 13 values on a ShaderMaterial and refuses the shader with 14.
  assert.doesNotThrow(() => new Batch(owner, { material: new ShaderMaterial(), fields: manyValues(13) }));
  assert.throws(() => new Batch(owner, { material: new ShaderMaterial(), fields: manyValues(14) }), /17 attributes/);
  // A shape that has a normal and a uv of its own takes the same three, not five.
  assert.doesNotThrow(() => new Batch(owner, { material: new ShaderMaterial(), fields: manyValues(13), shape: new BoxGeometry() }));
  assert.throws(() => new Batch(owner, { material: new ShaderMaterial(), fields: manyValues(14), shape: new BoxGeometry() }), /17 attributes/);
});

test("so does the color Three.js declares for a material with vertexColors", () => {
  const owner = new Owner();
  const material = new ShaderMaterial({ vertexColors: true });
  // Chrome draws the square with 12 values on such a material and refuses the shader with 13.
  assert.doesNotThrow(() => new Batch(owner, { material, fields: manyValues(12) }));
  assert.throws(() => new Batch(owner, { material, fields: manyValues(13) }), /17 attributes/);
  // A value named color is that same attribute, so it's counted once.
  assert.doesNotThrow(() => new Batch(owner, { material, fields: { ...manyValues(12), color: 3 } }));
  // A raw material's shader has no color unless it's written in it.
  assert.doesNotThrow(() => new Batch(owner, { material: new RawShaderMaterial({ vertexColors: true }), fields: manyValues(15) }));
});

test("the mesh keeps the type of the material the batch was given", () => {
  const owner = new Owner();
  const material = new ShaderMaterial({ uniforms: { fade: { value: 1 } } });
  const batch = new Batch(owner, { material, fields: { place: 2 } });
  // Reading `uniforms` type-checks only while the mesh's material is still a ShaderMaterial.
  assert.equal(batch.mesh.material.uniforms, material.uniforms);
  // A batch's options can be named by their values alone, as a batch can.
  const options: BatchOptions<{ readonly place: 2 }> = { material, fields: { place: 2 } };
  assert.equal(new Batch(owner, options).mesh.material, material);
});

test("a raycast never hits a batch's mesh, since only its shader knows where the instances are", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  batch.add(owner, 1);
  batch.flush();
  // Off the square's diagonal, so the ray crosses one of its two triangles.
  const ray = new Raycaster(new Vector3(0.2, 0.1, 5), new Vector3(0, 0, -1));
  assert.deepEqual(ray.intersectObject(batch.mesh), []);
  // Nor once something has worked the square's own bounds out, which a ray is tested against first.
  batch.mesh.geometry.computeBoundingSphere();
  batch.mesh.geometry.computeBoundingBox();
  assert.deepEqual(ray.intersectObject(batch.mesh), []);
  // The same ray hits the square when a plain mesh draws it, so it's the batch that turns the ray away.
  const square = new BufferGeometry();
  square.setAttribute("position", batch.mesh.geometry.getAttribute("position"));
  square.setIndex(batch.mesh.geometry.getIndex());
  assert.equal(ray.intersectObject(new Mesh(square, batch.mesh.material)).length, 1);
  // And it still reaches what hangs under the batch's mesh.
  const child = new Mesh(new PlaneGeometry(), batch.mesh.material);
  batch.mesh.add(child);
  batch.mesh.updateMatrixWorld();
  assert.deepEqual(
    ray.intersectObject(batch.mesh).map((hit) => hit.object),
    [child],
  );
});

test("a batch's bounds come from where its mesh stands, never from its shape", () => {
  const owner = new Owner();
  const scene = new Scene();
  const shape = new BoxGeometry().translate(5, 0, 0);
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, shape });
  scene.add(batch.mesh);
  // The geometry a batch grows into is set up as its first is.
  for (const grown of [false, true]) {
    if (grown) {
      batch.add(owner, 1000);
      batch.flush();
    }
    const { boundingSphere } = batch.mesh.geometry;
    // See-through objects sort by the sphere's middle, and what culls by the sphere never drops the batch.
    assert.deepEqual(boundingSphere?.center.toArray(), [0, 0, 0]);
    assert.equal(boundingSphere?.radius, Infinity);
    // A scene's bounds leave the batch out: its instances are wherever its shader puts them.
    assert.equal(new Box3().setFromObject(scene).isEmpty(), true);
  }
});

test("the module exports the batch alone: runs and fields leave it as types, since only a batch makes them", async () => {
  assert.deepEqual(Object.keys(await import("../src/batch.ts")), ["Batch"]);
});

test("a see-through material drawn on both sides has to draw in one pass, or runs would paint out of order", () => {
  const owner = new Owner();
  const material = new RawShaderMaterial({ transparent: true, side: DoubleSide });
  material.forceSinglePass = false;
  assert.throws(() => new Batch(owner, { material, fields: { place: 2 } }), /forceSinglePass/);
  material.forceSinglePass = true;
  assert.doesNotThrow(() => new Batch(owner, { material, fields: { place: 2 } }));
});

test("a run has a whole number of instances, 0 or more", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  for (const count of [-1, 1.5, Number.NaN]) assert.throws(() => batch.add(owner, count), /instances/);
  const run = batch.add(owner, 1);
  // A run that was refused isn't counted among those added.
  assert.equal(run.added, 0);
  fill(run.values, 1, 2);
  assert.throws(() => run.resize(-1), /instances/);
  batch.flush();
  assert.deepEqual(written(batch), [1, 2]);
});

test("two values can't share a name", () => {
  const owner = new Owner();
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, shared: { place: 1 } }), /place/);
});

test("a value has 1 to 4 numbers, and a whole number of them", () => {
  const owner = new Owner();
  for (const size of [0, 5, 1.5]) {
    assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { place: size } }), /place/);
  }
});

test("setting a value by name is noticed, and survives a resize", () => {
  const owner = new Owner();
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 } });
  const run = batch.add(owner, 1);
  const { place } = run.fields;
  place.set(1, 2);
  batch.flush();
  const version = buffer(batch).version;
  place.set(3, 4);
  batch.flush();
  assert.equal(buffer(batch).version, version + 1);
  run.resize(200);
  place.setAt(199, 5, 6);
  batch.flush();
  assert.deepEqual(written(batch).slice(-2), [5, 6]);
});

test("a hidden run isn't drawn, and comes back in its place", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const first = batch.add(owner, 1);
  const second = batch.add(owner, 1);
  fill(first.values, 1, 1);
  fill(second.values, 2, 2);
  first.visible = false;
  batch.flush();
  assert.deepEqual(written(batch), [2, 2]);
  first.visible = true;
  batch.flush();
  assert.deepEqual(written(batch), [1, 1, 2, 2]);
});

test("flush copies nothing when nothing changed", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 1);
  fill(run.values, 1, 2);
  batch.flush();
  const version = buffer(batch).version;
  batch.flush();
  assert.equal(buffer(batch).version, version);
  run.values[0] = 3;
  run.changed();
  batch.flush();
  assert.equal(buffer(batch).version, version + 1);
});

test("setting what a run already has copies nothing", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 2);
  batch.flush();
  const version = buffer(batch).version;
  run.order = 0;
  run.visible = true;
  run.resize(2);
  batch.flush();
  assert.equal(buffer(batch).version, version);
});

test("a batch grows past its first room, and keeps every instance", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 1000);
  run.values.fill(7);
  batch.flush();
  assert.equal(batch.mesh.geometry.instanceCount, 1000);
  assert.equal(written(batch).length, 2000);
  assert.equal(written(batch).every((value) => value === 7), true);
});

test("a batch that gains one instance at a time makes room for many at once, not a new geometry each time", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const geometries = new Set([batch.mesh.geometry]);
  for (let count = 0; count < 200; count++) {
    batch.add(owner, 1);
    batch.flush();
    geometries.add(batch.mesh.geometry);
  }
  // Doubling from room for 64 takes two more geometries to hold 200.
  assert.equal(geometries.size < 6, true);
});

test("growing frees the geometry it outgrew, and never touches the shape it was given", () => {
  const owner = new Owner();
  const log: string[] = [];
  const shape = new BoxGeometry();
  shape.setDrawRange(6, 6);
  shape.addEventListener("dispose", () => log.push("shape"));
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, shape });
  batch.mesh.geometry.addEventListener("dispose", () => log.push("outgrown"));
  batch.add(owner, 1000);
  batch.flush();
  assert.deepEqual(log, ["outgrown"]);
  // The geometry it grew into draws the whole shape still: its attributes, its index and its draw range.
  const grown = batch.mesh.geometry;
  assert.deepEqual(Object.keys(grown.attributes).toSorted(), ["normal", "place", "position", "uv"]);
  assert.deepEqual([...grown.getAttribute("position").array], [...shape.getAttribute("position").array]);
  assert.deepEqual([...(grown.getIndex()?.array ?? [])], [...(shape.getIndex()?.array ?? [])]);
  assert.deepEqual(grown.drawRange, { start: 6, count: 6 });
  // Freeing a geometry frees the GPU's copy of every attribute in it, so the batch draws attributes of its own.
  assert.notEqual(grown.getAttribute("position"), shape.getAttribute("position"));
});

test("a batch that can't get the memory to grow stays as it was, and grows the next time", () => {
  const owner = new Owner();
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: {}, shared: { tint: 4 } });
  const run = batch.add(owner, Number.MAX_SAFE_INTEGER);
  let freed = 0;
  batch.mesh.geometry.addEventListener("dispose", () => freed++);
  // No array is that long, so making room for it fails, and the geometry it still draws with isn't freed.
  assert.throws(() => batch.flush(), RangeError);
  assert.equal(freed, 0);
  run.resize(65);
  batch.flush();
  assert.equal(freed, 1);
  assert.equal(batch.mesh.geometry.instanceCount, 65);
  // The buffer has room for all 65, and the part the GPU is sent lies inside it.
  assert.equal(buffer(batch).array.length >= 65 * 4, true);
  assert.deepEqual(buffer(batch).updateRanges, [{ start: 0, count: 65 * 4 }]);
});

test("resizing keeps what stays and starts what's new at 0", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 2);
  const values = run.values;
  fill(values, 1, 2, 3, 4);
  run.resize(1);
  run.resize(2);
  batch.flush();
  assert.deepEqual(written(batch), [1, 2, 0, 0]);
  // Back inside the room it had, it writes to the same values.
  assert.equal(run.values, values);
});

test("a run that grows past its room keeps what stays, starts the rest at 0, and has new values to write to", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 2);
  const before = run.values;
  fill(before, 1, 2, 3, 4);
  run.resize(1);
  run.resize(100);
  batch.flush();
  // The second instance left when the run shrank, so it comes back empty, not as it was.
  assert.deepEqual(written(batch).slice(0, 6), [1, 2, 0, 0, 0, 0]);
  assert.notEqual(run.values, before);
});

test("freeing a run's owner takes its instances out, and leaves the others", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const leaving = owner.child();
  const first = batch.add(leaving, 1);
  const kept = batch.add(owner, 1);
  fill(first.values, 9, 9);
  fill(kept.values, 1, 2);
  batch.flush();
  assert.deepEqual(written(batch), [9, 9, 1, 2]);
  leaving.dispose();
  batch.flush();
  assert.deepEqual(written(batch), [1, 2]);
});

test("writing to a freed run copies nothing", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  batch.add(owner, 1);
  const leaving = owner.child();
  const freed = batch.add(leaving, 1);
  leaving.dispose();
  batch.flush();
  const version = buffer(batch).version;
  fill(freed.values, 5, 5);
  freed.changed();
  freed.visible = false;
  freed.order = 3;
  freed.resize(4);
  batch.flush();
  assert.equal(buffer(batch).version, version);
  assert.deepEqual(written(batch), [0, 0]);
});

test("an empty batch is still drawn, so its first frame sets it up, and hiding its mesh holds", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  batch.flush();
  assert.equal(batch.mesh.visible, true);
  assert.equal(batch.mesh.geometry.instanceCount, 0);
  batch.mesh.visible = false;
  batch.add(owner, 1);
  batch.flush();
  assert.equal(batch.mesh.visible, false);
});

test("without a shape, a batch draws a flat square with corners from -1 to 1", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  assert.deepEqual([...batch.mesh.geometry.getAttribute("position").array], [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  assert.deepEqual([...(batch.mesh.geometry.getIndex()?.array ?? [])], [0, 1, 2, 0, 2, 3]);
});

test("a batch draws a copy of the shape it's given, and its owner frees only what the batch made", () => {
  const owner = new Owner();
  const log: string[] = [];
  const shape = new BoxGeometry();
  const material = new RawShaderMaterial();
  shape.addEventListener("dispose", () => log.push("shape"));
  material.addEventListener("dispose", () => log.push("material"));
  const batch = new Batch(owner, { material, fields: { place: 2 }, shape });
  batch.mesh.geometry.addEventListener("dispose", () => log.push("geometry"));
  assert.deepEqual([...batch.mesh.geometry.getAttribute("position").array], [...shape.getAttribute("position").array]);
  assert.deepEqual([...(batch.mesh.geometry.getIndex()?.array ?? [])], [...(shape.getIndex()?.array ?? [])]);
  owner.dispose();
  assert.deepEqual(log, ["geometry"]);
});

test("a shape's morph targets aren't drawn", () => {
  const owner = new Owner();
  const shape = new BoxGeometry();
  shape.morphAttributes.position = [shape.getAttribute("position").clone()];
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, shape });
  assert.deepEqual(batch.mesh.geometry.morphAttributes, {});
});

test("freeing the batch's owner frees the geometry it has by then, and takes its mesh out of its scene", () => {
  const owner = new Owner();
  const scene = new Scene();
  const batch = batchOf(owner);
  scene.add(batch.mesh);
  // Outgrowing its first room gives it a second geometry, which is the one left to free.
  batch.add(owner, 1000);
  batch.flush();
  let freed = 0;
  batch.mesh.geometry.addEventListener("dispose", () => freed++);
  owner.dispose();
  assert.equal(freed, 1);
  assert.equal(batch.mesh.parent, null);
});

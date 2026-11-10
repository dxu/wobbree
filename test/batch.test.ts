import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BoxGeometry,
  DoubleSide,
  type InterleavedBuffer,
  type InterleavedBufferAttribute,
  Mesh,
  RawShaderMaterial,
  Raycaster,
  ShaderMaterial,
  Vector3,
} from "three";
import { Batch } from "../src/batch.ts";
import { Owner } from "../src/index.ts";

/** Anything drawn with a `place` of its own. */
type Placed = Pick<Batch, "mesh">;

function batchOf(owner: Owner, shared?: Readonly<Record<string, number>>) {
  return new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, ...(shared === undefined ? {} : { shared }) });
}

/** The values on their way to the GPU, one instance after another. */
function written(batch: Placed): number[] {
  const attribute = batch.mesh.geometry.getAttribute("place") as InterleavedBufferAttribute;
  return [...attribute.data.array].slice(0, batch.mesh.geometry.instanceCount * attribute.data.stride);
}

function buffer(batch: Placed): InterleavedBuffer {
  return (batch.mesh.geometry.getAttribute("place") as InterleavedBufferAttribute).data;
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
  lift.set(7);
  batch.flush();
  assert.deepEqual(written(batch), [7, 10, 20, 0, 7, 30, 40, 0.5]);
  assert.equal(hand.fields.place, place);
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

test("the mesh keeps the type of the material the batch was given", () => {
  const owner = new Owner();
  const material = new ShaderMaterial({ uniforms: { fade: { value: 1 } } });
  const batch = new Batch(owner, { material, fields: { place: 2 } });
  // Reading `uniforms` type-checks only while the mesh's material is still a ShaderMaterial.
  assert.equal(batch.mesh.material.uniforms, material.uniforms);
});

test("a raycast never hits a batch's mesh, since only its shader knows where the instances are", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  batch.add(owner, 1);
  batch.flush();
  const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1));
  assert.deepEqual(ray.intersectObject(batch.mesh), []);
  // The same ray hits the bare shape when a plain mesh draws it, so it's the batch that turns the ray away.
  assert.notEqual(ray.intersectObject(new Mesh(batch.mesh.geometry, batch.mesh.material)).length, 0);
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
  fill(run.values, 1, 2);
  assert.throws(() => run.resize(-1), /instances/);
  batch.flush();
  assert.deepEqual(written(batch), [1, 2]);
});

test("two values can't share a name", () => {
  const owner = new Owner();
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 2 }, shared: { place: 1 } }), /place/);
});

test("a value has 1 to 4 numbers", () => {
  const owner = new Owner();
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 5 } }), /place/);
  assert.throws(() => new Batch(owner, { material: new RawShaderMaterial(), fields: { place: 0 } }), /place/);
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

test("a batch grows past its first room, and keeps every instance", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 1000);
  run.values.fill(7);
  batch.flush();
  assert.equal(batch.mesh.geometry.instanceCount, 1000);
  assert.equal(written(batch).every((value) => value === 7), true);
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
  // Freeing a geometry frees the GPU's copy of every attribute in it, so the batch draws attributes of its own.
  assert.notEqual(batch.mesh.geometry.getAttribute("position"), shape.getAttribute("position"));
  assert.deepEqual(batch.mesh.geometry.drawRange, { start: 6, count: 6 });
});

test("a batch that can't get the memory to grow stays as it was, and grows the next time", () => {
  const owner = new Owner();
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: {}, shared: { tint: 4 } });
  const run = batch.add(owner, Number.MAX_SAFE_INTEGER);
  // No array is that long, so making room for it fails.
  assert.throws(() => batch.flush(), RangeError);
  run.resize(65);
  batch.flush();
  const tint = (batch.mesh.geometry.getAttribute("tint") as InterleavedBufferAttribute).data;
  assert.equal(batch.mesh.geometry.instanceCount, 65);
  // The buffer has room for all 65, and the part the GPU is sent lies inside it.
  assert.equal(tint.array.length >= 65 * 4, true);
  assert.deepEqual(tint.updateRanges, [{ start: 0, count: 65 * 4 }]);
});

test("resizing keeps what stays and starts what's new at 0", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const run = batch.add(owner, 2);
  fill(run.values, 1, 2, 3, 4);
  run.resize(1);
  run.resize(2);
  batch.flush();
  assert.deepEqual(written(batch), [1, 2, 0, 0]);
});

test("freeing a run's owner takes its instances out", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  const kept = batch.add(owner, 1);
  const leaving = owner.child();
  batch.add(leaving, 1);
  fill(kept.values, 1, 2);
  batch.flush();
  assert.equal(batch.mesh.geometry.instanceCount, 2);
  leaving.dispose();
  batch.flush();
  assert.deepEqual(written(batch), [1, 2]);
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

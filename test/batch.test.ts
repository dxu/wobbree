import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, type InterleavedBuffer, type InterleavedBufferAttribute, RawShaderMaterial } from "three";
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
  const batch = new Batch(owner, { material: new RawShaderMaterial(), fields: { position: 2, tint: 1 }, shared: { lift: 1 } });
  const hand = batch.add(owner, 2);
  const { position, tint, lift } = hand.fields;
  position.set(10, 20);
  position.setAt(1, 30, 40);
  tint.setAt(1, 0.5);
  lift.set(7);
  batch.flush();
  const attribute = batch.mesh.geometry.getAttribute("position") as InterleavedBufferAttribute;
  assert.deepEqual([...attribute.data.array].slice(0, 8), [7, 10, 20, 0, 7, 30, 40, 0.5]);
  assert.equal(hand.fields.position, position);
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

test("a batch shows on its first frame to be set up, then hides with nothing in it", () => {
  const owner = new Owner();
  const batch = batchOf(owner);
  batch.flush();
  assert.equal(batch.mesh.visible, true);
  batch.flush();
  assert.equal(batch.mesh.visible, false);
  batch.add(owner, 1);
  batch.flush();
  assert.equal(batch.mesh.visible, true);
});

test("a batch draws the shape it's given, and an owner frees it all", () => {
  const owner = new Owner();
  const log: string[] = [];
  const shape = new BoxGeometry();
  const material = new RawShaderMaterial();
  shape.addEventListener("dispose", () => log.push("shape"));
  material.addEventListener("dispose", () => log.push("material"));
  const batch = new Batch(owner, { material, fields: { place: 2 }, shape });
  assert.equal(batch.mesh.geometry.getAttribute("position"), shape.getAttribute("position"));
  assert.equal(batch.mesh.geometry.getIndex(), shape.getIndex());
  owner.dispose();
  assert.deepEqual(log.toSorted(), ["material", "shape"]);
});

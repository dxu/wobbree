import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial } from "three";
import { Owner } from "../src/index.ts";

test("dispose frees what an owner owns, newest first", () => {
  const log: string[] = [];
  const owner = new Owner();
  const scene = new Group();
  const geometry = owner.own(new BufferGeometry());
  const material = owner.own(new MeshBasicMaterial());
  const mesh = owner.own(new Mesh(geometry, material));
  owner.onDispose(() => log.push("cleanup"));
  scene.add(mesh);
  geometry.addEventListener("dispose", () => log.push("geometry"));
  material.addEventListener("dispose", () => log.push("material"));
  mesh.addEventListener("removed", () => log.push("mesh removed"));

  owner.dispose();

  assert.deepEqual(log, ["cleanup", "mesh removed", "material", "geometry"]);
  assert.deepEqual(scene.children, []);
});

test("an owned object that can be disposed, like InstancedMesh, is removed and then disposed", () => {
  const log: string[] = [];
  const owner = new Owner();
  const scene = new Group();
  const instances = owner.own(new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 4));
  scene.add(instances);
  instances.addEventListener("removed", () => log.push("removed"));
  instances.addEventListener("dispose", () => log.push("disposed"));

  owner.dispose();

  assert.deepEqual(log, ["removed", "disposed"]);
});

test("disposing twice frees things once", () => {
  const owner = new Owner();
  let disposals = 0;
  owner.own(new BufferGeometry()).addEventListener("dispose", () => disposals++);

  owner.dispose();
  owner.dispose();

  assert.equal(disposals, 1);
  assert.equal(owner.disposed, true);
});

test("anything owned after dispose is freed at once", () => {
  const log: string[] = [];
  const owner = new Owner();
  owner.dispose();
  const geometry = new BufferGeometry();
  geometry.addEventListener("dispose", () => log.push("geometry"));

  assert.equal(owner.own(geometry), geometry);
  owner.onDispose(() => log.push("cleanup"));

  assert.deepEqual(log, ["geometry", "cleanup"]);
  assert.equal(owner.child().disposed, true);
});

test("children are freed before their parent's things", () => {
  const log: string[] = [];
  const parent = new Owner();
  parent.own(new MeshBasicMaterial()).addEventListener("dispose", () => log.push("parent material"));
  const child = parent.child();
  child.own(new BufferGeometry()).addEventListener("dispose", () => log.push("child geometry"));

  parent.dispose();

  assert.deepEqual(log, ["child geometry", "parent material"]);
  assert.equal(child.disposed, true);
});

test("a child disposed early is not freed again with its parent", () => {
  const parent = new Owner();
  const child = parent.child();
  let cleanups = 0;
  child.onDispose(() => cleanups++);

  child.dispose();
  parent.dispose();

  assert.equal(cleanups, 1);
});

test("dispose keeps freeing after an error, then rethrows the first error", () => {
  const owner = new Owner();
  let geometryFreed = false;
  owner.own(new BufferGeometry()).addEventListener("dispose", () => {
    geometryFreed = true;
  });
  owner.onDispose(() => {
    throw new Error("older cleanup failed");
  });
  owner.onDispose(() => {
    throw new Error("newer cleanup failed");
  });

  assert.throws(() => owner.dispose(), { message: "newer cleanup failed" });
  assert.equal(geometryFreed, true);
});

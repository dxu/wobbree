import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferGeometry, Group } from "three";
import { Owner } from "../src/index.ts";

interface Item {
  id: string;
  value: number;
}

function setup() {
  const owner = new Owner();
  const parent = new Group();
  const log: string[] = [];
  const list = owner.list(
    parent,
    (item: Item) => item.id,
    (itemOwner, item) => {
      log.push(`build ${item.id}`);
      itemOwner.own(new BufferGeometry()).addEventListener("dispose", () => log.push(`dispose ${item.id}`));
      const root = new Group();
      root.name = item.id;
      return {
        root,
        update(next: Item) {
          root.userData.value = next.value;
        },
      };
    },
  );
  return { owner, parent, list, log };
}

const shown = (parent: Group) => parent.children.map((child) => `${child.name}=${child.userData.value}`);

test("builds one entity per new key, adds its root to the parent and updates it", () => {
  const { parent, list, log } = setup();

  list.update([
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);

  assert.deepEqual(log, ["build a", "build b"]);
  assert.deepEqual(shown(parent), ["a=1", "b=2"]);
});

test("updates existing entities without building them again", () => {
  const { parent, list, log } = setup();

  list.update([{ id: "a", value: 1 }]);
  list.update([{ id: "a", value: 5 }]);

  assert.deepEqual(log, ["build a"]);
  assert.deepEqual(shown(parent), ["a=5"]);
});

test("removes and frees the entities whose keys are gone", () => {
  const { parent, list, log } = setup();

  list.update([
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);
  list.update([{ id: "b", value: 3 }]);

  assert.deepEqual(log, ["build a", "build b", "dispose a"]);
  assert.deepEqual(shown(parent), ["b=3"]);
});

test("items that share a key share one entity, and missing keys are still removed", () => {
  const { parent, list, log } = setup();

  list.update([
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);
  list.update([
    { id: "a", value: 3 },
    { id: "a", value: 4 },
  ]);

  assert.deepEqual(log, ["build a", "build b", "dispose b"]);
  assert.deepEqual(shown(parent), ["a=4"]);
});

test("disposing the owner frees every entity, and later updates do nothing", () => {
  const { owner, parent, list, log } = setup();
  list.update([
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);

  owner.dispose();
  list.update([{ id: "c", value: 3 }]);

  assert.deepEqual(log, ["build a", "build b", "dispose b", "dispose a"]);
  assert.deepEqual(shown(parent), []);
});

test("a build that throws frees what it made, and the key can be built later", () => {
  const owner = new Owner();
  const parent = new Group();
  const log: string[] = [];
  let failing = true;
  const list = owner.list(
    parent,
    (item: Item) => item.id,
    (itemOwner, item) => {
      itemOwner.own(new BufferGeometry()).addEventListener("dispose", () => log.push(`dispose ${item.id}`));
      if (failing) throw new Error("build failed");
      const root = new Group();
      root.name = item.id;
      return { root, update() {} };
    },
  );

  assert.throws(() => list.update([{ id: "a", value: 1 }]), { message: "build failed" });
  assert.deepEqual(log, ["dispose a"]);

  failing = false;
  list.update([{ id: "a", value: 1 }]);
  assert.deepEqual(
    parent.children.map((child) => child.name),
    ["a"],
  );
});

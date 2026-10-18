// Times owner.list() against a hand-written loop doing the same work, and the
// cost of replacing items. Run with `npm run bench`.
import { cpus, loadavg } from "node:os";
import { BufferGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { Owner } from "../src/index.ts";

const ITEMS = 1000;
const REPLACED = 100;
const UPDATES = 500;
const ROUNDS = 7;

const geometry = new BufferGeometry();
const material = new MeshBasicMaterial();

interface Item {
  id: number;
  x: number;
}

let nextId = 0;
const newItem = (): Item => ({ id: nextId++, x: 0 });
const items: Item[] = Array.from({ length: ITEMS }, newItem);

let built = 0;
let freed = 0;
function meshList(parent: Group) {
  const owner = new Owner();
  const list = owner.list(
    parent,
    (item: Item) => item.id,
    (itemOwner) => {
      built++;
      itemOwner.onDispose(() => freed++);
      const mesh = new Mesh(geometry, material);
      return {
        root: mesh,
        update(item: Item) {
          mesh.position.x = item.x;
        },
      };
    },
  );
  return list;
}

// Same items, two ways: through a list, and by hand.
const listed = new Group();
const list = meshList(listed);
list.update(items);
const pairs = items.map((item) => ({ item, mesh: new Mesh(geometry, material) }));

// Replacing items: every update swaps the next REPLACED items for new ones,
// through a list, and by hand with a map from id to mesh.
const churnItems = items.slice();
const churned = new Group();
const churn = meshList(churned);
churn.update(churnItems);
const builtBeforeChurn = built;
const freedBeforeChurn = freed;
let churnWindow = 0;
let churnCalls = 0;

const handItems = items.slice();
const handChurned = new Group();
const handMeshes = new Map<number, Mesh>();
for (const item of handItems) {
  const mesh = new Mesh(geometry, material);
  handMeshes.set(item.id, mesh);
  handChurned.add(mesh);
}
let handWindow = 0;

const sides = {
  "list.update, nothing added or removed": () => list.update(items),
  "the same writes in a hand-written loop": () => {
    for (const { item, mesh } of pairs) mesh.position.x = item.x;
  },
  [`list.update, ${REPLACED} of ${ITEMS} items replaced`]: () => {
    for (let i = 0; i < REPLACED; i++) churnItems[(churnWindow * REPLACED + i) % ITEMS] = newItem();
    churnWindow++;
    churnCalls++;
    churn.update(churnItems);
  },
  "the same replacements by hand": () => {
    for (let i = 0; i < REPLACED; i++) {
      const index = (handWindow * REPLACED + i) % ITEMS;
      const old = handItems[index];
      if (old !== undefined) {
        handMeshes.get(old.id)?.removeFromParent();
        handMeshes.delete(old.id);
      }
      const item = newItem();
      handItems[index] = item;
      const mesh = new Mesh(geometry, material);
      handMeshes.set(item.id, mesh);
      handChurned.add(mesh);
    }
    handWindow++;
    for (const item of handItems) {
      const mesh = handMeshes.get(item.id);
      if (mesh !== undefined) mesh.position.x = item.x;
    }
  },
};

function run(work: () => void): number {
  const started = performance.now();
  for (let n = 0; n < UPDATES; n++) {
    for (const item of items) item.x = n;
    work();
  }
  return ((performance.now() - started) / UPDATES) * 1000;
}

const timings = new Map<string, number[]>();
for (const work of Object.values(sides)) run(work); // warm up
for (let round = 0; round < ROUNDS; round++) {
  for (const [name, work] of Object.entries(sides)) {
    const times = timings.get(name) ?? [];
    times.push(run(work));
    timings.set(name, times);
  }
}

// Did the work happen? The last positions were written, and the churned list
// built and freed one entity per replaced item and still shows ITEMS.
const lastX = UPDATES - 1;
const listWrote = listed.children.every((child) => child.position.x === lastX);
const handWrote = pairs.every(({ mesh }) => mesh.position.x === lastX);
const churnBuilt = built - builtBeforeChurn;
const churnFreed = freed - freedBeforeChurn;

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
const format = (value: number) => value.toFixed(1);
console.log(`${cpus()[0]?.model ?? "unknown CPU"}, Node ${process.version}, load ${loadavg()[0]?.toFixed(1)}`);
console.log(`${UPDATES} updates per round, ${ROUNDS} rounds, sides alternating\n`);
console.log("| Work | Median per update | Range |");
console.log("| --- | --- | --- |");
for (const [name, times] of timings) {
  console.log(`| ${name} | ${format(median(times))} µs | ${format(Math.min(...times))}–${format(Math.max(...times))} µs |`);
}
console.log(
  `\nchecks: list wrote ${listWrote}, by hand wrote ${handWrote}, ` +
    `churn built ${churnBuilt} and freed ${churnFreed} (expected ${churnCalls * REPLACED} each), ` +
    `shown ${churned.children.length} and ${handChurned.children.length} of ${ITEMS}`,
);

# wobbree

A minimal library for managing Three.js objects.

- An **owner** frees everything it owns at once, so nothing is left holding GPU memory.
- A **list** keeps one component per item of your data, so the scene stays in step with your state.

It is one small file with no dependencies besides Three.js.

```sh
npm install wobbree three
```

## Why

Removing an object from a Three.js scene doesn't free its GPU memory. Removal only detaches it; every geometry,
material and texture has to be disposed by hand, and it's easy to miss one. wobbree makes ownership explicit: whatever
an owner owns is freed when the owner is disposed.

## Components

A component is a plain function. It takes an owner, builds its objects, and returns its root object and an `update`
function that applies new state.

```ts
import { BoxGeometry, Mesh, MeshNormalMaterial, Scene } from "three";
import { Owner, type Component } from "wobbree";

function cube(owner: Owner, size: number): Component<{ angle: number }> {
  const geometry = owner.own(new BoxGeometry(size, size, size));
  const material = owner.own(new MeshNormalMaterial());
  const mesh = owner.own(new Mesh(geometry, material));
  return {
    root: mesh,
    update({ angle }) {
      mesh.rotation.y = angle;
    },
  };
}

const scene = new Scene();
const app = new Owner();
const box = cube(app, 1);
scene.add(box.root);
box.update({ angle: 0.5 });

app.dispose(); // removes the mesh from the scene and disposes its geometry and material
```

Owning a mesh removes it from its parent; it doesn't dispose the mesh's geometry or material, because those are often
shared. Own each thing you create, once, in the owner that should free it.

## Lists

`owner.list(parent, key, build)` keeps one component per item, matched by `key`. Each `update(items)` builds components
for new keys and adds their roots to `parent`, calls every component's `update` with its item, and frees the components
whose keys are gone.

```ts
import { Mesh, MeshBasicMaterial, Scene, SphereGeometry } from "three";
import { Owner } from "wobbree";

interface Star {
  id: number;
  x: number;
  y: number;
}

const scene = new Scene();
const app = new Owner();
const starGeometry = app.own(new SphereGeometry(0.1));
const starMaterial = app.own(new MeshBasicMaterial());

const stars = app.list(
  scene,
  (star: Star) => star.id,
  () => {
    const mesh = new Mesh(starGeometry, starMaterial);
    return {
      root: mesh,
      update(star: Star) {
        mesh.position.set(star.x, star.y, 0);
      },
    };
  },
);

stars.update([
  { id: 1, x: 0, y: 0 },
  { id: 2, x: 1, y: 2 },
]);
stars.update([{ id: 2, x: 1, y: 3 }]); // star 1 leaves the scene; star 2 moves
```

The stars share one geometry and one material, so the app owns them, not each star. A list adds each component's root
to `parent` and removes it when the item goes away.

## Lifetimes

`owner.child()` makes an owner that is freed with its parent, or on its own before that:

```ts
const menu = app.child();
// ...build the menu's components with `menu`...
menu.dispose(); // frees only what the menu made
```

Owning something after the owner is disposed frees it at once, so work that finishes late can't leak:

```ts
new TextureLoader().loadAsync(url).then((texture) => {
  material.map = owner.own(texture);
});
```

wobbree has no frame loop. Tie your own to an owner with `onDispose`:

```ts
const spin = (seconds: number) => {
  mesh.rotation.y = seconds;
};
frames.add(spin); // `frames` is your own Set, run by your animation loop
owner.onDispose(() => frames.delete(spin));
```

## API

### `new Owner()`

| Member | What it does |
| --- | --- |
| `own(thing)` | Owns a Three.js object, or anything with a `dispose()` method, and returns it. When the owner is disposed, objects leave their parent (and are disposed too if they can be, like `InstancedMesh`), and everything else is disposed. |
| `onDispose(cleanup)` | Runs `cleanup` when the owner is disposed. |
| `child()` | A new owner, freed with this one unless it is disposed first. |
| `list(parent, key, build)` | A `List`, freed with this owner. `build(owner, item)` returns a `Component` for one item; its owner is freed when the item goes away. |
| `dispose()` | Frees children first, then everything owned, newest first. Running it again does nothing. If freeing something throws, the rest is still freed and the first error is rethrown. |
| `disposed` | Whether `dispose()` has run. Anything owned after that is freed at once. |

### `List`

`update(items)` brings the components in step with `items`, as described under [Lists](#lists). Keys must be unique;
items that share a key share one component.

### `Component<State>`

`{ root: Object3D; update(state: State): void }`: what a list's `build` returns, and a convenient shape for your own
components.

## Performance

Measured with `npm run bench`: 1,000 meshes, 500 updates per round, 7 rounds with the sides taking turns, on an Apple
M1 Max with Node 24 while other work kept the machine busy.

| Work | Median per update | Range |
| --- | --- | --- |
| `list.update`, nothing added or removed | 16 µs | 15–38 µs |
| The same writes in a hand-written loop | 3.8 µs | 3.8–4.0 µs |
| `list.update`, 100 of 1,000 items replaced | 577 µs | 571–587 µs |
| The same replacements by hand | 515 µs | 508–528 µs |

Updating 1,000 items through a list costs about 0.1% of a 60 fps frame. Replacing items costs 12–14% more than doing it
by hand (over two runs); most of both is Three.js itself, creating meshes and removing them from their parent.

What costs more than the library:

- **Creating objects every frame.** Write properties in `update` and in your frame loop; creating objects there makes
  the garbage collector pause, which shows up as stutter.
- **Draw calls.** Each mesh is drawn separately. For many similar objects, one `InstancedMesh` is far cheaper than many
  meshes.

## Design

- One file, [`src/index.ts`](src/index.ts), short enough to read in one sitting.
- Three.js is only a type import: wobbree checks `isObject3D` instead of importing Three.js, so it can never load a
  second copy into your app.
- Freeing is explicit. Nothing is disposed unless an owner owns it.

## Development

Node 24 or later. `npm install`, then `npm run check` runs the type check, the linter (Oxlint), the tests and the build.
`npm run bench` runs the benchmark.

## License

[MIT](LICENSE)

# wobbree

A very light set of ideas for building games with Three.js, so the code stays easy to understand and fast. It gives
every game the few pieces it needs, with light rules for performance and for shaping your own abstractions, and leaves
how your game works to you.

- An **owner** frees everything it owns at once, so nothing is left holding GPU memory.
- An **entity** is a thing in your game: a plain function that builds it and returns its root object and an `update`.
- A **list** keeps one entity per item of your data, so the scene stays in step with your state.
- A **game scene** is one screen or layer of your game: what it shows, the camera it's seen through, and how it lays
  itself out.
- A **stage** draws your scenes on a canvas every frame, in layers, at the canvas's size and the screen's pixel density.

It is one small file with no dependencies besides Three.js, and it imports only Three.js's types.

```sh
npm install wobbree three
```

## Why

Removing an object from a Three.js scene doesn't free its GPU memory. Removal only detaches it; every geometry,
material and texture has to be disposed by hand, and it's easy to miss one. wobbree makes ownership explicit: whatever
an owner owns is freed when the owner is disposed. On top of that, a game needs the same few things every time: pieces
that update from state, scenes, and a loop that draws them at the right size. wobbree gives each one a small, plain
shape, so a game's code reads the same way everywhere.

## Entities

An entity is a plain function. It takes an owner, builds its objects, and returns its root object and an `update`
function that applies new state.

```ts
import { BoxGeometry, Mesh, MeshNormalMaterial, Scene } from "three";
import { Owner, type Entity } from "wobbree";

function Cube(owner: Owner, size: number): Entity<{ angle: number }> {
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
const box = Cube(app, 1);
scene.add(box.root);
box.update({ angle: 0.5 });

app.dispose(); // removes the mesh from the scene and disposes its geometry and material
```

Owning a mesh removes it from its parent; it doesn't dispose the mesh's geometry or material, because those are often
shared. Own each thing you create, once, in the owner that should free it.

## Lists

`owner.list(parent, key, build)` keeps one entity per item, matched by `key`. Each `update(items)` builds entities for
new keys and adds their roots to `parent`, calls every entity's `update` with its item, and frees the entities whose
keys are gone.

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

The stars share one geometry and one material, so the app owns them, not each star. A list adds each entity's root to
`parent` and removes it when the item goes away.

## Lifetimes

`owner.child()` makes an owner that is freed with its parent, or on its own before that:

```ts
const menu = app.child();
// ...build the menu's entities with `menu`...
menu.dispose(); // frees only what the menu made
```

Owning something after the owner is disposed frees it at once, so work that finishes late can't leak:

```ts
new TextureLoader().loadAsync(url).then((texture) => {
  material.map = owner.own(texture);
});
```

Tie anything else to an owner with `onDispose`, such as a listener:

```ts
window.addEventListener("keydown", onKey);
owner.onDispose(() => window.removeEventListener("keydown", onKey));
```

## Scenes and the stage

A game scene runs one screen or layer of your game. It holds what it shows in a Three.js scene, names the camera it's
seen through, and lays itself out when the canvas changes size. A stage draws it.

```ts
import { OrthographicCamera, Scene, WebGLRenderer } from "three";
import { Owner, Stage, type GameScene } from "wobbree";

function TitleScene(owner: Owner): GameScene {
  const root = owner.own(new Scene());
  const camera = new OrthographicCamera(0, 1, 1, 0, -1000, 1000);
  const cube = Cube(owner, 100);
  root.add(cube.root);
  return {
    root,
    camera,
    layOut({ width, height }) {
      camera.right = width; // one unit is one CSS pixel
      camera.top = height;
      camera.updateProjectionMatrix();
      cube.root.position.set(width / 2, height / 2, 0);
    },
  };
}

const app = new Owner();
const renderer = app.own(new WebGLRenderer({ antialias: true }));
document.body.append(renderer.domElement); // size the canvas with CSS, such as width: 100vw and height: 100vh
const stage = app.own(new Stage(renderer));
stage.show(1, TitleScene(app.child()));
```

- **The page sizes the canvas, with CSS.** Each frame the stage checks the canvas's size and the screen's pixel
  density, capped at `maxDensity` (2 by default), and when either changes it resizes the drawing and has every scene
  lay itself out.
- **Layers.** `stage.show(layer, scene)` shows a scene on a layer, in place of what that layer showed, and the stage
  draws the layers from the lowest up. Each layer is drawn through its own scene's camera, over the ones below: a
  background on layer 0 stays put while the screen on layer 1 changes, and a HUD on layer 2 holds still while the
  game's camera moves. `stage.show(layer, undefined)` empties a layer.
- **Cameras.** A camera is an ordinary Three.js object, so a scene can keep several, even inside its scene following a
  character, and switch between them by changing which one its `camera` returns.
- **Switching screens.** The stage only draws; whoever makes a scene frees it. Build each screen with its own owner and
  dispose that owner when you leave it:

  ```ts
  const title = app.child();
  stage.show(1, TitleScene(title));
  // ...when the player starts:
  const lobby = app.child();
  stage.show(1, LobbyScene(lobby));
  title.dispose(); // frees everything the title made
  ```

## Suggested standards

wobbree doesn't enforce these, but they keep a game's code easy to find your way around: every file is laid out the
same way, so you always know where to look.

- **One entity per file, named after it, ending in `.entity.ts`.** `Cube.entity.ts` holds `Cube`. An entity's name is
  capitalized like a class's, so the ending is what tells an entity's file apart from a class's, or from a plain
  module of functions and values.
- **One scene per file, ending in `.scene.ts`, holding the scene's name with "Scene" after it.** `Title.scene.ts` holds
  `TitleScene`.
- **The entity or scene comes first,** right after the imports. Its types and defaults follow, then the file's private
  constants and helpers, in the order it uses them. A function can be called before its declaration, and the
  constants are read only when it runs, so this order works.
- **What it is goes in its arguments; what changes goes through `update`.** Arguments are fixed when an entity is
  built, like a cube's size. `update` carries what changes while it's shown, like its angle, and the entity does
  costly work only when a value that work depends on has changed.
- **Helpers only one file uses stay in that file, unexported,** so nothing else comes to depend on them. A file of its
  own means shared code.
- **Fixed values are named in capitals,** so they read as fixed wherever they're used.

## API

### `new Owner()`

| Member | What it does |
| --- | --- |
| `own(thing)` | Owns a Three.js object, or anything with a `dispose()` method, and returns it. When the owner is disposed, objects leave their parent (and are disposed too if they can be, like `InstancedMesh`), and everything else is disposed. |
| `onDispose(cleanup)` | Runs `cleanup` when the owner is disposed. |
| `child()` | A new owner, freed with this one unless it is disposed first. |
| `list(parent, key, build)` | A `List`, freed with this owner. `build(owner, item)` returns an `Entity` for one item; its owner is freed when the item goes away. |
| `dispose()` | Frees children first, then everything owned, newest first. Running it again does nothing. If freeing something throws, the rest is still freed and the first error is rethrown. |
| `disposed` | Whether `dispose()` has run. Anything owned after that is freed at once. |

### `List`

`update(items)` brings the entities in step with `items`, as described under [Lists](#lists). Keys must be unique;
items that share a key share one entity.

### `Entity<State>`

`{ root: Object3D; update(state: State): void }`: what a list's `build` returns, and the shape of the things in your
game.

### `GameScene`

`{ root: Scene; camera: Camera; layOut(viewport: Viewport): void }`: one screen or layer of your game, as described
under [Scenes and the stage](#scenes-and-the-stage).

### `Viewport`

`{ width: number; height: number; density: number }`: the canvas's size in CSS pixels, and its device pixels per CSS
pixel.

### `new Stage(renderer, options?)`

Starts drawing on `renderer`, a `WebGLRenderer` or anything with what a `StageRenderer` lists, which the stage takes
over: it turns off the renderer's `autoClear` and runs its animation loop. `options.maxDensity` caps the pixel
density, 2 by default.

| Member | What it does |
| --- | --- |
| `show(layer, scene)` | Shows `scene` on `layer`, in place of what that layer showed; `undefined` empties the layer. Once the stage has a viewport, a scene it's given is laid out at once. |
| `viewport` | The viewport the stage last drew at, or `undefined` before its first frame. |
| `dispose()` | Stops drawing. Owning the stage stops it with its owner. |

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

The stage creates nothing per frame. It resizes the drawing only when the canvas's size or the pixel density changes,
and it draws each layer with one render call.

What costs more than the library:

- **Creating objects every frame.** Write properties in `update` and in your per-frame work; creating objects there
  makes the garbage collector pause, which shows up as stutter.
- **Draw calls.** Each mesh is drawn separately. For many similar objects, one `InstancedMesh` is far cheaper than many
  meshes.
- **Pixel density.** Each step up in density is the square in pixels to fill. That's why the stage caps it.

## Design

- One file, [`src/index.ts`](src/index.ts), short enough to read in one sitting.
- Three.js is only a type import: wobbree checks `isObject3D` instead of importing Three.js, and your app makes the
  renderer and hands it to the stage, so wobbree can never load a second copy of Three.js into your app.
- Freeing is explicit. Nothing is disposed unless an owner owns it, and the stage frees nothing it draws.
- Only what every game needs. Your camera, your layout and your look stay in your game.

## Development

Node 24 or later. `npm install`, then `npm run check` runs the type check, the linter (Oxlint), the tests and the build.
`npm run bench` runs the benchmark.

## License

[MIT](LICENSE)

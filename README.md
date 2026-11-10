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
- A **batch** draws many copies of a shape in one draw call, each with values of its own, in the order you paint them.

It has no dependencies besides Three.js. Its core is one small file that imports only Three.js's types, and the batch
is a second, imported on its own from `wobbree/batch`.

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

## Batches

Every mesh is a draw call, and every draw call passes through Three.js, the browser and the graphics driver, so a few
thousand of them fill a frame however simple each one is. A batch draws everything in it in one call: one shape, repeated,
with a list of what's different about each copy.

Name the values each copy has, and read them in your shader as attributes of those names. The shape's own attributes
keep their names, so `position` is taken: it's the corners of the shape, and a batch throws if a value uses it. Then add
copies and set them:

```ts
import { ShaderMaterial } from "three";
import { Batch } from "wobbree/batch";

const material = owner.own(new ShaderMaterial({ vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false }));
const sprites = new Batch(owner, { material, fields: { place: 2, size: 1, tint: 3 } });
scene.add(sprites.mesh);

const coin = sprites.add(owner, 1);
const { place, tint } = coin.fields;
place.set(10, 20);
tint.set(1, 0.8, 0.2);
coin.visible = false;

sprites.flush(); // once a frame, before renderer.render
```

`flush` copies nothing in a frame where nothing changed. When anything did, it copies every shown copy, so one that moves
costs as much as all of them moving.

- **Flush before Three.js walks the scene:** before `renderer.render`, or from the scene's `onBeforeRender`. Three.js
  sends the frame's buffers to the GPU while it walks the scene, so after a flush from a mesh's `onBeforeRender` that
  frame draws the new number of copies from the values the GPU already had.
- **Copies paint in order.** A run paints over the runs before it. Set `order`, such as from how far away each one stands,
  and they sort: drawn things with soft edges have to be painted back to front. Among the scene's other see-through
  objects the whole batch sorts as one, by its mesh's `renderOrder` and where the mesh stands.
- **Runs group copies.** `add(owner, count)` adds a run of `count` copies, and `setAt(index, ...)` sets a copy past the
  first. Values given as `shared` are the same for every copy of a run, and held once, so a line of letters moves by
  setting one value. A run hides whole, so what hides on its own needs a run of its own. For a run of many copies, writing
  to `values` and calling `changed` is faster than setting each one: each copy's numbers lie in the order its values
  were named. A run that grows past any size it has had gets a new `values`, so read it again after a `resize`.
- **Any shape.** A batch draws a flat square, corners from -1 to 1, unless you give it a `shape`. It draws a copy of the
  shape's attributes, index and draw range, so yours stays as it was; morph targets aren't drawn. Every copy draws all
  of it, so copies of different sizes of detail share the finest one.
- **At most 16 attributes.** WebGL 2 promises a shader 16, and a browser can count every attribute the shader declares,
  whether or not it reads it, as Chrome does. A batch counts one for each value and one for each attribute its shape
  has, read or not, since it can't see the shader. For every material but a `RawShaderMaterial` it also counts the
  `position`, `normal` and `uv` Three.js declares, and `color` when the material has `vertexColors`. So the square leaves
  room for 13 values on a `ShaderMaterial` and 15 on a `RawShaderMaterial`. A batch throws past 16: put small values
  together in one of up to 4 numbers, and give it a shape with only the attributes its shader reads. Some things it
  can't see take more: a matrix among the shape's attributes takes one for each of its columns, a map that reads a
  second set of uvs makes Three.js declare it, and so does a `define` that switches one of Three.js's attributes on.
  It counts once, when it's made, so `vertexColors` switched on later isn't counted either.
- **One material.** A batch draws with one material, so what differs goes in its fields. A texture array lets one
  material read many pictures: put which one in a field. The batch doesn't free the material, so own it as you own
  anything you make. Copies paint in order only when it draws in one pass: Three.js draws a see-through material that
  shows both sides twice, every back and then every front, so the batch throws unless `forceSinglePass` is on.
- **No raycasts.** Only your shader knows where each copy is drawn, so Three.js's `Raycaster` can't find one, and the
  batch's mesh never answers it. Find what's under the pointer from the values you gave the copies.

## Suggested standards

wobbree doesn't enforce these, but they keep a game's code easy to find your way around: every file is laid out the
same way, so you always know where to look.

- **One entity per file, named after it, ending in `.entity.ts`.** `Cube.entity.ts` holds `Cube`. An entity's name is
  capitalized like a class's, so the ending is what tells an entity's file apart from a class's, or from a plain
  module of functions and values.
- **One scene per file, ending in `.scene.ts`, holding the scene's name with "Scene" after it.** `Title.scene.ts` holds
  `TitleScene`.
- **An entity's shaders sit beside it, in a file named after it, ending in `.glsl.ts`.** Shaders are the small programs,
  written in GLSL, that run on the graphics card. `Cube.glsl.ts` holds the ones `Cube.entity.ts` hands its
  `ShaderMaterial`, as strings named in capitals, such as `CUBE_VERTEX` and `CUBE_FRAGMENT`: a language of its own
  reads best in a file of its own, even though only the entity uses it. GLSL functions that more than one entity's
  shaders use go in `.glsl.ts` files of their own, wherever the game keeps them, each exported as a string, such as
  `EDGES`. GLSL has no imports, so a shader pastes in each one it uses before its own code, as `${EDGES}` in its
  template string. None pastes in another, so no function is defined twice.
- **The game's data goes in files ending in `.data.ts`,** such as its levels, its characters or a table of tuning
  numbers: values only, each checked against its type with `satisfies`, with no functions or classes, so the ending
  tells data apart from code. The types they're checked against live with the code that reads them.
- **The entity or scene comes first,** right after the imports. Its types and defaults follow, then the file's private
  constants and helpers, in the order it uses them. A function can be called before its declaration, and the
  constants are read only when it runs, so this order works.
- **What it is goes in its arguments; what changes goes through `update`.** Arguments are fixed when an entity is
  built, like a cube's size. `update` carries what changes while it's shown, like its angle, and the entity does
  costly work only when a value that work depends on has changed.
- **Code goes where its meaning belongs, however many files use it today.** A concept of its own, like a rectangle or a
  spring's formula, gets a shared home even with one user, so the next feature finds it instead of writing a second
  copy. Moving it adds no options or layers, and its home is named for its subject, never `utils`. What only means
  something inside one feature, such as its numbers, stays with that feature. One subject is one file, in clear
  sections, and length alone is no reason to split it.
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

### `new Batch(owner, options)`

From `wobbree/batch`. Takes `material`, `fields`, and optionally `shared` and `shape`, each described under Batches.

| | |
| --- | --- |
| `mesh` | The one object that draws everything. Add it to a scene. Its `material` has the type of the one you gave, its geometry is replaced when the batch outgrows its room, and a raycast never hits it. |
| `add(owner, count)` | Adds a run of `count` copies, until `owner` is freed. After that, writing to the run does nothing. |
| `flush()` | If anything changed, copies every shown run to the GPU. Call it once a frame, before Three.js walks the scene. |

### `BatchRun`

What `add` returns. `BatchRun` and `BatchField` are exported as types, since only a batch makes them.

| | |
| --- | --- |
| `fields` | Each value by name, as a `BatchField`, with `set(a, b?, c?, d?)` for the first copy and `setAt(index, a, b?, c?, d?)` for any. |
| `order` | Where it paints: over lower orders, and over runs of its own order added before it. 0 unless you set it. |
| `added` | Which run it was to be added to its batch, counting from 0: what settles runs of the same order. |
| `visible` | Whether it's drawn. Hidden, it isn't copied to the GPU. |
| `values`, `shared`, `changed()` | The numbers themselves, for writing many at once. Call `changed` after. `values` is a new array once the run grows past any size it has had. |
| `count`, `resize(count)` | How many copies it has. Resizing keeps its place. |

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
- **Draw calls.** Each mesh is drawn separately. For many copies of one mesh with Three.js's own materials, one
  `InstancedMesh` is far cheaper than many meshes; for many things your own shader draws in an order you set, a batch is.
- **Pixel density.** Each step up in density is the square in pixels to fill. That's why the stage caps it.

## Design

- Two files, [`src/index.ts`](src/index.ts) and [`src/batch.ts`](src/batch.ts), short enough to read in one sitting.
- In the core, Three.js is only a type import: wobbree checks `isObject3D` instead of importing Three.js, and your app
  makes the renderer and hands it to the stage. A batch has to make Three.js objects, so `wobbree/batch` imports Three.js
  as a peer dependency, your app's own copy.
- Freeing is explicit. Nothing is disposed unless an owner owns it, and the stage frees nothing it draws.
- Only what every game needs. Your camera, your layout and your look stay in your game.

## Development

Node 24 or later. `npm install`, then `npm run check` runs the type check, the linter (Oxlint), the tests and the build.
`npm run bench` runs the benchmark.

## License

[MIT](LICENSE)

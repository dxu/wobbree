import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Mesh,
  Sphere,
  Vector3,
} from "three";
import type { Owner } from "./index.ts";

/** Named values, each with how many numbers it has, 1 to 4. A shader reads each as an attribute of that name. */
export type FieldSizes = Readonly<Record<string, number>>;

export interface BatchOptions<
  Fields extends FieldSizes = FieldSizes,
  Shared extends FieldSizes = Record<never, number>,
  DrawnWith extends Material = Material,
> {
  /**
   * The material every instance is drawn with. The batch doesn't free it: whoever made it owns it. It has to draw in one
   * pass for runs to paint in order, so a see-through material drawn on both sides needs `forceSinglePass`.
   */
  readonly material: DrawnWith;
  /** The values each instance has of its own, which a run holds in `values`. */
  readonly fields: Fields;
  /** The values every instance of a run has alike, which it holds once, in `shared`. They come first in each instance. */
  readonly shared?: Shared;
  /**
   * The geometry each instance draws: a flat square with corners from -1 to 1 unless it's given one. The batch draws a
   * copy, its attributes, index and draw range, so the one it's given stays as it was; its morph targets aren't drawn.
   */
  readonly shape?: BufferGeometry;
}

/**
 * Draws many copies of a shape in a single draw call, each copy an instance with values of its own that its material's
 * shader reads. Whoever draws adds runs of instances and writes their values, and before each frame is drawn, `flush`
 * copies every shown run into one buffer on the GPU. A run paints over the runs before it, in the order of
 * `BatchRun.order`, then the order they were added. When nothing has changed, `flush` copies nothing. A batch with
 * nothing in it draws nothing, but its first frame sets it up: Three.js compiles its material and sends its buffers to
 * the GPU then, rather than on the frame its first instance shows.
 */
export class Batch<
  Fields extends FieldSizes = FieldSizes,
  Shared extends FieldSizes = Record<never, number>,
  DrawnWith extends Material = Material,
> {
  /**
   * The one object that draws every instance, with the material the batch was given. Add it to a scene. Its instances
   * are never left out as off screen, a raycast never hits it, and among a scene's other see-through objects it sorts
   * as one object, by its `renderOrder` and where it stands. It gets a new geometry when the batch outgrows its room,
   * so read `mesh.geometry` where it's needed rather than keeping it.
   */
  readonly mesh: Mesh<InstancedBufferGeometry, DrawnWith>;
  /** The batch's own copy of the shape each instance draws. */
  readonly #shape: BufferGeometry;
  readonly #layout: Layout;
  readonly #runs: BatchRun<Fields, Shared>[] = [];
  /** Where `flush` copies the instances to, which `mesh.geometry` draws from. */
  #room: Room;
  /** The part of the buffer the last flush wrote, which the GPU copies: from its start. */
  readonly #range = { start: 0, count: 0 };
  #changed = false;
  #unsorted = false;
  #added = 0;
  /** How a run tells the batch what `flush` has to do. */
  readonly #listener: RunListener = {
    changed: () => {
      this.#changed = true;
    },
    moved: () => {
      this.#changed = true;
      this.#unsorted = true;
    },
  };

  constructor(owner: Owner, { material, fields, shared, shape }: BatchOptions<Fields, Shared, DrawnWith>) {
    // Three.js draws such a material in two passes, every instance's back, then every instance's front, so an earlier
    // run's front would paint over a later run's back.
    if (material.transparent && material.side === DoubleSide && !material.forceSinglePass) {
      throw new Error("A batch's see-through material drawn on both sides needs forceSinglePass, or its runs paint out of order.");
    }
    // A copy of its own: outgrowing its room frees the GPU's copy of the shape, which anything else drawing it still uses.
    // Nothing has to own the copy, since it's each room's geometry that draws it and frees what the GPU holds of it.
    this.#shape = shape?.clone() ?? genSquare();
    this.#layout = genLayout(fields, shared ?? {}, this.#shape, material);
    this.#room = genRoom(this.#shape, this.#layout, INITIAL_CAPACITY);
    this.mesh = owner.own(new Mesh(this.#room.geometry, material));
    // Only the shader knows where the instances are. The shape's bounds don't say, so they're never left out as off
    // screen, and a ray that hit the shape where the mesh stands would hit none of them, so a raycast finds nothing.
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => undefined;
    owner.onDispose(() => this.mesh.geometry.dispose());
  }

  /**
   * Adds a run of `count` instances, until `owner` is freed. Its `order` starts at 0, so it paints over the runs of that
   * order added before it.
   */
  add(owner: Owner, count: number): BatchRun<Fields, Shared> {
    const run = new BatchRun<Fields, Shared>(this.#listener, this.#layout, count, this.#added);
    this.#added++;
    this.#runs.push(run);
    this.#listener.moved();
    owner.onDispose(() => {
      this.#runs.splice(this.#runs.indexOf(run), 1);
      this.#listener.changed();
      cutOff(run);
    });
    return run;
  }

  /**
   * If anything changed, copies every shown run to the GPU. Call it once a frame, before Three.js walks the scene to draw
   * it: before `renderer.render`, or from the scene's `onBeforeRender`. A mesh's `onBeforeRender` is too late, since
   * Three.js has sent the frame's buffers by then: that frame would draw the new number of instances from the values the
   * GPU already had, and a batch that outgrew its room would be drawn with the geometry it had just freed.
   */
  flush(): void {
    if (!this.#changed) return;
    const runs = this.#runs;
    if (this.#unsorted) {
      sortIntoPaintOrder(runs);
      this.#unsorted = false;
    }
    let count = 0;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index] as BatchRun<Fields, Shared>;
      if (run.visible) count += run.count;
    }
    if (count > this.#room.capacity) {
      // Made before the old room is freed, so a batch that can't get the memory stays as it was.
      const room = genRoom(this.#shape, this.#layout, Math.max(count, this.#room.capacity * 2));
      this.mesh.geometry.dispose();
      this.mesh.geometry = room.geometry;
      this.#room = room;
    }
    let at = 0;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index] as BatchRun<Fields, Shared>;
      if (run.visible) at = this.#write(run, at);
    }
    // With nothing shown there's nothing to copy; a range of nothing would make WebGL copy the whole buffer.
    if (at > 0) {
      const buffer = this.#room.buffer;
      buffer.clearUpdateRanges();
      // The same range each time, so a frame where something moves makes no new range. Three.js empties the list after
      // each upload, though, and an emptied list takes new storage on its next push: one small allocation.
      this.#range.count = at;
      buffer.updateRanges.push(this.#range);
      buffer.needsUpdate = true;
    }
    this.mesh.geometry.instanceCount = count;
    this.#changed = false;
  }

  /** Writes `run`'s instances into the buffer from value `at`. Returns where it ended. */
  #write(run: BatchRun<Fields, Shared>, at: number): number {
    const { sharedSize, ownSize } = this.#layout;
    const target = this.#room.values;
    const { shared, values, count } = run;
    const stride = sharedSize + ownSize;
    // Copied number by number: a view of `values` would be a new object for each instance, each frame something moves.
    for (let index = 0; index < count; index++) {
      const start = at + index * stride;
      for (let offset = 0; offset < sharedSize; offset++) target[start + offset] = shared[offset] ?? 0;
      const from = index * ownSize;
      for (let offset = 0; offset < ownSize; offset++) target[start + sharedSize + offset] = values[from + offset] ?? 0;
    }
    return at + count * stride;
  }
}

// A batch makes its runs, and a run its fields, so they leave this file as types to name, not classes to construct.
export type { BatchField, BatchRun };

/**
 * Cuts a freed run off from its batch, which draws none of it any more, so writing to it copies nothing. `BatchRun`
 * sets this as it's defined, since only a run's own class can reach the listener it keeps to itself.
 */
let cutOff: (run: BatchRun<FieldSizes, FieldSizes>) => void;

/**
 * A run of instances in a `Batch`, which `Batch.add` returns. Its `fields` set its values by name:
 * `run.fields.place.set(10, 20)`. Code that writes many at once can write its instances' values straight into `values`,
 * one instance after another, and what they all have alike into `shared`, then call `changed`.
 */
class BatchRun<Fields extends FieldSizes = FieldSizes, Shared extends FieldSizes = Record<never, number>> {
  /** The values every instance of the run has alike. */
  readonly shared: Float32Array;
  /** When it was added, among its batch's runs, which settles the order of runs of the same `order`. */
  readonly added: number;
  #listener: RunListener;
  readonly #layout: Layout;
  #count: number;
  #values: Float32Array;
  #order = 0;
  #visible = true;
  #fields: Readonly<Record<keyof Fields | keyof Shared, BatchField>> | undefined;

  constructor(listener: RunListener, layout: Layout, count: number, added: number) {
    checkCount(count);
    this.#listener = listener;
    this.#layout = layout;
    this.#count = count;
    this.added = added;
    this.#values = new Float32Array(count * layout.ownSize);
    this.shared = new Float32Array(layout.sharedSize);
  }

  static {
    cutOff = (run) => {
      run.#listener = NOBODY;
    };
  }

  /** The run's values by name, made the first time they're asked for, so a run written through `values` holds none. */
  get fields(): Readonly<Record<keyof Fields | keyof Shared, BatchField>> {
    const { places, ownSize } = this.#layout;
    this.#fields ??= Object.fromEntries(places.map((place) => [place.name, new BatchField(this, place, ownSize)])) as Record<keyof Fields | keyof Shared, BatchField>;
    return this.#fields;
  }

  /** How many instances the run has. */
  get count(): number {
    return this.#count;
  }

  /**
   * The run's instances' own values: `count` instances, each its values in the order they were named, then any room it
   * keeps for growing back into. A `resize` past that room makes a new array, so read `values` again after one.
   */
  get values(): Float32Array {
    return this.#values;
  }

  /** Where the run paints: over every run of a lower order, and of the same order, over those added before it. 0 unless it's set. */
  get order(): number {
    return this.#order;
  }

  set order(order: number) {
    if (order === this.#order) return;
    this.#order = order;
    this.#listener.moved();
  }

  /** Whether the run is drawn at all. */
  get visible(): boolean {
    return this.#visible;
  }

  set visible(visible: boolean) {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#listener.changed();
  }

  /**
   * Gives the run `count` instances, keeping its place in the batch. The instances it keeps keep their values, and those
   * it gains start at 0, as a new run's do; it makes room only when it grows past any size it has had.
   */
  resize(count: number): void {
    checkCount(count);
    if (count === this.#count) return;
    const { ownSize } = this.#layout;
    if (count * ownSize > this.#values.length) {
      const values = new Float32Array(count * ownSize);
      values.set(this.#values.subarray(0, this.#count * ownSize));
      this.#values = values;
    } else if (count > this.#count) {
      this.#values.fill(0, this.#count * ownSize, count * ownSize);
    }
    this.#count = count;
    this.#listener.changed();
  }

  /** Says `values` or `shared` changed, so the batch copies them before the next frame. */
  changed(): void {
    this.#listener.changed();
  }
}

/**
 * One named value of a run, set with up to four numbers: `place.set(10, 20)`, or `place.setAt(3, 10, 20)` for an instance
 * past the first. A value every instance shares has one place, whichever instance it's asked for.
 */
class BatchField {
  readonly #run: Pick<BatchRun, "values" | "shared" | "changed">;
  readonly #place: FieldPlace;
  /** How many values each instance of the run has of its own. */
  readonly #ownSize: number;

  constructor(run: Pick<BatchRun, "values" | "shared" | "changed">, place: FieldPlace, ownSize: number) {
    this.#run = run;
    this.#place = place;
    this.#ownSize = ownSize;
  }

  /** Sets the value of the run's first instance, or of all of them if it's shared. */
  set(a: number, b = 0, c = 0, d = 0): void {
    this.setAt(0, a, b, c, d);
  }

  /** Sets instance `index`'s value. Numbers past the value's size are left out. */
  setAt(index: number, a: number, b = 0, c = 0, d = 0): void {
    const { offset, size, shared } = this.#place;
    const values = shared ? this.#run.shared : this.#run.values;
    const at = shared ? offset : index * this.#ownSize + offset;
    values[at] = a;
    if (size > 1) values[at + 1] = b;
    if (size > 2) values[at + 2] = c;
    if (size > 3) values[at + 3] = d;
    this.#run.changed();
  }
}

/** Where a named value sits: in a run's `shared` or its instances' own `values`, how far in, and how many numbers it has. */
interface FieldPlace {
  readonly name: string;
  readonly size: number;
  readonly shared: boolean;
  readonly offset: number;
}

/** Where a batch's values sit, and how many numbers each instance shares with its run and has of its own. */
interface Layout {
  readonly places: readonly FieldPlace[];
  readonly sharedSize: number;
  readonly ownSize: number;
}

/** What a run tells its batch: that something in it changed, or that it paints in a new place. */
interface RunListener {
  changed(): void;
  moved(): void;
}

/** Room for a batch's instances: the numbers `flush` writes, the buffer that takes them to the GPU, and the geometry that draws them. */
interface Room {
  /** How many instances fit. */
  readonly capacity: number;
  readonly values: Float32Array;
  readonly buffer: InstancedInterleavedBuffer;
  readonly geometry: InstancedBufferGeometry;
}

/**
 * The layout of `fields` and `shared`, which can't reuse a name, or a name `shape` already has, such as `position`, nor
 * give the shader of `material` more attributes than WebGL 2 promises.
 */
function genLayout(fields: FieldSizes, shared: FieldSizes, shape: BufferGeometry, material: Material): Layout {
  const places: FieldPlace[] = [];
  const sizes = { own: 0, shared: 0 };
  const layOut = (group: FieldSizes, isShared: boolean) => {
    for (const [name, size] of Object.entries(group)) {
      if (Object.hasOwn(shape.attributes, name)) throw new Error(`A batch's value can't be named ${name}: its shape has an attribute of that name.`);
      if (places.some((each) => each.name === name)) throw new Error(`A batch has two values named ${name}.`);
      if (!Number.isInteger(size) || size < 1 || size > 4) throw new Error(`A batch's value ${name} has ${size} numbers; a value has 1 to 4.`);
      places.push({ name, size, shared: isShared, offset: isShared ? sizes.shared : sizes.own });
      if (isShared) sizes.shared += size;
      else sizes.own += size;
    }
  };
  layOut(shared, true);
  layOut(fields, false);
  // Past the limit the shader fails to link, and only on a GPU. A browser can give a slot to every attribute a shader
  // declares, read or not, as Chrome does. So the ones Three.js declares count, and every attribute the shape has
  // counts whether or not the shader reads it, since the batch can't see the shader.
  const counted = new Set(Object.keys(shape.attributes));
  for (const { name } of places) counted.add(name);
  if (!("isRawShaderMaterial" in material)) {
    for (const name of THREE_DECLARES) counted.add(name);
    if (material.vertexColors) counted.add("color");
  }
  if (counted.size > MOST_ATTRIBUTES) {
    throw new Error(
      `A batch counts ${counted.size} attributes, and WebGL 2 promises ${MOST_ATTRIBUTES}: each value, each attribute its shape has, and those ` +
        "Three.js declares unless the material is a RawShaderMaterial (position, normal and uv, and color with vertexColors). " +
        "Put small values together in one of up to 4 numbers, or take attributes the shader doesn't read off the shape.",
    );
  }
  return { places, sharedSize: sizes.shared, ownSize: sizes.own };
}

/** The most attributes a shader can declare and still draw on every WebGL 2 device. */
const MOST_ATTRIBUTES = 16;
/**
 * The attributes Three.js declares at the start of every vertex shader but a `RawShaderMaterial`'s. It declares `color`
 * too for a material with `vertexColors`, and more where a map reads a second set of uvs or one of the material's
 * `defines` switches an attribute on, which the batch can't see.
 */
const THREE_DECLARES = ["position", "normal", "uv"];
/** What a freed run tells: nobody. */
const NOBODY: RunListener = { changed: () => undefined, moved: () => undefined };

/** Throws unless `count` can be a run's number of instances: a whole number, 0 or more. */
function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) throw new Error(`A run can't have ${count} instances: it has a whole number of them, 0 or more.`);
}

/**
 * Puts `runs` in paint order, in place. Runs change places little from one frame to the next, so they're nearly in order,
 * where an insertion sort takes one pass and, unlike `Array.sort`, makes no new objects.
 */
function sortIntoPaintOrder<Run extends Pick<BatchRun, "order" | "added">>(runs: Run[]): void {
  for (let index = 1; index < runs.length; index++) {
    const run = runs[index] as Run;
    let at = index - 1;
    for (; at >= 0; at--) {
      const before = runs[at] as Run;
      if (before.order < run.order || (before.order === run.order && before.added < run.added)) break;
      runs[at + 1] = before;
    }
    runs[at + 1] = run;
  }
}

/** Room for `capacity` instances of `shape`, each laid out as `layout` says. */
function genRoom(shape: BufferGeometry, layout: Layout, capacity: number): Room {
  const { places, sharedSize, ownSize } = layout;
  const stride = sharedSize + ownSize;
  const values = new Float32Array(capacity * stride);
  const buffer = new InstancedInterleavedBuffer(values, stride).setUsage(DynamicDrawUsage);
  const geometry = new InstancedBufferGeometry();
  for (const [name, attribute] of Object.entries(shape.attributes)) geometry.setAttribute(name, attribute);
  geometry.setIndex(shape.getIndex());
  geometry.setDrawRange(shape.drawRange.start, shape.drawRange.count);
  for (const { name, size, shared, offset } of places) {
    geometry.setAttribute(name, new InterleavedBufferAttribute(buffer, size, shared ? offset : sharedSize + offset));
  }
  geometry.instanceCount = 0;
  // Three.js would work the geometry's bounds out from the shape, which says nothing about where the shader draws the
  // instances, so they're set here. The sphere is round everything, so nothing that culls by it drops the batch, and
  // its middle is where the mesh stands, which is what see-through objects are sorted by. The box is round nothing,
  // so a scene's bounds leave the batch out.
  geometry.boundingSphere = new Sphere(new Vector3(), Infinity);
  geometry.boundingBox = new Box3();
  return { capacity, values, buffer, geometry };
}

/** A flat square with corners from -1 to 1. */
function genSquare(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(SQUARE), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/** How many instances a batch has room for at first; it doubles its room whenever it runs out. */
const INITIAL_CAPACITY = 64;
/** The square's corners, each x, y and z. */
const SQUARE = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];

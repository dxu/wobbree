import assert from "node:assert/strict";
import { test } from "node:test";
import { OrthographicCamera, PerspectiveCamera, Scene, type WebGLRenderer } from "three";
import { type GameScene, Owner, Stage, type StageRenderer, type Viewport } from "../src/index.ts";

/** Compiles only if Three.js's WebGLRenderer is everything a stage needs. */
function asStageRenderer(renderer: WebGLRenderer): StageRenderer {
  return renderer;
}

/** A stand-in for a WebGLRenderer, since Node has no WebGL: it records what the stage asks of it. */
function setup(width = 800, height = 500) {
  const calls: string[] = [];
  const canvas = { clientWidth: width, clientHeight: height };
  let loop: ((time: number) => void) | null = null;
  const renderer: StageRenderer = {
    domElement: canvas as unknown as HTMLCanvasElement,
    autoClear: true,
    setPixelRatio(density) {
      calls.push(`density ${density}`);
    },
    setSize(sizeWidth, sizeHeight, updateStyle) {
      calls.push(`size ${sizeWidth}x${sizeHeight}${updateStyle === false ? "" : ", with the canvas's CSS"}`);
    },
    setAnimationLoop(callback) {
      loop = callback;
      calls.push(callback === null ? "stop" : "start");
    },
    clear() {
      calls.push("clear");
    },
    clearDepth() {
      calls.push("clear depth");
    },
    render(root, camera) {
      calls.push(`draw ${root.name} through ${camera.name}`);
    },
  };
  const frame = () => loop?.(0);
  return { renderer, canvas, calls, frame };
}

function scene(name: string): GameScene & { readonly layouts: Viewport[] } {
  const root = new Scene();
  root.name = name;
  const camera = new OrthographicCamera();
  camera.name = `${name}'s camera`;
  const layouts: Viewport[] = [];
  return {
    root,
    camera,
    layouts,
    layOut(viewport) {
      layouts.push(viewport);
    },
  };
}

test("a WebGLRenderer can be a stage's renderer", () => {
  assert.equal(typeof asStageRenderer, "function");
});

test("draws a shown scene through its camera, at the canvas's size and the screen's density", () => {
  globalThis.devicePixelRatio = 2;
  const { renderer, calls, frame } = setup(800, 500);
  const stage = new Stage(renderer);
  const title = scene("title");
  stage.show(1, title);
  frame();

  assert.equal(renderer.autoClear, false);
  assert.deepEqual(calls, ["start", "density 2", "size 800x500", "clear", "draw title through title's camera"]);
  assert.deepEqual(title.layouts, [{ width: 800, height: 500, density: 2 }]);
  assert.deepEqual(stage.viewport, { width: 800, height: 500, density: 2 });
});

test("lays scenes out again only when the canvas's size or the density changes", () => {
  globalThis.devicePixelRatio = 2;
  const { renderer, canvas, frame } = setup(800, 500);
  const stage = new Stage(renderer);
  const title = scene("title");
  stage.show(1, title);
  frame();
  frame();
  assert.equal(title.layouts.length, 1);

  canvas.clientWidth = 640;
  frame();
  globalThis.devicePixelRatio = 1;
  frame();

  assert.deepEqual(title.layouts, [
    { width: 800, height: 500, density: 2 },
    { width: 640, height: 500, density: 2 },
    { width: 640, height: 500, density: 1 },
  ]);
});

/** The density a new stage draws at, given `maxDensity` or not. */
function densityWith(maxDensity?: number): number | undefined {
  const { renderer, frame } = setup();
  const stage = new Stage(renderer, maxDensity === undefined ? {} : { maxDensity });
  frame();
  return stage.viewport?.density;
}

test("caps the density at maxDensity, which is 2 unless given", () => {
  globalThis.devicePixelRatio = 3;

  assert.equal(densityWith(), 2);
  assert.equal(densityWith(3), 3);
  assert.equal(densityWith(1), 1);
});

test("draws layers from the lowest up, clearing only depth between them", () => {
  globalThis.devicePixelRatio = 1;
  const { renderer, calls, frame } = setup();
  const stage = new Stage(renderer);
  stage.show(2, scene("hud"));
  stage.show(0, scene("background"));
  stage.show(1, scene("match"));
  calls.length = 0;
  frame();

  assert.deepEqual(calls, [
    "density 1",
    "size 800x500",
    "clear",
    "draw background through background's camera",
    "clear depth",
    "draw match through match's camera",
    "clear depth",
    "draw hud through hud's camera",
  ]);
});

test("showing a scene on a layer replaces the one there, and showing nothing empties it", () => {
  globalThis.devicePixelRatio = 1;
  const { renderer, calls, frame } = setup();
  const stage = new Stage(renderer);
  stage.show(0, scene("background"));
  stage.show(1, scene("title"));
  stage.show(1, scene("lobby"));
  frame();
  assert.deepEqual(calls.filter((call) => call.startsWith("draw")), [
    "draw background through background's camera",
    "draw lobby through lobby's camera",
  ]);

  calls.length = 0;
  stage.show(1, undefined);
  frame();
  assert.deepEqual(calls, ["clear", "draw background through background's camera"]);
});

test("a scene shown after the first frame is laid out at once", () => {
  globalThis.devicePixelRatio = 1;
  const { renderer, frame } = setup(800, 500);
  const stage = new Stage(renderer);
  frame();
  const lobby = scene("lobby");
  stage.show(1, lobby);

  assert.deepEqual(lobby.layouts, [{ width: 800, height: 500, density: 1 }]);
});

test("a scene can switch the camera it's seen through", () => {
  globalThis.devicePixelRatio = 1;
  const { renderer, calls, frame } = setup();
  const stage = new Stage(renderer);
  const wide = new PerspectiveCamera();
  wide.name = "the wide shot";
  const close = new PerspectiveCamera();
  close.name = "the close-up";
  let camera = wide;
  const root = new Scene();
  root.name = "match";
  stage.show(1, {
    root,
    get camera() {
      return camera;
    },
    layOut() {},
  });
  frame();
  camera = close;
  frame();

  assert.deepEqual(calls.filter((call) => call.startsWith("draw")), [
    "draw match through the wide shot",
    "draw match through the close-up",
  ]);
});

test("a canvas the page hasn't given a size draws nothing", () => {
  globalThis.devicePixelRatio = 1;
  const { renderer, calls, frame } = setup(0, 0);
  const stage = new Stage(renderer);
  const title = scene("title");
  stage.show(1, title);
  frame();

  assert.deepEqual(calls, ["start"]);
  assert.deepEqual(title.layouts, []);
  assert.equal(stage.viewport, undefined);
});

test("disposing the stage stops it drawing, so an owner can own it", () => {
  globalThis.devicePixelRatio = 1;
  const { renderer, calls, frame } = setup();
  const owner = new Owner();
  const stage = owner.own(new Stage(renderer));
  stage.show(1, scene("title"));
  owner.dispose();
  calls.length = 0;
  frame();

  assert.deepEqual(calls, []);
});

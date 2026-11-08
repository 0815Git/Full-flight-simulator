import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { defaultWorldConfig } from '../src/config';
import { HeightGrid, groundHeight, sightBlocked } from '../src/height';
import { keyId } from '../src/lod';
import { encodeTerrarium } from '../src/synth';

describe('height', () => {
  it('sample centers, midpoints and edges', () => {
    // 2x1 grid: 100 m and 300 m
    const grid = new HeightGrid(2, 1, Uint16Array.from([32768 + 100, 32768 + 300]));
    expect(grid.sample(0.25, 0.5)).toBeCloseTo(100, 3);
    expect(grid.sample(0.75, 0.5)).toBeCloseTo(300, 3);
    expect(grid.sample(0.5, 0.5)).toBeCloseTo(200, 3);
    expect(grid.sample(0, 0)).toBeCloseTo(100, 3);
    expect(grid.sample(1, 1)).toBeCloseTo(300, 3);
  });

  it('fromTerrarium rounds meters', () => {
    const img = encodeTerrarium([0, 8848, -415, 100.5], 4, 1);
    const grid = HeightGrid.fromTerrarium(img);
    expect(grid.samples[0]).toBe(32768);
    expect(grid.samples[1]).toBe(32768 + 8848);
    expect(grid.samples[2]).toBe(32768 - 415);
    expect([32768 + 100, 32768 + 101]).toContain(grid.samples[3]);
  });

  it('groundHeight prefers the finest resident tile and honors the offset', () => {
    const world = defaultWorldConfig();
    const grids = new Map<string, HeightGrid>();
    grids.set(keyId({ zoom: 9, x: 0, z: 0 }), new HeightGrid(1, 1, Uint16Array.from([32768 + 10])));
    grids.set(keyId({ zoom: 10, x: 1, z: 1 }), new HeightGrid(1, 1, Uint16Array.from([32768 + 20])));
    const anchor = { worldOffset: new THREE.Vector3(1000, 0, 0) };
    const half = world.tileSize / 2;
    // abs (half+1, half+1) lies in z10 tile (1,1)
    expect(groundHeight(grids, world, anchor, { x: half + 1 + 1000, y: 0, z: half + 1 })).toBe(20);
    // abs (1, 1) lies only in the z9 tile
    expect(groundHeight(grids, world, anchor, { x: 1 + 1000, y: 0, z: 1 })).toBe(10);
    expect(groundHeight(grids, world, anchor, { x: -1 + 1000, y: 0, z: 1 })).toBeUndefined();
  });
  /** One z9 tile with a ridge running across it in x: `samples` is read left
   *  to right over the whole tile, and z is flat. */
  const ridgeWorld = (samples: number[]) => {
    const world = defaultWorldConfig();
    const grids = new Map<string, HeightGrid>();
    grids.set(
      keyId({ zoom: 9, x: 0, z: 0 }),
      new HeightGrid(samples.length, 1, Uint16Array.from(samples.map((m) => 32768 + m))),
    );
    return { world, grids, anchor: { worldOffset: new THREE.Vector3() } };
  };
  /** A point `u` of the way across that tile, `y` metres up. */
  const at = (world: ReturnType<typeof defaultWorldConfig>, u: number, y: number) =>
    ({ x: u * world.tileSize, y, z: world.tileSize / 2 });

  it('sightBlocked closes on a ridge and clears over it', () => {
    const { world, grids, anchor } = ridgeWorld([0, 0, 0, 500, 500, 0, 0, 0]);
    const eye = (y: number) => at(world, 0.05, y);
    const mark = (y: number) => at(world, 0.95, y);
    expect(sightBlocked(grids, world, anchor, eye(100), mark(100))).toBe(true);
    expect(sightBlocked(grids, world, anchor, eye(800), mark(800))).toBe(false);
    // and it is the same sight either way round
    expect(sightBlocked(grids, world, anchor, mark(100), eye(100))).toBe(true);
  });

  it('sightBlocked gives the ground overBy metres of slack', () => {
    const { world, grids, anchor } = ridgeWorld([0, 0, 0, 500, 500, 0, 0, 0]);
    const eye = at(world, 0.05, 480);
    const mark = at(world, 0.95, 480);
    expect(sightBlocked(grids, world, anchor, eye, mark)).toBe(true);
    expect(sightBlocked(grids, world, anchor, eye, mark, { overBy: 50 })).toBe(false);
  });

  it('sightBlocked leaves out skipNear metres by the eye', () => {
    const { world, grids, anchor } = ridgeWorld([500, 500, 0, 0, 0, 0, 0, 0]);
    const eye = at(world, 0.02, 100);
    const mark = at(world, 0.9, 100);
    expect(sightBlocked(grids, world, anchor, eye, mark)).toBe(true);
    // the ridge runs to a fifth of the way across — step past it and the
    // rest of the line is clear
    const past = 0.3 * world.tileSize;
    expect(sightBlocked(grids, world, anchor, eye, mark, { skipNear: past })).toBe(false);
  });

  it('sightBlocked treats ground it knows nothing about as out of the way', () => {
    const world = defaultWorldConfig();
    const anchor = { worldOffset: new THREE.Vector3() };
    const empty = new Map<string, HeightGrid>();
    expect(sightBlocked(empty, world, anchor, { x: 0, y: 0, z: 0 }, { x: 9_000, y: 0, z: 0 }))
      .toBe(false);
    // a line that goes nowhere is not blocked either
    const { grids } = ridgeWorld([500]);
    expect(sightBlocked(grids, world, anchor, { x: 10, y: 0, z: 10 }, { x: 10, y: 0, z: 10 }))
      .toBe(false);
  });
});

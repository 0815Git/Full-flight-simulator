import { describe, expect, it } from 'vitest';
import { defaultStreamingConfig } from '../src/config';
import {
  desiredTiles, detailTiles, keyId, type LodOptions, type TileKey, type Vec3Like,
} from '../src/lod';

function defaults(): LodOptions {
  return {
    baseZoom: 9,
    maxZoom: 15,
    baseTileSize: 66_400,
    radius: 6,
    thresholds: defaultStreamingConfig().thresholds,
  };
}

function run(opts: LodOptions, cam: Vec3Like): TileKey[] {
  const out: TileKey[] = [];
  desiredTiles(opts, cam, out);
  return out;
}

function probes(): Vec3Like[] {
  const ts = 66_400;
  const xz: [number, number][] = [
    [0, 0],
    [0.5 * ts, 0.5 * ts],
    [0.25 * ts, 0.75 * ts],
    [3.3 * ts, -2.7 * ts],
    [-ts, -ts],
  ];
  const alts = [2, 500, 5_000, 60_000];
  return xz.flatMap(([x, z]) => alts.map((y) => ({ x, y, z })));
}

describe('lod', () => {
  it('structural invariants', () => {
    const opts = defaults();
    for (const cam of probes()) {
      const keys = run(opts, cam);
      const set = new Set(keys.map(keyId));
      expect(set.size, `duplicates at ${JSON.stringify(cam)}`).toBe(keys.length);
      for (const k of keys) {
        expect(k.zoom).toBeGreaterThanOrEqual(opts.baseZoom);
        expect(k.zoom).toBeLessThanOrEqual(opts.maxZoom);
        // no key together with an ancestor
        let x = k.x;
        let z = k.z;
        for (let zoom = k.zoom - 1; zoom >= opts.baseZoom; zoom--) {
          x >>= 1;
          z >>= 1;
          expect(set.has(keyId({ zoom, x, z })), `${keyId(k)} has resident ancestor at ${zoom}`).toBe(false);
        }
      }
    }
  });

  // These values are identical to the C++ raytiles and Rust bevytiles
  // snapshot suites — cross-language behavioral equivalence.
  it('snapshots', () => {
    const opts = defaults();
    const a = run(opts, { x: 0, y: 500, z: 0 });
    const b = run(opts, { x: 33_200, y: 5_000, z: 33_200 });
    const c = run(opts, { x: 0, y: 60_000, z: 0 });
    const count = (keys: TileKey[], zoom: number) => keys.filter((k) => k.zoom === zoom).length;
    const summary = [a.length, count(a, 15), b.length, count(b, 9), c.length, count(c, 15)];
    expect(summary).toEqual([252, 64, 252, 36, 117, 0]);
  });

  /**
   * The patch kept sharp round a watched spot. It must be a clean cut like
   * the camera's — one tile over every piece of ground, never two — it must
   * reach the finest zoom at the spot itself, and it must do so wherever the
   * spot falls, edges and corners of a tile included.
   */
  it('detail patch is a clean cut that reaches the finest zoom', () => {
    const opts = { ...defaults(), maxZoom: 17 };
    const ts = opts.baseTileSize;
    const spots: Vec3Like[] = [
      { x: 0.5 * ts, y: 0, z: 0.5 * ts },     // the middle of a tile
      { x: ts, y: 0, z: ts },                 // right on a corner of four
      { x: 2 * ts - 1, y: 0, z: 0.5 * ts },   // a hair inside an edge
      { x: -3.2 * ts, y: 0, z: 1.7 * ts },    // and in the negative quarter
    ];
    for (const at of spots) {
      const keys: TileKey[] = [];
      detailTiles(opts, at, 500, keys);
      const set = new Set(keys.map(keyId));
      expect(set.size, `duplicates at ${JSON.stringify(at)}`).toBe(keys.length);
      expect(keys.some((k) => k.zoom === opts.maxZoom), 'reaches the finest zoom').toBe(true);
      for (const k of keys) {
        expect(k.zoom).toBeGreaterThanOrEqual(opts.baseZoom);
        expect(k.zoom).toBeLessThanOrEqual(opts.maxZoom);
        let x = k.x;
        let z = k.z;
        for (let zoom = k.zoom - 1; zoom >= opts.baseZoom; zoom--) {
          x >>= 1;
          z >>= 1;
          expect(set.has(keyId({ zoom, x, z })), `${keyId(k)} has an ancestor at ${zoom}`).toBe(false);
        }
      }
      // the finest tiles are where the spot is, not somewhere else
      const finest = keys.filter((k) => k.zoom === opts.maxZoom);
      const size = ts / 2 ** (opts.maxZoom - opts.baseZoom);
      for (const k of finest) {
        const dx = Math.max(0, Math.max(k.x * size - at.x, at.x - (k.x + 1) * size));
        const dz = Math.max(0, Math.max(k.z * size - at.z, at.z - (k.z + 1) * size));
        expect(Math.hypot(dx, dz), `${keyId(k)} is too far from the spot`).toBeLessThan(1_000);
      }
    }
  });

  it('a detail patch of nothing asks for nothing', () => {
    const keys: TileKey[] = [];
    detailTiles({ ...defaults(), maxZoom: 17 }, { x: 0, y: 0, z: 0 }, 0, keys);
    expect(keys).toEqual([]);
  });

  it('high zoom reachable when low over tile center', () => {
    const opts = { ...defaults(), maxZoom: 17 };
    const keys = run(opts, { x: 33_200, y: 500, z: 33_200 });
    expect(keys.some((k) => k.zoom > 15)).toBe(true);
  });
});

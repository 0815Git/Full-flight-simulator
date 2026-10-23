/**
 * The link between the two screens: the SIMULATOR window (index.html) and the
 * MOVING MAP window (map.html).
 *
 * The simulator broadcasts where the aircraft is, several times a second; the
 * map window listens and redraws. A BroadcastChannel is used rather than
 * `postMessage` to the popup, so the two pages stay independent: the map can be
 * opened, closed and reopened at any moment (even refreshed) and it simply
 * picks up the next fix — there is no handshake to get wrong, and the simulator
 * never has to hold a reference to a window that may no longer exist.
 *
 * Everything here is one-way. The map is a display: it never steers.
 */

/** Channel name — same string in both windows, and in nothing else. */
export const MAP_CHANNEL = 'flightsim-map';

/** One position report: everything the map needs to draw the aircraft. */
export interface MapFix {
  /** Degrees, WGS84. */
  lat: number;
  lon: number;
  /** Compass heading of the nose, degrees (0 = north, 90 = east). */
  headingDeg: number;
  /** Altitude above sea level, feet. */
  altFt: number;
  /** Airspeed, knots. */
  speedKt: number;
  /** Fuel remaining, pounds — see FUEL_* in demo/main.ts. */
  fuelLb: number;
  /** True while the aircraft is sitting on a crash, so the map can say so. */
  crashed: boolean;
  /** Bumped by the simulator on every respawn (R), so the map drops its trail. */
  runId: number;
  /** THE ROUTE, in degrees: the line the aircraft is meant to fly, fixed in
   *  the world. The same points on every fix — it does not move with the
   *  aircraft, and flying off it does not change it. */
  route: {
    lat: number; lon: number;
    /** What the map writes on it; left out, it is numbered 1A, 2A, 3A… */
    name?: string;
  }[];
  /** THE THREAT CUES: each a place on the ground where the searching →
   *  tracking → launch sequence plays out, the set of pictures it uses, and
   *  how far along the route the aircraft must be for it to begin (metres).
   *  See CUES in demo/main.ts. */
  cues?: {
    set: string; lat: number; lon: number; gate: number;
    /** Seconds, each one optional: left out, the map's own knob is used. */
    delay?: number; searching?: number; tracking?: number; launch?: number;
  }[];
  /** THE TARGETS, each a picture in public/icons (`id` is its file name
   *  without the .png) standing at a place on the ground. They are fixed to
   *  the earth: the map carries them along as it moves, like any other mark on
   *  the ground — see TARGETS in demo/main.ts. */
  areas?: {
    file: string; lat: number; lon: number;
    /** how wide the picture is ON THE GROUND, in metres */
    width: number;
    /** which way the picture's own "up" points, degrees from north */
    turn: number;
  }[];
  targets?: {
    id: string; lat: number; lon: number;
    /** which family of look knobs it is drawn with; left out, 'threat'.
     *  'truck' is the one that can be pressed on the map. */
    kind?: 'threat' | 'after' | 'befor' | 'truck';
  }[];
  /** THE MARKS THAT HAVE BEEN DESTROYED, by id. The simulator counts the
   *  weapon's flight time, takes the model out of the world and says so here,
   *  so that the map and the camera agree to the frame about what is still
   *  standing. An id here never comes back while the flight runs. */
  struck?: string[];
  /** Where the route's line carries on backwards out of its first waypoint,
   *  so that there is already a flown stretch behind the aircraft when the
   *  flight begins. Line only: no waypoint of its own — see ROUTE_LEAD_IN_M
   *  in demo/main.ts. */
  leadIn?: { lat: number; lon: number };
  /** WHERE THE AIRCRAFT HAS ACTUALLY BEEN, in degrees, oldest first — which is
   *  not the route: the route is where it is meant to go. The simulator keeps
   *  this track whether or not anything draws it, and sends it on every
   *  TRAIL_EVERY-th fix, so a map that wants to show the difference between
   *  the two lines has it to hand. */
  trail?: { lat: number; lon: number }[];
}

/** One fix in this many carries the flown path (20 Hz / 10 = twice a second). */
export const TRAIL_EVERY = 10;

/**
 * ONE FRAME FROM THE BELLY CAMERA.
 *
 * The simulator holds the only picture of the world, so the camera under the
 * aircraft is rendered there and the finished frame is sent across — the map
 * window draws it as it is, in grey, under the camera's own markings. It
 * travels on the same channel as the fixes and is told apart by `kind`, so a
 * map window that does not care simply ignores it.
 */
export interface CamFrame {
  kind: 'cam';
  /** The picture itself. An ImageBitmap where the browser allows one to be
   *  sent, otherwise a JPEG data URL — the map draws either. */
  image: ImageBitmap | string;
  /** The lens it was taken through, in degrees. The map wears a quieter set
   *  of markings once this is tight — see --cam-zoom-fov in map.html. */
  fov?: number;
  /** THE BURST, while one is standing: where it belongs IN THIS PICTURE and
   *  how big, all as shares of the frame (0-1, x from the left, y from the
   *  top). The simulator works it out because only the simulator knows where
   *  the lens is pointing; the map lays the picture over the camera screen on
   *  that spot. Left out, there is nothing to show. */
  boom?: { x: number; y: number; w: number };
  /** The run it belongs to, so a stale frame from the last flight is dropped. */
  runId: number;
}

/**
 * THE ONE THING THAT TRAVELS THE OTHER WAY.
 *
 * Everything else on the channel runs from the simulator to the map. This one
 * runs back: the map says which spot of ground the belly camera is to hold —
 * a mark that has been pressed and then slaved from the panel — or that it is
 * to let go and return to its own pointing.
 */
export interface SlaveOrder {
  kind: 'slave';
  /** The spot to hold, or null to let go. */
  at: { lat: number; lon: number } | null;
}

/**
 * THE TRIGGER HAS BEEN PULLED.
 *
 * Sent by the simulator, where the stick is, to the map, which is the screen
 * that knows which store was chosen and where the mark stands. Nothing
 * travels with it: everything that happens next — taking the store off the
 * weapons screen, counting the flight time down, putting the burst over the
 * mark — happens on the map.
 */
export interface FireOrder {
  kind: 'fire';
}

/** What arrives on the channel: a position fix, a camera frame, or an order
 *  passing between the two windows. */
export type MapMessage = MapFix | CamFrame | SlaveOrder | FireOrder;

/** The window name of the map popup — reusing it focuses the same window. */
const MAP_WINDOW = 'flightsim-map-window';

/**
 * Open (or re-focus) the moving map on the second screen. Browsers only allow
 * this from a user gesture, so it is called straight out of the click that
 * starts the flight — and from the M key, which is a gesture too.
 * Returns false when the popup was blocked.
 */
export function openMapWindow(): boolean {
  const w = window.open(
    './map.html',
    MAP_WINDOW,
    `popup,width=${Math.round(screen.availWidth * 0.8)},height=${Math.round(screen.availHeight * 0.8)}`,
  );
  if (!w) return false;
  w.focus();
  return true;
}

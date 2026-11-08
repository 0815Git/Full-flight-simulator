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
  /**
   * WHERE THE DRONE HAS GOT TO on its circle, and which way its nose points.
   *
   * The drone is flown in the SIMULATOR, round the truck at a height; the
   * map only draws a mark for it. Sending its place with every fix is what
   * keeps the mark and the aircraft one thing: press the mark, press Slave,
   * and the camera swings onto the very drone that is drawn in the world.
   * Left out — before the flight is started — the map flies a drone of its
   * own on its --uav-* knobs, so the screen is never empty.
   */
  uav?: {
    lat: number; lon: number; headingDeg: number;
    /** HOW HIGH IT IS FLYING, in feet, over the ground the truck stands on —
     *  not above the sea, as `altFt` above is. It is the height the drone
     *  was given (UAV_ALT_M in demo/main.ts), and the figure the map writes
     *  beside its mark, so the two can never disagree. */
    heightFt?: number;
  };
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
    /** Whether the weapon can take this mark out; left out, it can. False
     *  says the mark has no struck face — no _after file exists for it — so
     *  the map never looks for one and never shows it as destroyed. */
    strike?: boolean;
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
  /** WHICH CAMERA TOOK IT: the one under the aircraft, or the one under the
   *  drone. Frames from both travel on the same channel, one after the other,
   *  and each camera screen takes only the ones it is showing. Left out, the
   *  one under the aircraft. */
  from?: 'self' | 'lion';
  /** The lens it was taken through, in degrees. The map wears a quieter set
   *  of markings once this is tight — see --cam-zoom-fov in map.html. */
  fov?: number;
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
  /**
   * HOLD THE DRONE ITSELF rather than a spot on the ground.
   *
   * A spot does not move, and the drone does — a place sent now would be
   * stale by the next frame. So the map does not send one: it says WHAT to
   * hold, and the simulator, which flies the drone, keeps the lens on it
   * frame by frame. `at` is null with this, and leaving both out lets go.
   */
  what?: 'uav';
}

/**
 * THE TRIGGER HAS BEEN PULLED.
 *
 * Sent by the simulator, where the stick is, to the map, which is the screen
 * that knows which store was chosen and where the mark stands. Taking the
 * store off the weapons screen happens on the map; the burst is the
 * simulator's own, since it burns in the world.
 */
export interface FireOrder {
  kind: 'fire';
  /**
   * Seconds from this word to the strike — the simulator's own
   * WEAPON_FLIGHT_S, sent so that the countdown on the weapons screen and
   * the fire on the truck are two faces of ONE clock. Were the map to keep
   * a time of its own, the two would drift apart the moment that knob was
   * touched. Older words carry none; the map then counts its own default.
   */
  flight?: number;
}

/**
 * A CAMERA KEY ON THE THROTTLE, pressed in the simulator's window.
 *
 * Two of the throttle's buttons do what the map's own panel does, so the
 * hand on the throttle never has to reach for the mouse:
 *
 *   'slave' — b6, the Slave key: hold the mark that is picked out on the map,
 *             or let go if one is already held. The map answers with a
 *             SlaveOrder, exactly as if the key on the panel had been pressed.
 *   'reset' — b7: the camera goes back to resting, and the map drops the
 *             mark it was holding.
 */
export interface CamKeyOrder {
  kind: 'camkey';
  what: 'slave' | 'reset';
}

/**
 * WHICH CAMERAS ARE BEING LOOKED AT.
 *
 * There are two: the one under the AIRCRAFT and the one under the DRONE that
 * circles the target. EVERY camera screen chooses its own, so both may be on
 * show at once — one screen on the aircraft, another on the drone — and the
 * map sends the whole list of what its screens are asking for.
 *
 * The simulator renders exactly what is on that list and nothing else: with
 * no camera screen open it renders neither, with one it renders one, and only
 * with two screens on two different cameras does it pay for both.
 *
 * It is sent whenever the list changes, whenever a camera screen is built or
 * the arrangement changes, and when the map starts — and again whenever the
 * simulator begins a new run, since a simulator that has just been loaded has
 * forgotten what it was told.
 */
export interface CamSourceOrder {
  kind: 'camsource';
  /** Every camera a screen is showing at this moment; empty when none is. */
  want: ('self' | 'lion')[];
}

/**
 * HOLD EVERYTHING, OR LET IT GO ON.
 *
 * Either window can call for it — the clock on the map's top panel, or Esc
 * in either one — and both obey: the simulator stops flying and the map
 * stops its clocks, so a threat that is half way through its sequence stays
 * half way through it. Whoever calls it says so on the channel, and the
 * other follows; neither answers back, so there is nothing to echo.
 */
export interface PauseOrder {
  kind: 'pause';
  on: boolean;
}

/**
 * START AGAIN — sent by the map when the key at the right of the top panel is
 * pressed. Each window puts its own house in order: the map drops what it has
 * been keeping (what was struck, what was chosen, which stores have gone) and
 * asks for the satellite picture afresh; the simulator puts the aircraft back
 * on the start point and the truck back on its wheels, whole and unburnt.
 */
export interface ResetOrder {
  kind: 'reset';
}

/**
 * WHICH MARKS ARE CHOSEN — the map's word, sent whenever that changes.
 *
 * The choosing happens on the map: a press on a mark, or on its row in one of
 * the lists. The simulator is told because the BADGE over the truck hangs on
 * it — it is only up while the truck is chosen. See MARK_WHEN_CHOSEN in
 * demo/main.ts.
 */
export interface PickOrder {
  kind: 'pick';
  /** Every mark chosen at this moment, by id; empty when none is. */
  ids: string[];
}

/**
 * THE TRIGGER PULLED FROM THE MAP'S WINDOW — Enter, pressed with the map in
 * front rather than the simulator.
 *
 * It is the other way round from FireOrder, which is the simulator SAYING a
 * weapon has gone. This one ASKS for one: the simulator answers it with
 * pullTrigger, exactly as if the red trigger had been pulled, and the fire
 * order then comes back over the channel like any other. So one key does the
 * whole chain from either window, and there is still only one place where a
 * weapon is let go.
 */
export interface TriggerOrder {
  kind: 'trigger';
}

/**
 * WHAT THE WEAPONS SCREEN IS SAYING, in the words the simulator's HUD prints.
 *
 * The choice of store is the MAP'S: it is made on the weapons screen, kept
 * there, and handed on there. The simulator does not work any of it out — it
 * is told, and it prints what it is told in the corner of the HUD, so the
 * pilot looking straight ahead knows what is armed without turning to the map.
 *
 * ONE CLOCK, as everywhere else in this: the seconds come over ready written,
 * from the same count that runs on the store itself, so the two screens can
 * never read a second apart.
 */
export interface WeaponCueOrder {
  kind: 'cue';
  /** The store the designation box is standing on, written as the HUD writes
   *  it — 'MK-84-S1', 'MK-82-S3', 'AA-S9' — or null when none is chosen.
   *  The S number is the store's place in the aircraft's own order, counted
   *  from 1: the top pair of 84s, the four 82s left to right, the bottom pair
   *  of 84s, then the two AAs. */
  store: string | null;
  /** The seconds to the strike, mm:ss, while that store's weapon is in the
   *  air — and null at every other moment. A store with a figure under it is
   *  one that has gone: the HUD stops blinking its name and holds it steady
   *  until the strike. */
  clock: string | null;
}

/** What arrives on the channel: a position fix, a camera frame, or an order
 *  passing between the two windows. */
export type MapMessage =
  MapFix | CamFrame | SlaveOrder | FireOrder | CamKeyOrder | PauseOrder | ResetOrder
  | PickOrder | CamSourceOrder | TriggerOrder | WeaponCueOrder;

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

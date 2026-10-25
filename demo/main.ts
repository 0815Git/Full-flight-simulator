/**
 * Israel Flight Simulator — free flight over the Eilat mountains, built on the
 * threetiles engine.
 *
 * ONE fixed start point in the SOUTH: the aircraft spawns on the course
 * centerline and from there the pilot flies wherever they like. Nothing is
 * scored, timed or exported and there are no rings; the centerline survives
 * only because it is what the spawn (and the "continue" recovery) is aimed
 * along — and it is what the MOVING MAP will later draw as the route.
 *
 * The MOVING MAP (map.html) runs on the second screen: it opens with the
 * flight and follows it live — see mapLink.ts for the link between the two.
 *
 * Keyboard: **A/D** roll, **Z/C** yaw, **W/S** pitch, **+/-** throttle,
 * **M** reopen the moving map,
 * **R** respawn at the start point, **E** continue: after a crash from the
 * crash spot, and in flight a free attitude recovery that keeps position and
 * speed. Touch: one-finger drag steers (right = bank right, down = nose up),
 * two-finger pinch is the throttle, tap resets after a crash.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Terrain, ZOOM_LEVELS, type WorldConfig, worldFromLatLon } from '../src';
import { FM, SPEED_RULE, applyStick, speedRuleTrimThrottle, stepDynamics } from './flight';
import {
  MAP_CHANNEL, type MapFix, type CamFrame, type SlaveOrder, type FireOrder,
  type CamKeyOrder, type PauseOrder, type ResetOrder,
  TRAIL_EVERY, openMapWindow,
} from './mapLink';

/**
 * HOW OFTEN THE GROUND IS ASKED FOR AGAIN, in seconds.
 *
 * Tiles come down over the wire and some of them do not: a server that is
 * busy, a moment without a connection, and that patch of ground is left as
 * the blurred parent under it for the rest of the flight — worst of all at
 * the very start, when every tile is asked for at once and the server is
 * most likely to say no.
 *
 * So every few seconds the simulator works out afresh what ground it wants
 * and asks again for whatever has not come down. It costs nothing when nothing is
 * missing, it never touches a tile that is already there, and there is
 * nothing to see: the ground only ever fills in — while flying, while held,
 * and after START AGAIN has put the aircraft back where it began.
 */
const TILE_CHECK_S = 3;
/**
 * …AND HOW LONG IT WAITS AFTER IT HAS ASKED FOR SOMETHING.
 *
 * LOOKING COSTS NOTHING — it is a walk down a few hundred names, and when
 * the ground is whole there is nothing to do — so it is done every few
 * seconds rather than once a minute. A minute sounds thrifty until you see
 * what it means: a tile that fails a breath after one look sits there
 * blurred for the whole of the next minute, which is exactly the patchy
 * ground this is here to stop.
 *
 * ASKING is another matter. When a server is refusing, the tiles it refused
 * would be asked for again on every look, which is how a busy server is
 * turned into a hostile one. So after a look that found something, it holds
 * off for this long before asking again.
 */
const TILE_RETRY_S = 10;

/** Sky/fog color (raylib's SKYBLUE, for parity with the original demo). */
const SKY = new THREE.Color().setRGB(70 / 255, 130 / 255, 190 / 255, THREE.SRGBColorSpace);
/** User-space drift (meters) that triggers a large-world rebase. */
const REBASE_THRESHOLD = 4096;
/** Touch-drag distance (px) for full stick deflection. */
const STEER_RADIUS = 100;
/** Airspeed limits (m/s). Pilot controls throttle with +/- keys (or pinch). */
const SPEED_START = 160; // initial airspeed at spawn (m/s) — a front-side cruise

// Throttle is an engine COMMAND (0..1); the point-mass flight model in
// ./flight.ts turns it into thrust and evolves the airspeed from the forces.
// initial engine command (0..1): holds SPEED_START in level flight
const THROTTLE_START = SPEED_RULE.enabled ? speedRuleTrimThrottle() : 0.4;
const THROTTLE_RATE = 0.5;   // how fast the +/- keys move the throttle (per second)

// -- Gamepad mapping (HOTAS: a stick and a throttle on separate USB ports) ---
// Each device has its OWN axes numbered from 0, so the indices below are read
// per device. Telling them apart by name is unreliable — the Warthog's stick is
// called "Joystick - HOTAS Warthog", with no "throttle" in it, and a stick from
// another set has another name again — so they are matched by USB product id
// (all Thrustmaster, vendor 044f), with the name as a fallback. Stick = roll (X)
// + pitch (Y), mirroring touch/keys; the two linked throttle levers set speed
// (+1 = slowest, −1 = fastest). Flip an INVERT flag if a direction feels
// reversed. Yaw stays on Z/C (the stick's axes here are roll and pitch only).
/** USB product ids (vendor 044f) that are THROTTLES. */
const GP_THROTTLE_PRODUCTS = ['0404']; // HOTAS Warthog Throttle
/** USB product ids that are STICKS. */
const GP_STICK_PRODUCTS = ['0402', '0422']; // Warthog Joystick, Solaris Base
/** If several sticks are plugged in, this one wins. */
const GP_STICK_PREFERRED = '0422'; // Solaris Base
/** Fallback for any device not in the lists above: a name containing this is a
 *  throttle, anything else is a stick. */
const GP_THROTTLE_ID = 'throttle';
const GP_AXIS_ROLL = 0;    // stick device: left/right → roll  (like A/D)
const GP_AXIS_PITCH = 1;   // stick device: fwd/back   → pitch (like W/S)
const GP_AXIS_THR_A = 2;   // throttle device: lever A ┐ linked pair, averaged
const GP_AXIS_THR_B = 5;   // throttle device: lever B ┘ +1 → idle, −1 → full power
const GP_DEADZONE = 0.06;  // ignore tiny stick noise near centre
const GP_INVERT_ROLL = false;
const GP_INVERT_PITCH = false;

/**
 * THE COURSE — one fixed start point, and the direction the aircraft is
 * launched in. `start`/`end` are the centerline's endpoints (`alt` = metres
 * above sea level); the aircraft spawns SPAWN_BACK metres behind `start`,
 * aimed straight down the line towards `end`.
 *
 * The start is the given coordinate on the HERMON's western slopes, high
 * ground above the Hula valley. The line runs NORTH-WEST (bearing 315°) rather than due
 * north — deliberately: on the moving map the symbol is always nose-up, so a
 * course straight up the meridian would park the north marker permanently on
 * the aircraft's nose, where it says nothing. Off the meridian by 45°, north
 * sits out on the symbol's right and the marker reads as the instrument it is.
 * Changing `end` changes the launch heading: the aircraft is aimed straight
 * down the start → end line.
 */
interface GeoPoint { lat: number; lon: number; alt: number }
const COURSE = {
  name: 'Kiryat Shmona → Lake Qaraoun',
  /** The world is anchored here. Mercator scale changes with latitude, so the
   *  anchor sits on the course itself. */
  anchor: { lat: 33.207400, lon: 35.569500 },
  /** WHERE THE FLIGHT BEGINS — what used to be 3A, north of Kiryat Shmona.
   *  The two legs that led up to it are gone, so this point is 1A now and
   *  everything after it has moved up two numbers. */
  start: { lat: 33.241736, lon: 35.584795, alt: 1000 } as GeoPoint,
  /** THE FAR END of the course, 45 km away on a bearing of 023.5°. It is what
   *  the aircraft launches towards and what every turn in ROUTE_PLAN is
   *  measured from, so swinging it swings the whole route: it was 017°, which
   *  ran the route down the WEST side of Lake Qaraoun, and the six and a half
   *  degrees added here carry the line over the water instead. */
  end: { lat: 33.612448, lon: 35.777523, alt: 1000 } as GeoPoint,
};

// -- DOM ---------------------------------------------------------------------

const canvas = document.getElementById('threetiles') as HTMLCanvasElement;
const loadingEl = document.getElementById('loading')!;
const crashEl = document.getElementById('crash')!;
const spdTapeEl = document.getElementById('spdTape') as HTMLCanvasElement;
const altTapeEl = document.getElementById('altTape') as HTMLCanvasElement;
const compassEl = document.getElementById('compass') as HTMLCanvasElement;
const compassCtx = compassEl.getContext('2d')!;
const popEl = document.getElementById('pop')!;
const attitudeEl = document.getElementById('attitude') as HTMLCanvasElement;
const attitudeCtx = attitudeEl.getContext('2d')!;
const loginEl = document.getElementById('login')!;
const loginForm = document.getElementById('loginForm') as HTMLFormElement;
const startBtn = loginForm.querySelector('button[type="submit"]') as HTMLButtonElement;
const loginErr = document.getElementById('loginErr')!;
const fullNameEl = document.getElementById('fullName') as HTMLInputElement;
const subjectIdEl = document.getElementById('subjectId') as HTMLInputElement;

// -- renderer / scene --------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(SKY);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 1, 400_000);

/**
 * ══ THE BELLY CAMERA ════════════════════════════════════════════════════════
 *
 * A second camera, bolted under the aircraft and looking CAM_PITCH degrees
 * below the nose. It sees the same world through the same engine — there is
 * only one set of terrain tiles, and this costs one more pass over it — and
 * its picture is sent to the map window, which draws it in the camera pane.
 *
 * The frame is taken by rendering this view into a corner of the simulator's
 * own canvas, copying that corner away, and then drawing the pilot's view over
 * the top. Both happen inside one animation frame, so nothing of it is ever
 * seen on the simulator's screen.
 *
 * IT IS ON A STABILISER. The camera follows the aircraft's heading and holds
 * everything else steady: it looks CAM_PITCH_DEG below the HORIZON, not below
 * the nose, and its own horizon stays level however the aircraft banks or
 * pitches. Set CAM_STABILISED to false and it is bolted to the airframe
 * instead, rolling and pitching with it.
 */
const CAM_ON = true;
const CAM_STABILISED = true; // false = bolted to the airframe
/**
 * ── POINTING IT, AND ZOOMING IT ────────────────────────────────────────────
 *
 * These two together are the zoom, and the first matters more than the second.
 *
 * CAM_PITCH_DEG is how far BELOW THE HORIZON it looks, and that is what sets
 * how far away the ground it is looking at actually is. From 6,000 ft:
 *
 *      3°  →  the ground 35 km off        20°  →  5.3 km off
 *     10°  →  10.5 km off                 45°  →  2.6 km off
 *
 * Nothing 35 km away can be made clear by any lens, which is why a narrow
 * view at a shallow angle reads as "smaller picture" rather than "closer".
 *
 * CAM_FOV_DEG is the lens: how wide a slice of that it takes in. Halving it
 * doubles the size of everything in the picture.
 *
 * CAM_PX is how many pixels the picture is drawn with. The pane it ends up in
 * is 570 of them wide in the five-way arrangement and 1,140 in the half-way
 * one, so anything under that is being stretched, and a zoomed-in picture
 * shows that stretching plainly. It costs a little to raise.
 *
 * The launcher is about 25 m long. These settings put it at roughly a
 * thirtieth of the picture's width from 5 km off — small, but plainly a
 * vehicle, which is what a sensor at that range would give you.
 */
const CAM_PITCH_DEG = 1;    // how far below the horizon it looks
const CAM_FOV_DEG = 10;       // how wide it sees
const CAM_PX = 768;          // the picture's size, square, in CSS px
/** How many DEVICE pixels are left behind on every edge when the picture is
 *  taken off the canvas — see sendCamFrame. Two is enough for any screen
 *  ratio; nothing but the camera's own pixels can get in past it. */
const CAM_EDGE_TRIM = 2;
const CAM_FPS = 15;          // frames a second sent to the map

/**
 * ── STEERING IT FROM THE THROTTLE ──────────────────────────────────────────
 *
 * Six buttons on the throttle work the camera. Four of them swing it about
 * while they are held — up towards the horizon and down past straight-down,
 * and round to either side — and letting go leaves it where it was pointed,
 * which is how a real sensor behaves. The other two are presses:
 *
 *   b2  camera UP            b6  SLAVE: hold the mark picked out on the map
 *   b4  camera DOWN          b7  RESET: back to resting, and let any mark go
 *   b3  camera RIGHT
 *   b5  camera LEFT
 *
 * b6 does exactly what the Slave key on the map's own panel does, and the
 * key on the panel still works: either hand can do it.
 *
 * The numbers below are the button numbers the THROTTLE ITSELF carries — b2
 * is 2 here, and so on. (The login screen logs every button pressed with the
 * number the browser reports, so a throttle that counts differently can be
 * matched to it in a moment.)
 *
 * Should a pair ever feel the wrong way round on another aircraft or another
 * throttle, the two switches below turn that pair over without touching
 * anything else.
 */
const CAM_BTN_UP = 2;        // b2 — towards the horizon and above it
const CAM_BTN_RIGHT = 3;     // b3
const CAM_BTN_DOWN = 4;      // b4 — further down, and on behind
const CAM_BTN_LEFT = 5;      // b5
const CAM_BTN_SLAVE = 6;     // b6 — the Slave key, under the thumb
const CAM_BTN_CENTRE = [7];  // b7 — back to where it rests
const CAM_PAN_INVERT_SIDE = false;
const CAM_PAN_INVERT_DOWN = false;
const CAM_PAN_RATE = 45;     // degrees a second while a button is held
const CAM_DOWN_MIN = -5;     // it may look this far ABOVE the horizon…
const CAM_DOWN_MAX = 150;    // …and this far past it, which is behind
const CAM_SIDE_MAX = 180;    // how far round to each side

/** Where it is pointed now, as a turn away from where it rests. */
let camPanDown = 0;
let camPanSide = 0;

/** b6 is a PRESS, not a hold: it must not fire again while it is held down. */
let slaveKeyWasDown = false;

/** Called every frame: the buttons swing the camera while they are held. */
function panCamera(dt: number): void {
  const { throttle } = warthogPads();
  if (!throttle) return;
  const held = (i: number) => !!throttle.buttons[i]?.pressed;

  // b6: the Slave key. The map is the screen that knows which mark is picked
  // out, so the press is handed over to it and the map answers by saying
  // which spot to hold — the same path the key on its own panel takes.
  const slaveNow = held(CAM_BTN_SLAVE);
  if (slaveNow && !slaveKeyWasDown) {
    mapChannel.postMessage({ kind: 'camkey', what: 'slave' } satisfies CamKeyOrder);
  }
  slaveKeyWasDown = slaveNow;

  // b7: straight back to where the camera rests — pointing, lens and mark.
  if (CAM_BTN_CENTRE.some(held)) {
    camPanDown = 0;
    camPanSide = 0;
    camFov = CAM_FOV_DEG;
    setSlave(null);
    mapChannel.postMessage({ kind: 'camkey', what: 'reset' } satisfies CamKeyOrder);
    return;
  }
  // A hand on the pan buttons takes the camera back off whatever mark the map
  // had given it to hold.
  if ([CAM_BTN_DOWN, CAM_BTN_UP, CAM_BTN_RIGHT, CAM_BTN_LEFT].some(held)) setSlave(null);
  const step = CAM_PAN_RATE * dt;
  const down = CAM_PAN_INVERT_DOWN ? -step : step;
  const side = CAM_PAN_INVERT_SIDE ? -step : step;
  if (held(CAM_BTN_DOWN)) camPanDown += down;
  if (held(CAM_BTN_UP)) camPanDown -= down;
  if (held(CAM_BTN_RIGHT)) camPanSide += side;
  if (held(CAM_BTN_LEFT)) camPanSide -= side;
  camPanDown = Math.min(CAM_DOWN_MAX - CAM_PITCH_DEG,
    Math.max(CAM_DOWN_MIN - CAM_PITCH_DEG, camPanDown));
  camPanSide = Math.min(CAM_SIDE_MAX, Math.max(-CAM_SIDE_MAX, camPanSide));
}

/**
 * ── ZOOMING IT ─────────────────────────────────────────────────────────────
 *
 * b8 zooms in and b9 zooms out, and they are the ONLY thing that zooms. The
 * lens starts at CAM_FOV_DEG and holding a button narrows or widens it, and
 * that holds whatever else the camera is doing: slaving a mark swings the
 * camera onto it and nothing more — whoever is on the throttle decides
 * whether to go in closer. b7 puts the lens back to where it started along
 * with everything else.
 *
 * The lens is kept between CAM_FOV_MIN and CAM_FOV_MAX, so it can neither
 * narrow to nothing nor open past what the eye would accept.
 */
const CAM_ZOOM_BTN_IN = 8;        // b8
const CAM_ZOOM_BTN_OUT = 9;       // b9
const CAM_ZOOM_RATE = 2.2;        // times in or out a second, held down
const CAM_FOV_MIN = 0.4;          // the tightest the lens may go
const CAM_FOV_MAX = 60;           // and the widest

/** The lens, wherever the zoom buttons have left it. */
let camFov = CAM_FOV_DEG;

/**
 * ── THE TRIGGER ────────────────────────────────────────────────────────────
 *
 * The red trigger on the STICK has two stages, and the stick reports them as
 * two buttons: the first pull is b0, pulling it home is b5. EITHER OF THEM
 * lets the weapon go — the first pull is enough, and pulling on through to
 * the second does not send a second one, since the weapon has already gone
 * and the trigger must come all the way back before it will fire again.
 * (WEAPON_FIRE_ON_HALF false waits for the full pull instead.)
 *
 * What happens then is not flown — there is no weapon in the world. Two
 * things happen instead, and they are counted HERE, in the simulator, so
 * that the world and the picture of it can never disagree:
 *
 *   · the map is told at once that the trigger has gone, and takes the store
 *     that was chosen off the weapons screen;
 *   · WEAPON_FLIGHT_S later the weapon lands: the truck is burnt where it
 *     stands, fire breaks over it for a few seconds, and smoke goes up off
 *     it from then on. See THE WRECK further down.
 *
 * WHERE THE BURST IS SEEN. EVERYWHERE — because it is not a picture laid
 * over a screen but FIRE IN THE WORLD, standing on the truck itself. The
 * camera under the aircraft sees it, the pilot sees it through the window,
 * it is hidden by a rise in the ground as anything else would be, and it
 * grows as you close in because it is a thing of a size in metres and not a
 * share of a frame.
 */
const WEAPON_BTN_HALF = 0;        // b0 — the first pull
const WEAPON_BTN_FULL = 5;        // b5 — pulled home
const WEAPON_FIRE_ON_HALF = true;
/** Other buttons on the STICK that fire exactly as the trigger does. */
const WEAPON_BTN_ALSO = [1];      // b1

/** Seconds from the trigger to the strike. */
const WEAPON_FLIGHT_S = 10;

/** THE TRIGGER WITHOUT THE STICK. Pressing F does exactly what the red
 *  trigger does, so the whole chain can be tried from the keyboard on a
 *  machine with no joystick plugged in. Set it to '' to turn it off. */
const WEAPON_KEY = 'KeyF';

let triggerWasDown = false;
/** Set once the weapon lands, and never unset while the flight runs. */
let modelStruck = false;
let strikeTimer = 0;

/** The marks the map is to take off, by id — see TARGETS. */
const struckMarks = new Set<string>();

/**
 * THE WEAPON HAS LANDED.
 *
 * The truck is NOT taken out of the world — it stays exactly where it is,
 * the same size, and is burnt where it stands. Fire breaks over it at once
 * and smoke begins to go up; the badge on its roof goes, since the thing is
 * no longer a target; and the map is told to take its mark off.
 */
function strikeTheModel(): void {
  modelStruck = true;
  for (const t of TARGETS) if (t.kind === 'truck' && t.strike !== false) struckMarks.add(t.file);
  if (!wrecked) burnTheModel();
  else if (FIRE_ON) lightTheFire();        // struck again: fire, and nothing else
}

/** Called every frame: watch the trigger and say the word when it goes. */
function watchTrigger(): void {
  const { stick } = warthogPads();
  if (!stick) return;
  const held = (i: number) => !!stick.buttons[i]?.pressed;
  const half = held(WEAPON_BTN_HALF);
  const full = held(WEAPON_BTN_FULL);
  // Held at all, by either stage, is the trigger down. Taking it as one
  // thing is what keeps a pull that carries on from the first stage to the
  // second from counting twice.
  const down = (WEAPON_FIRE_ON_HALF ? (half || full) : full)
    || WEAPON_BTN_ALSO.some(held);
  if (down && !triggerWasDown) pullTrigger();
  triggerWasDown = down;
}

/**
 * The trigger has gone, whichever way it was pulled.
 *
 * A TRUCK THAT HAS ALREADY BEEN STRUCK CAN BE STRUCK AGAIN. It is a wreck
 * and it stays one — nothing is undone and it is not darkened twice — but the
 * fire breaks over it afresh and the smoke goes on, so a second release is
 * seen on the camera exactly as the first was.
 */
function pullTrigger(): void {
  mapChannel.postMessage({ kind: 'fire' } satisfies FireOrder);
  window.clearTimeout(strikeTimer);
  strikeTimer = window.setTimeout(strikeTheModel, WEAPON_FLIGHT_S * 1000);
}


/** Called every frame: b8 and b9 work the zoom while they are held. */
function zoomCamera(dt: number): void {
  const { throttle } = warthogPads();
  if (!throttle) return;
  const held = (i: number) => !!throttle.buttons[i]?.pressed;
  const inn = held(CAM_ZOOM_BTN_IN);
  const out = held(CAM_ZOOM_BTN_OUT);
  if (inn === out) return;                   // neither, or both: leave it be
  const k = CAM_ZOOM_RATE ** dt;             // smooth however fast the frames
  if (inn) camFov /= k; else camFov *= k;
  camFov = Math.min(CAM_FOV_MAX, Math.max(CAM_FOV_MIN, camFov));
}

/** The lens this frame: wherever the zoom buttons have left it, slaved or not. */
function camFovNow(): number {
  return Math.min(CAM_FOV_MAX, Math.max(CAM_FOV_MIN, camFov));
}

const camCamera = new THREE.PerspectiveCamera(CAM_FOV_DEG, 1, 1, 400_000);
const camCapture = document.createElement('canvas');
camCapture.width = CAM_PX;
camCapture.height = CAM_PX;
const camCaptureCtx = camCapture.getContext('2d');
let camSentAt = 0;
let camUseBitmap = true;     // dropped to a data URL if the browser refuses
const _camQuat = new THREE.Quaternion();
const _camTilt = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), (-CAM_PITCH_DEG * Math.PI) / 180);
const _camFwd = new THREE.Vector3();
const _camSwing = new THREE.Quaternion();
const _camRight = new THREE.Vector3(1, 0, 0);
const _camLook = new THREE.Vector3();
const _camUp = new THREE.Vector3(0, 1, 0);

/**
 * ── SLAVED TO A MARK ───────────────────────────────────────────────────────
 *
 * The map can hand the camera a place on the ground to hold: press a mark on
 * the map to pick it out, then press Slave — on the panel under it, or b6 on
 * the throttle — and the camera looks at that spot and keeps looking at it
 * however the aircraft turns; the pitch and the pan are set aside while it
 * does, and the lens stays where it was. Pressing Slave again lets it go, and
 * so does touching the pan buttons: the hand on the throttle always wins.
 */
let slavedTo: { lat: number; lon: number } | null = null;
const _slaveAt = new THREE.Vector3();

function setSlave(to: { lat: number; lon: number } | null): void {
  slavedTo = to;
}

/** Put the lens where it is wanted, and only tell the camera when it has
 *  actually moved — rebuilding the projection every frame is waste. */
function setCamFov(deg: number): void {
  if (Math.abs(camCamera.fov - deg) < 1e-3) return;
  camCamera.fov = deg;
  camCamera.updateProjectionMatrix();
}

/** Where the camera is pointed this frame — steady, bolted on, or held on a
 *  mark the map has given it. */
function aimCamCamera(): void {
  camCamera.position.copy(camera.position);
  if (slavedTo) {
    // Hold the spot: its place on the ground, lifted to the ground's own
    // height where that is known, and the horizon kept level in the picture.
    _slaveAt.copy(worldPoint(world, slavedTo.lat, slavedTo.lon, 0))
      .add(terrain.anchor.worldOffset);
    const ground = terrain.groundHeight(_slaveAt);
    if (ground !== undefined) _slaveAt.y = ground;
    camCamera.up.copy(_camUp);
    camCamera.lookAt(_slaveAt);
    // The LENS IS LEFT ALONE: slaving swings the camera onto the mark and
    // does nothing else, so whoever is on the throttle decides whether to
    // go in closer.
    setCamFov(camFovNow());
    camCamera.updateMatrixWorld();
    return;
  }
  setCamFov(camFovNow());
  const tilt = ((CAM_PITCH_DEG + camPanDown) * Math.PI) / 180;
  const swing = (camPanSide * Math.PI) / 180;
  if (!CAM_STABILISED) {
    // Bolted on: the swing and the tilt are turns of the airframe's own pose.
    camCamera.quaternion.copy(camera.quaternion)
      .multiply(_camSwing.setFromAxisAngle(_camUp, -swing))
      .multiply(_camQuat.setFromAxisAngle(_camRight, -tilt));
    camCamera.updateMatrixWorld();
    return;
  }
  // The stabiliser: take the way the aircraft is FACING, flatten it to the
  // ground so its climb and its bank fall away, tip that CAM_PITCH_DEG below
  // the horizon, and look along it with up kept up — which is what leaves the
  // horizon level in the picture whatever the aircraft is doing.
  camera.getWorldDirection(_camFwd);
  _camFwd.y = 0;
  if (_camFwd.lengthSq() < 1e-8) _camFwd.set(0, 0, -1);   // pointing straight up or down
  _camFwd.normalize();
  if (swing) _camFwd.applyAxisAngle(_camUp, -swing);      // swung to the side
  _camLook.copy(_camFwd).multiplyScalar(Math.cos(tilt));
  _camLook.y -= Math.sin(tilt);
  _camLook.add(camera.position);
  camCamera.up.copy(_camUp);
  camCamera.lookAt(_camLook);
  camCamera.updateMatrixWorld();
}

/**
 * Take one frame and send it. Called from the render loop, BEFORE the pilot's
 * view is drawn: the belly view goes into the bottom-left corner of the canvas,
 * is copied out, and is then painted over by the main render.
 */
function sendCamFrame(now: number): void {
  if (!CAM_ON || !camCaptureCtx) return;
  if (now - camSentAt < 1000 / CAM_FPS) return;
  camSentAt = now;

  aimCamCamera();
  showHoops(false);
  sizeMark(camCamera, MARK_SCREEN_CAM);   // its own size in this picture

  // ── HOW BIG A SQUARE THERE IS ROOM FOR ────────────────────────────────
  //
  // The camera borrows the simulator's own canvas: it is drawn into a square
  // in the corner of it and copied out again. So the square can only be as
  // big as the canvas will hold — and the canvas is only as big as the
  // WINDOW. Ask for 768 in a window that is 700 tall and the square runs off
  // the top: the copy then takes rows the camera never drew, and they come
  // out as a pale band across the picture.
  //
  // So the square is whatever fits, and the picture sent on is always the
  // same size whatever that turns out to be — a small window costs detail,
  // never a band.
  const dpr = renderer.getPixelRatio();
  const buffer = renderer.domElement;
  const room = Math.floor(Math.min(buffer.width, buffer.height) / dpr);
  const box = Math.max(64, Math.min(CAM_PX, room));
  renderer.setViewport(0, 0, box, box);
  renderer.setScissor(0, 0, box, box);
  renderer.setScissorTest(true);
  renderer.render(scene, camCamera);
  showHoops(true);
  sizeMark(camera, MARK_SCREEN_SIM);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);

  // ── TAKING THE PICTURE OFF THE CANVAS, AND THE EDGE THAT MUST NOT COME
  // WITH IT ─────────────────────────────────────────────────────────────
  //
  // The camera is rendered into a square at the BOTTOM-LEFT of the window's
  // own canvas and then copied out of it. The GL viewport counts from the
  // bottom and a canvas counts from the top, so the square's top edge is
  // `canvas height − side` — and that is where it can go wrong: the canvas
  // is sized in whole DEVICE pixels while the viewport is given in CSS ones,
  // so on a screen whose ratio is not a round number the two disagree by up
  // to a pixel. Copy from exactly that line and the first row can come from
  // ABOVE the square, which is the simulator's own view: a bright line
  // straight across the top of the camera picture.
  //
  // So the copy is taken a couple of device pixels INSIDE the square on
  // every side and stretched back out. Two pixels of 768 is nothing to the
  // eye, and no rounding anywhere can reach past them — the picture can only
  // ever be made of pixels the camera actually drew.
  const side = Math.floor(box * dpr);
  const inset = Math.min(CAM_EDGE_TRIM, Math.floor(side / 8));
  const sy = Math.max(0, buffer.height - side) + inset;
  const span = Math.max(1, Math.min(side - inset * 2, buffer.height - sy, buffer.width - inset));
  camCaptureCtx.clearRect(0, 0, CAM_PX, CAM_PX);
  camCaptureCtx.drawImage(
    buffer, inset, sy, span, span,
    0, 0, CAM_PX, CAM_PX,
  );

  // The lens travels with the picture: the map puts on a quieter set of
  // markings once it is tight, whether the zoom came from the throttle or
  // from slaving the camera to a mark.
  const fov = camCamera.fov;
  if (camUseBitmap) {
    createImageBitmap(camCapture).then((image) => {
      try {
        mapChannel.postMessage({ kind: 'cam', image, fov, runId } satisfies CamFrame);
      } catch {
        camUseBitmap = false;   // this browser will not carry a picture; send text
      }
    }).catch(() => { camUseBitmap = false; });
  } else {
    mapChannel.postMessage({
      kind: 'cam', image: camCapture.toDataURL('image/jpeg', 0.6), fov, runId,
    } satisfies CamFrame);
  }
}

/** World config for the course: anchored on its own point, with extra detail. */
function worldFor(): WorldConfig {
  const w = worldFromLatLon(COURSE.anchor.lat, COURSE.anchor.lon);
  w.skirtOverlap = new Array(ZOOM_LEVELS).fill(1.01);
  w.maxZoom = 17; // extra imagery/height detail over the course
  return w;
}

function makeTerrain(w: WorldConfig): Terrain {
  return new Terrain(
    camera,
    {
      world: w,
      rendering: {
        fogColor: SKY,
        ambient: new THREE.Color().setRGB(150 / 255, 150 / 255, 150 / 255, THREE.SRGBColorSpace),
        sunScale: 0.35,
      },
      network: { concurrency: 8 },
    },
    scene,
  );
}

// One course, one anchor: the world is never re-anchored while flying.
const world = worldFor();
const terrain = makeTerrain(world);

/**
 * Absolute (rebase-independent) world position of a geographic coordinate,
 * in the same frame as the terrain's baked tile centers. Mercator tile math
 * mirrors {@link worldFromLatLon}; the anchor's `tileSize` is uniform in
 * tile-space, so this is accurate across the course.
 */
function worldPoint(w: WorldConfig, lat: number, lon: number, alt: number): THREE.Vector3 {
  const n = 2 ** w.baseZoom;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return new THREE.Vector3((x - w.anchorX) * w.tileSize, alt, (y - w.anchorZ) * w.tileSize);
}

/**
 * The inverse of {@link worldPoint}: the geographic coordinate of an ABSOLUTE
 * world position (user-space minus the large-world offset). This is what the
 * moving map is fed — the simulator flies in metres, the map draws in degrees.
 */
function latLonFromWorld(w: WorldConfig, v: THREE.Vector3): { lat: number; lon: number } {
  const n = 2 ** w.baseZoom;
  const x = v.x / w.tileSize + w.anchorX;
  const y = v.z / w.tileSize + w.anchorZ;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lon: (x / n) * 360 - 180 };
}

// -- fuel ---------------------------------------------------------------------
/**
 * FUEL, for the readout on the moving map's bottom panel. There is no fuel
 * system in the flight model — this is a clock dressed as a gauge: it starts
 * full and drops one step every so often, so the number on the panel moves the
 * way a real one would while there is nothing yet to burn it.
 * Change the three numbers and the readout changes with them.
 */
const FUEL_START_LB = 13_900;
const FUEL_STEP_LB = 100;
const FUEL_STEP_SECONDS = 10;
/** When the current run began — the fuel clock's zero. */
let fuelStartedAt = performance.now();

function fuelLb(): number {
  const seconds = (performance.now() - fuelStartedAt) / 1000;
  const burnt = FUEL_STEP_LB * Math.floor(seconds / FUEL_STEP_SECONDS);
  return Math.max(0, FUEL_START_LB - burnt);
}

// -- the moving map (second screen) ------------------------------------------

/** How often (s) a position is broadcast. 20 Hz is smooth on the map and far
 *  cheaper than sending one per rendered frame. */
const MAP_FIX_INTERVAL = 1 / 20;
const mapChannel = new BroadcastChannel(MAP_CHANNEL);
// The one thing the map sends BACK: the spot the belly camera is to hold, or
// null to let it go. Everything else on this channel runs the other way.
mapChannel.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as SlaveOrder | PauseOrder | ResetOrder;
  if (!m) return;
  if (m.kind === 'slave') setSlave((m as SlaveOrder).at ?? null);
  else if (m.kind === 'pause') setPaused((m as PauseOrder).on, false);
  else if (m.kind === 'reset') startAgain();
});

/**
 * ══ HOLD ════════════════════════════════════════════════════════════════════
 *
 * Esc here, or the clock on the map's top panel, and the flight stops where
 * it is: the aircraft hangs, the physics is not stepped, the fuel stops
 * burning. Esc again and it goes on from exactly there.
 *
 * NOTHING IS WOUND BACK. The clocks that run on the wall — the fuel's, and
 * the threats' on the map — are not stopped but SHIFTED: when the hold ends,
 * however long it lasted is added to where each of them started, so they
 * carry on where they were rather than jumping forward by the length of the
 * hold.
 */
let paused = false;
let heldAt = 0;

function setPaused(on: boolean, tell = true): void {
  if (on === paused) return;
  paused = on;
  if (on) {
    heldAt = performance.now();
  } else {
    const held = performance.now() - heldAt;
    fuelStartedAt += held;                  // the fuel did not burn while held
  }
  if (tell) mapChannel.postMessage({ kind: 'pause', on } satisfies PauseOrder);
}
let mapFixTimer = 0;
/** Counts fixes, so the flown path rides along on every TRAIL_EVERY-th one. */
let mapFixCount = 0;
/** Bumped on every respawn, so the map knows to drop the old track. */
let runId = 0;
const _mapAbs = new THREE.Vector3();

/** Send the aircraft's position and heading to the map, with the route and the
 *  track in degrees. The route is the same list of points every time: it is
 *  fixed in the world, and the map simply draws it where it is. */
function sendMapFix(): void {
  _mapAbs.copy(camera.position).sub(terrain.anchor.worldOffset);
  const { lat, lon } = latLonFromWorld(world, _mapAbs);
  const fix: MapFix = {
    lat,
    lon,
    headingDeg: currentHeading(),
    altFt: camera.position.y * 3.28084,
    speedKt: flight.speed * 1.94384,
    fuelLb: fuelLb(),
    crashed: flight.crashed,
    runId,
    route: ROUTE_WAYPOINTS.map((w, i) => (i + 1 === HOOP_TALL_AT
      ? { lat: w.lat, lon: w.lon, name: HOOP_TALL_NAME }
      : { lat: w.lat, lon: w.lon })),
    leadIn: routeLeadIn(),
    targets: targetMarks(),
    struck: [...struckMarks],
    areas: areaMarks(),
    cues: cueMarks(),
  };
  if (mapFixCount++ % TRAIL_EVERY === 0) fix.trail = trail.map((p) => latLonFromWorld(world, p));
  mapChannel.postMessage(fix);
}

// -- the route, and the track flown -------------------------------------------
/**
 * THE ROUTE is a line fixed in the world: the way the aircraft is MEANT to fly,
 * from the course's start to its end. It does not follow the aircraft and it
 * does not care whether the aircraft is on it — fly off and the route stays
 * exactly where it was, which is the whole point of having one.
 *
 * It is worked out once, at start-up, and sent to the moving map; nothing is
 * drawn over the terrain in the cockpit view. Giving it a shape other than the
 * straight line between the two course points is a matter of replacing what
 * `buildRoute` pushes — everything downstream only ever sees a list of points.
 *
 * THE TRACK is the other line: where the aircraft has actually been.
 */
/** Where the aircraft is meant to go (the route's own colour). */
const PATH_COLOR_AHEAD = 0x40a0ff;
/** Where it has already been. */
const PATH_COLOR_FLOWN = 0x5a899a;
/** How often (times a second) the track is extended. */
const PATH_UPDATE_HZ = 10;
/** A flown point is kept every this many metres, up to this many points. */
const TRAIL_STEP = 60;
const TRAIL_MAX = 600;

/** The track flown so far, in ABSOLUTE world positions (newest last). */
const trail: THREE.Vector3[] = [];
let pathTimer = 0;

/**
 * ══ THE ROUTE PLAN ══════════════════════════════════════════════════════════
 *
 * THE LIST BELOW, ROUTE_PLAN, IS THE ROUTE. The map joins its points with
 * straight legs, rings each one and numbers them 1A, 2A, 3A… in the order
 * written. Nothing is smoothed or sampled in between, so what is written here
 * is exactly what is drawn.
 *
 * 1A is always COURSE.start — where the aircraft begins. Every line after it
 * adds ONE more waypoint, and there are two ways to write a line.
 *
 * ── A. BY FLYING ON: how far, and how much to turn first ──────────────
 *
 *     { turn: -12, run: 700 },
 *
 *   `turn`  how many DEGREES the line breaks at the waypoint BEFORE this
 *           one, before setting off towards this one.
 *             negative → LEFT        positive → RIGHT        0 → straight on
 *           Small numbers are gentle: 5 is barely a kink, 12 a clear break,
 *           45 a sharp corner, 90 a right-angle turn.
 *   `run`   how many METRES this leg runs: the distance from the previous
 *           waypoint to this one. 700 is 700 m, 2_200 is 2.2 km (the
 *           underscore is only there to be read easily — 2200 is the same).
 *   `alt`   OPTIONAL, metres above sea level. Left out, the waypoint keeps
 *           the height of the one before it.
 *
 *   The first line of the plan turns from the LAUNCH HEADING, the direction
 *   the aircraft is pointing when the flight begins, so `turn: 0` there means
 *   "carry straight on the way it is already flying".
 *
 * ── B. BY COORDINATE: a place on the map ──────────────────────────────
 *
 *     { at: { lat: 33.337951, lon: 35.676042, alt: 1900 } },
 *
 *   The pair Google Maps gives when you right-click a place and click the
 *   coordinates to copy them. The line simply goes there, however far and at
 *   whatever angle that is, and the next leg's `turn` is then measured from
 *   the direction of arrival.
 *
 * The two kinds can be mixed freely in one plan.
 *
 * ── TO ADD A WAYPOINT ─────────────────────────────────────────────────
 *
 * Write one more line, in the place in the list where it belongs. Everything
 * after it follows on automatically — the numbering, the colours, the rings
 * — because the plan is read in order and nothing is written down twice.
 * Delete a line and the route closes up the same way.
 *
 * The LAST line is the far end of the route; today it is a long straight run
 * so the line leaves the screen, which is why its `run` is 50 km.
 */
const ROUTE_PLAN: RouteStep[] = [
  // 1A is the course's own start; this first leg is the one that used to run
  // from 3A to 4A, and it sets off straight down the launch line.
  { turn: 0, run: 6_500 },          // 2A
  { turn: -20, run: 8_000 },        // 3A — the first set of rings lights here
  { turn: +19, run: 3_200 },        // 4A
  // The little 700 m leg that used to stand after 4A is gone, and the number
  // it carried with it: this one leg now does the work of the two.
  { turn: -4.9, run: 1_691 },       // 5A

  // FROM HERE UP THE WEST SIDE. The tail is written as places rather than as
  // turns, because what matters about it is where it lies on the ground: it
  // passes WEST of Lake Qaraoun, and AAT stands about 1.2 km clear of the
  // water's western shore — two kilometres from the launcher.
  { at: { lat: 33.4530, lon: 35.6500, alt: 1_000 } },   //  6A
  // 7A is the break: the line comes up to it on 015° and leaves on 357°, an
  // eighteen-degree swing to the WEST — it now leans a little west of north
  // rather than east of it. 8A, AAT and 10A all stand on that one straight
  // line, so the whole stretch past the lake has moved west with it.
  { at: { lat: 33.4850, lon: 35.6600, alt: 1_000 } },   //  7A — breaks west
  { at: { lat: 33.5164, lon: 35.6580, alt: 1_000 } },   //  8A — straight on
  { at: { lat: 33.5559, lon: 35.6555, alt: 1_000 } },   //  9A — AAT: 2.6 km west
                                            //       of the lake, and the high one
  { at: { lat: 33.5963, lon: 35.6530, alt: 1_000 } },   // 10A
  // …and from here the line leans back to the right for the last two.
  { at: { lat: 33.6273, lon: 35.6596, alt: 1_000 } },   // 11A
  { at: { lat: 33.6663, lon: 35.6721, alt: 1_000 } },   // 12A
];

/** One line of the plan: a leg to fly, or a place to go to. */
type RouteStep =
  | { turn?: number; run: number; alt?: number }
  | { at: GeoPoint };

/** The bearing of the launch line, degrees — the way the aircraft starts off. */
function courseBearing(): number {
  const kx = Math.cos((COURSE.start.lat * Math.PI) / 180);
  return (Math.atan2((COURSE.end.lon - COURSE.start.lon) * kx,
    COURSE.end.lat - COURSE.start.lat) * 180) / Math.PI;
}

/** The point `metres` from `from` on `bearingDeg`, at the same altitude. */
function legFrom(from: GeoPoint, bearingDeg: number, metres: number): GeoPoint {
  const rad = (bearingDeg * Math.PI) / 180;
  const kx = Math.cos((from.lat * Math.PI) / 180);   // lon degrees are shorter up here
  return {
    lat: from.lat + (metres * Math.cos(rad)) / 111_320,
    lon: from.lon + (metres * Math.sin(rad)) / 111_320 / kx,
    alt: from.alt,
  };
}

/** The bearing from one point to another, degrees. */
function bearingBetween(from: GeoPoint, to: GeoPoint): number {
  const kx = Math.cos((from.lat * Math.PI) / 180);
  return (Math.atan2((to.lon - from.lon) * kx, to.lat - from.lat) * 180) / Math.PI;
}

/** Read the plan in order and hand back the waypoints it describes. */
function buildRoute(start: GeoPoint, plan: RouteStep[]): GeoPoint[] {
  const out = [start];
  let bearing = courseBearing();       // the way the aircraft sets off
  for (const step of plan) {
    const from = out[out.length - 1];
    if ('at' in step) {
      bearing = bearingBetween(from, step.at);   // the next turn is measured from here
      out.push(step.at);
    } else {
      bearing += step.turn ?? 0;
      const next = legFrom(from, bearing, step.run);
      out.push(step.alt === undefined ? next : { ...next, alt: step.alt });
    }
  }
  return out;
}

/** The route itself: 1A, 2A, 3A… exactly as the plan above describes them. */
const ROUTE_WAYPOINTS: GeoPoint[] = buildRoute(COURSE.start, ROUTE_PLAN);
/**
 * ══ THE HOOPS ON THE ROUTE ══════════════════════════════════════════════════
 *
 * In the SIMULATOR — not on the map — every waypoint of the route is marked in
 * the air by a white hoop with a white dot at its middle, so the way ahead can
 * be seen out of the window the way it is seen on the map.
 *
 * They are real things standing in the world, not marks drawn on the glass, so
 * nothing has to be done to make the far ones small: the one being flown at
 * grows as it is approached and the ones beyond it stay small, by perspective
 * alone. How high each one hangs is HOOP_ALT_FT, and HOOP_FROM_GROUND says
 * what that is measured from: sea level, which keeps them all in one flat
 * plane, or the ground beneath each one, which makes them follow the hills.
 *
 * Each hoop turns to face the aircraft every frame, so it always reads as a
 * circle rather than closing up to a line when passed to one side.
 */
const HOOPS_ON = true;            // false and there are no hoops at all
// HOW HIGH EACH ONE HANGS, in feet, and what that height is measured from:
//   false — above SEA LEVEL, the same height for every hoop, so they stand in
//           one flat plane however the ground rises and falls under them;
//   true  — above THE GROUND BENEATH IT, so each follows its own hill.
// Above the ground, so each hoop keeps the same height over whatever hill it
// stands on. (Measured along this route, the ground under the waypoints runs
// from 72 m at the start to 1,108 m at the last; a fixed height above the SEA
// would have to clear all of that, which is why it is taken from the ground.)
const HOOP_FROM_GROUND = true;
const HOOP_ALT_FT = 500;          // 500 ft is 152 m
/**
 * ONE HOOP STANDING HIGH. The waypoint named here — 9 is AAT, the one west of
 * the lake — is hung at HOOP_TALL_FT instead of the height every other hoop
 * has, and it alone. 0 on HOOP_TALL_AT puts them all back to one height.
 */
const HOOP_TALL_AT = 9;
const HOOP_TALL_FT = 10_000;
/** Its own colour in the simulator, and its own name on the map — it is not
 *  numbered with the others. */
const HOOP_TALL_COLOUR = 0xff5fdc;
const HOOP_TALL_NAME = 'AAT';
const HOOP_DIAMETER_M = 60;       // the hoop's width in the world, in metres
const HOOP_THICKNESS_M = 2.5;     // how heavy its line is drawn
const HOOP_DOT_M = 6;             // the dot at its middle, across
const HOOP_COLOUR = 0xffffff;
/**
 * HOW STRONGLY EACH ONE IS DRAWN, by how far off it is. The one being flown at
 * stands out and the ones beyond it sit back, so the near and the far are told
 * apart at a glance rather than all shouting at once.
 *
 *   nearer than HOOP_NEAR_M   → HOOP_OPACITY_NEAR
 *   further than HOOP_FAR_M   → HOOP_OPACITY_FAR
 *   between the two           → somewhere in between, evenly
 *
 * Set the two opacities the same and every hoop is drawn alike, as before.
 */
const HOOP_OPACITY_NEAR = 0.95;
const HOOP_OPACITY_FAR = 0.3;
const HOOP_NEAR_M = 3_000;
const HOOP_FAR_M = 15_000;

/** One hoop: the ring and its dot, the place it stands in the world, and the
 *  skin that is its own — each is faded on its own, so each needs one. */
interface Hoop {
  group: THREE.Group;
  skin: THREE.MeshBasicMaterial;
  at: THREE.Vector3;
  grounded: boolean;
  tall: boolean;
}
const hoops: Hoop[] = [];

function buildHoops(): void {
  if (!HOOPS_ON) return;
  const paint = (colour: number) => new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,          // every hoop is faded by its own distance
    opacity: HOOP_OPACITY_NEAR,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const r = HOOP_DIAMETER_M / 2;
  const ring = new THREE.RingGeometry(r - HOOP_THICKNESS_M, r, 48);
  const dot = new THREE.CircleGeometry(HOOP_DOT_M / 2, 24);
  for (const w of ROUTE_WAYPOINTS) {
    const group = new THREE.Group();
    const tall = hoops.length + 1 === HOOP_TALL_AT;
    const skin = paint(tall ? HOOP_TALL_COLOUR : HOOP_COLOUR);
    group.add(new THREE.Mesh(ring, skin));
    group.add(new THREE.Mesh(dot, skin));
    scene.add(group);
    // The height is the ground's plus the hoop's own, and the ground is only
    // known once its tile is in; until then the hoop waits at the waypoint's
    // own height and is moved as soon as the terrain can answer.
    hoops.push({
      group,
      skin,
      at: worldPoint(world, w.lat, w.lon, w.alt ?? 0),
      grounded: false,
      tall,
    });
  }
}

/** Every frame: keep each hoop on its spot, at its height, facing the pilot. */
function updateHoops(): void {
  if (!hoops.length) return;
  const lift = HOOP_ALT_FT * 0.3048;
  for (const hoop of hoops) {
    const mine = hoop.tall ? HOOP_TALL_FT * 0.3048 : lift;
    hoop.group.position.copy(hoop.at).add(terrain.anchor.worldOffset);
    if (!HOOP_FROM_GROUND) {
      // Above sea level: the height is known straight away, and the ground
      // under it is never asked for.
      if (!hoop.grounded) {
        hoop.at.y = mine;
        hoop.group.position.y = mine + terrain.anchor.worldOffset.y;
        hoop.grounded = true;
      }
    } else {
      // Above the ground, which is asked for EVERY frame rather than once:
      // the first answer comes from whatever coarse tile happens to be in at
      // the time, and a hoop fifteen kilometres ahead would keep that rough
      // height for the whole flight. Asking again as the finer ground arrives
      // settles each one onto its own hill instead.
      const ground = terrain.groundHeight(hoop.group.position);
      if (ground !== undefined) {
        // `at` is absolute metres, so the offset comes back off again.
        hoop.at.y = ground - terrain.anchor.worldOffset.y + mine;
        hoop.group.position.y = ground + mine;
        hoop.grounded = true;
      }
    }
    hoop.group.quaternion.copy(camera.quaternion);   // always face the pilot

    // …and faded by how far off it is, so the one being flown at reads as the
    // near one and the rest sit back behind it.
    const d = camera.position.distanceTo(hoop.group.position);
    const span = Math.max(1, HOOP_FAR_M - HOOP_NEAR_M);
    const t = Math.min(1, Math.max(0, (d - HOOP_NEAR_M) / span));
    hoop.skin.opacity = HOOP_OPACITY_NEAR + (HOOP_OPACITY_FAR - HOOP_OPACITY_NEAR) * t;
  }
}

/**
 * ══ THE MODEL ON THE GROUND ═════════════════════════════════════════════════
 *
 * A thing built in three dimensions — 3D.glb — standing at a place of its own
 * on the earth. It is part of the world, not a mark on the screen: the camera
 * under the aircraft sees it as readily as the pilot does, and flying round it
 * shows its other side.
 *
 * WHERE IT STANDS is MODEL_AT, in degrees. It is set DOWN ON THE GROUND: the
 * model is measured once it has loaded and then lifted by however much of it
 * lies below its own middle, so its foot rests on the earth rather than its
 * middle. MODEL_LIFT_M raises or sinks it from there.
 *
 * HOW BIG it is comes from the file — as it is drawn there, about fifteen
 * metres across — and MODEL_SCALE multiplies that: 2 is twice the size, 0.5
 * half. MODEL_TURN_DEG turns it on the spot, clockwise from however the file
 * has it facing.
 */
const MODEL_ON = true;
const MODEL_FILE = './icons/3D.glb';
// Moved 345 m south of the point first given, which fell on the water: this
// one is open ground above the lake's west shore, by the track that runs
// along it.
const MODEL_AT = { lat: 33.575607871933855, lon: 35.70688745379074 };
const MODEL_SCALE = 5;            // 1 is the size the file is drawn at
const MODEL_TURN_DEG = 0;
const MODEL_LIFT_M = 1.5;         // plus lifts it off the ground, minus sinks it
/**
 * THE LIGHT ON IT. The ground is drawn by a shader of its own that needs no
 * light at all, so until now the scene had none — and a model built with real
 * materials came out as a black silhouette. These two give it a sky to sit
 * under and a sun to catch: MODEL_SKY_LIGHT is the soft light from all round,
 * MODEL_SUN_LIGHT the hard light from one side, and MODEL_SUN_FROM the
 * direction that one comes from (degrees clockwise from north, and how high
 * it stands). They touch nothing but the model.
 */
const MODEL_SKY_LIGHT = 1.6;
const MODEL_SUN_LIGHT = 2.2;
const MODEL_SUN_FROM = { bearing: 140, height: 45 };
/**
 * THE BADGE OVER IT, Car Hozi.png.
 *
 * A sign on a stalk standing on the middle of the model's roof, so the thing
 * can be picked out from the air. It belongs to the PILOT'S EYE ONLY: it is
 * not on the moving map, and it is kept out of the belly camera's picture the
 * same way the hoops are.
 *
 * IT IS A MARK, NOT A THING. However far off the truck is, the badge is drawn
 * THE SAME SIZE: it does not shrink into the distance the way the truck does,
 * it only moves with it. Its size is given as a share of the picture's height
 * and separately for each picture it appears in —
 *
 *   MARK_SCREEN_SIM  in the simulator's own window
 *   MARK_SCREEN_CAM  in the picture the belly camera sends to the map
 *
 * so the two can be set to read well on their own terms, whatever happens to
 * the size of either window.
 *
 * It is NOT seen from the far side of the country: it comes up only once the
 * aircraft is within MARK_RANGE_M of it, over the last MARK_FADE_M of that.
 *
 * It stands on the middle of the roof and always faces the aircraft; it is
 * drawn over whatever lies in front of it, so a rise in the ground does not
 * swallow it.
 */
const MODEL_MARK = './icons/Car%20Hozi.png';
const MARK_SCREEN_SIM = 0.05;     // share of the simulator window's height
const MARK_SCREEN_CAM = 0.12;     // share of the camera picture's height
const MARK_RANGE_M = 10_000;      // first seen this far out
const MARK_FADE_M = 500;          // and comes up over this much of it
const MARK_LIFT_M = 0;            // extra air between the roof and its foot

/**
 * ══ THE WRECK: THE FIRE, AND THE SMOKE OFF IT ═══════════════════════════════
 *
 * WHAT IS SEEN, from the moment the weapon lands:
 *
 *   at once      the truck is BURNT WHERE IT STANDS. It is never taken out
 *                of the world and never put back: the very same model keeps
 *                the very same spot at the very same size, and only its
 *                materials are darkened, so it cannot drift or shrink. The
 *                badge on its roof goes, since it is no longer a target.
 *   at once      FIRE breaks over it — and over it is the word: the truck is
 *                still there to be seen under and through the flames.
 *   FIRE_BURST_S no more fire leaves it, and what is in the air burns out
 *                over the next FIRE_LIFE_S.
 *   from then on SMOKE, and plenty of it, going up without a break for as
 *                long as the flight lasts.
 *
 * NONE OF IT IS A PICTURE LAID OVER A SCREEN. Fire and smoke alike are
 * things in the world, standing on the truck: the camera sees them, the
 * pilot sees them through the window, a rise in the ground hides them, and
 * they grow as the aircraft closes in. A struck truck stays struck, respawn
 * or not.
 *
 * HOW THEY ARE MADE. Both are a fixed handful of PUFFS — soft round patches,
 * each turned to its own angle — that leave the truck one after another,
 * climb, swell, thin away to nothing and are then sent off again. The fire's
 * are lit from within and run from white-hot through orange to a dying red;
 * the smoke's are grey and lean away with the wind. Because the spent ones
 * are used again, the plume renews itself for ever out of a few dozen.
 *
 * THE SIZES ARE SHARES OF THE TRUCK'S OWN HEIGHT, not metres — so fire and
 * plume keep their proportions whatever MODEL_SCALE is set to. 1 is the
 * truck's full height; 0.5 is half of it.
 *
 * WRECK_ON false leaves the truck untouched; FIRE_ON and SMOKE_ON turn off
 * one or the other on their own.
 */
const WRECK_ON = true;
const WRECK_DARKEN = 0.12;        // 0 is burnt black, 1 is the truck untouched
const WRECK_ROUGH = 0.95;         // the shine taken off it; 1 is dead matt
/** AND HOW FAR IT IS THROWN ABOUT. The blast does not leave a thing sitting
 *  square on its wheels: it is tipped over a little, dropped by the nose and
 *  settled into the ground, which is what says BROKEN at a glance from the
 *  air, where the charring alone would not. Degrees, and metres. */
const WRECK_TILT_DEG = 6;         // tipped over to one side
const WRECK_NOSE_DEG = -3.5;      // and down by the nose
const WRECK_SINK_M = 0.6;         // how far it settles into the ground

const FIRE_ON = true;
const FIRE_BURST_S = 3.5;         // how long fire keeps breaking out of it
const FIRE_PUFFS = 38;            // how many flames are in the air at once
const FIRE_EVERY_S = 0.06;        // how often another breaks out
const FIRE_LIFE_S = 2.1;          // how long one burns before it is spent
const FIRE_FROM = 0.3;            // how high up the truck they break out
const FIRE_SPREAD = 0.95;         // how far off its middle they break out
const FIRE_RISE = 0.24;           // how far one climbs each second
const FIRE_START = 2;             // how wide one is as it breaks out
const FIRE_GROW = 1.8;            // and how much wider it gets each second
const FIRE_OPACITY = 0.95;        // how fierce one is at its height
const FIRE_HOT = 0xfff0b0;        // the colour it breaks out at
const FIRE_MID = 0xff8a1e;        // what it turns to
const FIRE_COOL = 0x6b1d04;       // and what it dies to

const SMOKE_ON = true;
const SMOKE_PUFFS = 80;           // how many are in the air at once
const SMOKE_EVERY_S = 0.15;       // how often another leaves the wreck
const SMOKE_LIFE_S = 11;          // how long one lasts before it is spent
const SMOKE_FROM = 0.5;           // how high up the wreck they leave
const SMOKE_SPREAD = 0.3;         // how far off its middle they leave
const SMOKE_RISE = 0.45;          // how far one climbs each second
const SMOKE_WIND = 0.18;          // how far the wind carries it each second
const SMOKE_WIND_FROM = 250;      // and the bearing that wind comes FROM
const SMOKE_START = 1.5;          // how wide one is as it leaves
const SMOKE_GROW = 0.4;           // and how much wider it gets each second
const SMOKE_GREY = 0.13;          // 0 is black smoke, 1 is white steam
const SMOKE_OPACITY = 0.95;       // how solid one is at its thickest

/** The model's own place in the world, and the group it hangs in. */
let modelGroup: THREE.Group | null = null;
const modelAt = new THREE.Vector3();

function lightTheModel(): void {
  const sky = new THREE.HemisphereLight(0xcfe3ff, 0x6b6356, MODEL_SKY_LIGHT);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, MODEL_SUN_LIGHT);
  const b = (MODEL_SUN_FROM.bearing * Math.PI) / 180;
  const h = (MODEL_SUN_FROM.height * Math.PI) / 180;
  // North is -z here, as it is for the course.
  sun.position.set(Math.sin(b) * Math.cos(h), Math.sin(h), -Math.cos(b) * Math.cos(h));
  scene.add(sun);
}

function loadModel(): void {
  if (!MODEL_ON) return;
  lightTheModel();
  new GLTFLoader().load(MODEL_FILE, (gltf) => {
    const group = new THREE.Group();
    const thing = gltf.scene;
    thing.scale.multiplyScalar(MODEL_SCALE);
    thing.rotation.y += (MODEL_TURN_DEG * Math.PI) / 180;
    // Measured as it will be drawn, so the foot of it can be put on the
    // ground however the file has its middle.
    thing.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(thing);
    thing.position.y -= box.min.y;
    modelHeight = box.max.y - box.min.y;      // as drawn, in metres
    group.add(thing);
    modelBody = thing;
    addModelMark(group, box);
    scene.add(group);
    modelGroup = group;
    modelAt.copy(worldPoint(world, MODEL_AT.lat, MODEL_AT.lon, 0));
  });
}

/** The model itself inside its group — what the blast throws about, so that
 *  the group, and the fire and smoke hanging on it, stay upright. */
let modelBody: THREE.Object3D | null = null;

/** How tall the model stands once it is drawn, in metres. The smoke is sized
 *  off this, so the plume suits the truck however big the truck is made. */
let modelHeight = 0;

/** The badge over the model: a sign standing on the middle of its roof. */
let modelMark: THREE.Sprite | null = null;
function addModelMark(group: THREE.Group, box: THREE.Box3): void {
  if (!MODEL_MARK) return;
  const art = new THREE.TextureLoader().load(MODEL_MARK);
  art.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: art,
    depthTest: false,          // a mark over the world, not a thing in it
    transparent: true,
  }));
  sprite.renderOrder = 10;
  // Over the MIDDLE OF THE ROOF — the middle of what is actually drawn, not
  // of wherever the file happens to put the model's own origin.
  sprite.position.x = (box.min.x + box.max.x) / 2;
  sprite.position.z = (box.min.z + box.max.z) / 2;
  markRoof = box.max.y - box.min.y;
  group.add(sprite);
  modelMark = sprite;
}

/** How tall the model is drawn, so the badge knows where its roof is. */
let markRoof = 0;

/**
 * Size the badge for ONE picture, so that it fills the same share of it
 * however far off the truck is: a thing of height h at distance d fills
 * h / (2 d tan(fov/2)) of the picture, so the height to ask for is that
 * worked back. The foot of the stalk then goes on the roof.
 */
function sizeMark(view: THREE.PerspectiveCamera, share: number): void {
  if (!modelMark || !modelGroup) return;
  const roof = modelGroup.position.clone();
  roof.y += markRoof;
  const d = Math.max(1, view.position.distanceTo(roof));
  const h = 2 * d * Math.tan((view.fov * Math.PI) / 360) * share;
  modelMark.scale.set((h * 131) / 284, h, 1);   // the file is 131 x 284
  modelMark.position.y = markRoof + MARK_LIFT_M + h / 2;
}

/** How strongly it shows from where the aircraft is: nothing at all beyond
 *  its range, coming up over the last stretch of it. */
function markFade(): number {
  if (!modelGroup) return 0;
  const d = camera.position.distanceTo(modelGroup.position);
  if (d >= MARK_RANGE_M) return 0;
  if (d <= MARK_RANGE_M - MARK_FADE_M) return 1;
  return (MARK_RANGE_M - d) / Math.max(1, MARK_FADE_M);
}

/** Every frame: keep it on its spot, standing on the ground as it is known. */
function updateModel(): void {
  if (!modelGroup) return;
  modelGroup.position.copy(modelAt).add(terrain.anchor.worldOffset);
  // The ground is asked for again each frame, as it is for the hoops: the
  // first answer comes from a coarse tile, and the finer ground settles it.
  const ground = terrain.groundHeight(modelGroup.position);
  const sunk = wrecked && WRECK_ON ? WRECK_SINK_M : 0;
  if (ground !== undefined) modelGroup.position.y = ground + MODEL_LIFT_M - sunk;
  if (modelMark) {
    // Struck, the badge is gone for good: the wreck comes back, the sign on
    // its roof does not.
    const fade = modelStruck ? 0 : markFade();
    modelMark.visible = fade > 0;
    modelMark.material.opacity = fade;
    sizeMark(camera, MARK_SCREEN_SIM);
  }
}


/**
 * ── THE WRECK ───────────────────────────────────────────────────────────────
 *
 * Burnt where it stands. Every material is COPIED before it is touched, so
 * what is darkened belongs to this one model and nothing else in the world
 * can be darkened with it; and because it is the same meshes in the same
 * group, untouched and never hidden, the thing cannot have moved, turned or
 * changed size.
 */
let wrecked = false;
/** What each mesh wore before the fire, so START AGAIN can give it back. */
const beforeTheFire = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

function burnTheModel(): void {
  if (!modelGroup || wrecked) return;
  wrecked = true;
  if (WRECK_ON) {
    const burn = (skin: THREE.Material): THREE.Material => {
      const copy = skin.clone() as THREE.MeshStandardMaterial;
      if (copy.color) copy.color.multiplyScalar(WRECK_DARKEN);
      if (copy.emissive) copy.emissive.setScalar(0);
      if (typeof copy.metalness === 'number') copy.metalness = 0;
      if (typeof copy.roughness === 'number') copy.roughness = WRECK_ROUGH;
      return copy;
    };
    modelGroup.traverse((thing) => {
      const mesh = thing as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!beforeTheFire.has(mesh)) beforeTheFire.set(mesh, mesh.material);
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(burn)
        : burn(mesh.material);
    });
  }
  // Thrown over by the blast and settled into the ground. It is the BODY
  // that is turned, not the group, so the plume still goes straight up.
  if (WRECK_ON && modelBody) {
    modelBody.rotation.z += (WRECK_TILT_DEG * Math.PI) / 180;
    modelBody.rotation.x += (WRECK_NOSE_DEG * Math.PI) / 180;
  }
  if (FIRE_ON) lightTheFire();
  if (SMOKE_ON) lightTheSmoke();
}

/**
 * ── ONE SOFT ROUND PATCH ────────────────────────────────────────────────────
 *
 * The picture every puff is drawn from, fire and smoke alike. It is built
 * here rather than loaded, so there is no file to keep in step: a few
 * overlapping clouds of white fading away to nothing, which each puff then
 * turns to its own angle and tints to its own colour, so no two look alike.
 */
let softArt: THREE.Texture | null = null;
function puffArt(): THREE.Texture {
  if (softArt) return softArt;
  const side = 128;
  const cut = document.createElement('canvas');
  cut.width = side;
  cut.height = side;
  const g = cut.getContext('2d');
  if (g) {
    const blob = (x: number, y: number, r: number, strength: number): void => {
      const paint = g.createRadialGradient(x, y, 0, x, y, r);
      paint.addColorStop(0, `rgba(255,255,255,${strength})`);
      paint.addColorStop(0.55, `rgba(255,255,255,${strength * 0.45})`);
      paint.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = paint;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    const mid = side / 2;
    blob(mid, mid, mid * 0.72, 0.85);
    blob(mid * 0.72, mid * 0.85, mid * 0.42, 0.5);
    blob(mid * 1.26, mid * 1.1, mid * 0.46, 0.5);
    blob(mid * 1.1, mid * 0.7, mid * 0.34, 0.4);
    blob(mid * 0.82, mid * 1.28, mid * 0.3, 0.35);
  }
  softArt = new THREE.CanvasTexture(cut);
  softArt.colorSpace = THREE.SRGBColorSpace;
  return softArt;
}

/** One patch on its way up: how old it is, and where it set off from. */
interface Puff { sprite: THREE.Sprite; age: number; x: number; z: number }

/**
 * The puffs are hung ON THE MODEL'S OWN GROUP, not in the scene: the world is
 * shifted under the aircraft as it flies — see rebaseLargeWorld — and hung
 * here they are carried along with the truck without a word, their positions
 * being plain metres from the truck itself.
 */
function makePuffs(into: Puff[], many: number, skin: Partial<THREE.SpriteMaterialParameters>): void {
  if (!modelGroup || into.length) return;
  for (let i = 0; i < many; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: puffArt(),
      transparent: true,
      depthWrite: false,          // neither fire nor smoke hides what is behind it
      opacity: 0,
      ...skin,
    }));
    sprite.visible = false;
    modelGroup.add(sprite);
    // Spent to begin with, so they are sent off one after another rather
    // than all in the same instant.
    into.push({ sprite, age: Number.POSITIVE_INFINITY, x: 0, z: 0 });
  }
}

/**
 * Is this one spent, and is it this one's turn to go off again? Answering
 * both in one place is what keeps the two plumes to the same few lines.
 */
function sendOff(puff: Puff, spread: number, timer: number): boolean {
  if (timer > 0) { puff.sprite.visible = false; return false; }
  puff.age = 0;
  puff.x = (Math.random() * 2 - 1) * spread;
  puff.z = (Math.random() * 2 - 1) * spread;
  puff.sprite.material.rotation = Math.random() * Math.PI * 2;
  return true;
}

/**
 * ── THE FIRE ────────────────────────────────────────────────────────────────
 *
 * Flames break out of the truck for FIRE_BURST_S and then stop breaking out;
 * the last of them burns away over the FIRE_LIFE_S after that, so the whole
 * thing is over in about four seconds and the truck is left standing in the
 * smoke. Each flame is lit from within — laid on in ADDITIVE, where it adds
 * its own light to whatever is behind it instead of hiding it, which is what
 * makes it read as fire and not as a coloured balloon — and it runs from
 * white-hot through orange to a dying red as it goes.
 */
const flames: Puff[] = [];
let fireAge = 0;                  // seconds since the strike, by the flight's clock
let fireTimer = 0;
const fireHot = new THREE.Color(FIRE_HOT);
const fireMid = new THREE.Color(FIRE_MID);
const fireCool = new THREE.Color(FIRE_COOL);

function lightTheFire(): void {
  fireAge = 0;
  fireTimer = 0;
  makePuffs(flames, FIRE_PUFFS, {
    color: fireHot.clone(),
    blending: THREE.AdditiveBlending,
  });
}

function updateFire(dt: number): void {
  if (!flames.length || fireAge > FIRE_BURST_S + FIRE_LIFE_S + 1) return;
  fireAge += dt;
  const h = Math.max(1, modelHeight);
  fireTimer -= dt;
  const over = fireAge > FIRE_BURST_S;    // no more of it breaks out
  for (const flame of flames) {
    if (flame.age > FIRE_LIFE_S) {
      if (over) { flame.sprite.visible = false; continue; }
      if (!sendOff(flame, FIRE_SPREAD * h, fireTimer)) continue;
      fireTimer = FIRE_EVERY_S;
    }
    flame.age += dt;
    const life = Math.min(1, flame.age / FIRE_LIFE_S);
    const w = (FIRE_START + FIRE_GROW * flame.age) * h;
    flame.sprite.scale.set(w, w, 1);
    // It sits ON the truck rather than over it: the flames wrap round the
    // thing and spill above it, so the truck is there to be seen in the fire.
    flame.sprite.position.set(flame.x, FIRE_FROM * h + FIRE_RISE * h * flame.age, flame.z);
    // White-hot at first, then orange, then down to a red that fades out.
    const colour = flame.sprite.material.color;
    if (life < 0.3) colour.copy(fireHot).lerp(fireMid, life / 0.3);
    else colour.copy(fireMid).lerp(fireCool, (life - 0.3) / 0.7);
    const fade = Math.min(1, flame.age / (FIRE_LIFE_S * 0.08)) * (1 - life) ** 1.2;
    flame.sprite.material.opacity = FIRE_OPACITY * fade;
    flame.sprite.visible = fade > 0.01;
  }
}

/**
 * ── THE SMOKE ───────────────────────────────────────────────────────────────
 *
 * The same few patches over and over, for ever: one leaves every
 * SMOKE_EVERY_S, climbs, leans away with the wind, swells and thins out, and
 * when it is spent it waits its turn and sets off again.
 */
const puffs: Puff[] = [];
let smokeTimer = 0;

function lightTheSmoke(): void {
  makePuffs(puffs, SMOKE_PUFFS, { color: new THREE.Color().setScalar(SMOKE_GREY) });
}

/**
 * Every frame while the flight runs — and NOT while it is held, which is why
 * this and the fire are called from inside the hold's own guard: both stop
 * dead with everything else and carry on from where they stood.
 */
function updateSmoke(dt: number): void {
  if (!puffs.length) return;
  const h = Math.max(1, modelHeight);
  // Where the wind blows TO, north being -z as it is everywhere here.
  const to = ((SMOKE_WIND_FROM + 180) * Math.PI) / 180;
  const windX = Math.sin(to) * SMOKE_WIND * h;
  const windZ = -Math.cos(to) * SMOKE_WIND * h;
  smokeTimer -= dt;
  for (const puff of puffs) {
    if (puff.age > SMOKE_LIFE_S) {
      if (!sendOff(puff, SMOKE_SPREAD * h, smokeTimer)) continue;
      smokeTimer = SMOKE_EVERY_S;
    }
    puff.age += dt;
    const w = (SMOKE_START + SMOKE_GROW * puff.age) * h;
    puff.sprite.scale.set(w, w, 1);
    puff.sprite.position.set(
      puff.x + windX * puff.age,
      SMOKE_FROM * h + SMOKE_RISE * h * puff.age + w / 2,
      puff.z + windZ * puff.age,
    );
    // Thickens as it leaves, thins away over the rest of its life.
    const life = puff.age / SMOKE_LIFE_S;
    const fade = Math.min(1, puff.age / (SMOKE_LIFE_S * 0.12)) * (1 - life) ** 1.5;
    puff.sprite.material.opacity = SMOKE_OPACITY * fade;
    puff.sprite.visible = fade > 0.01;
  }
}

/**
 * ══ START AGAIN ═════════════════════════════════════════════════════════════
 *
 * The key at the right-hand end of the map's top panel, come across the
 * channel. The flight begins again — aircraft on the start point, full tank,
 * a fresh run for the map to count from — and the truck is a truck once more:
 * the materials it wore before the fire are given back, it is set upright on
 * its wheels and lifted out of the ground, the badge returns to its roof, and
 * the fire and smoke are put out and taken away. A weapon in the air at that
 * moment never lands.
 *
 * The map is told nothing in return: the next fix carries an empty list of
 * struck marks and a new run number, which is all it needs.
 */
function startAgain(): void {
  window.clearTimeout(strikeTimer);
  modelStruck = false;
  struckMarks.clear();
  putOutTheFire();
  if (wrecked) {
    wrecked = false;
    for (const [mesh, skin] of beforeTheFire) mesh.material = skin;
    beforeTheFire.clear();
    if (WRECK_ON && modelBody) {
      modelBody.rotation.z -= (WRECK_TILT_DEG * Math.PI) / 180;
      modelBody.rotation.x -= (WRECK_NOSE_DEG * Math.PI) / 180;
    }
  }
  resetRun();
  // The aircraft is somewhere else now — the start point, which it may have
  // left far behind — and the ground there was let go of as it flew away. Ask
  // for it AT ONCE rather than on the next turn of the clock, so it is on its
  // way before the first frame of the new run is drawn.
  terrain.retryMissing();
  tileRetryAt = performance.now() + TILE_RETRY_S * 1000;
}

/** Take the flames and the plume out of the world altogether, so that a
 *  truck that is struck again starts them afresh rather than carrying on. */
function putOutTheFire(): void {
  for (const pool of [flames, puffs]) {
    for (const puff of pool) {
      puff.sprite.removeFromParent();
      puff.sprite.material.dispose();
    }
    pool.length = 0;
  }
  fireAge = 0;
  fireTimer = 0;
  smokeTimer = 0;
}

/** Out of the belly camera's picture: the hoops are for the pilot's eye, not
 *  for the sensor, and edge-on to it they would only be a flicker of white. */
function showHoops(on: boolean): void {
  for (const hoop of hoops) hoop.group.visible = on;
}

buildHoops();
loadModel();

/**
 * ══ THE TARGETS ═════════════════════════════════════════════════════════════
 *
 * Marks pinned to the GROUND on the moving map — they do not travel with the
 * aircraft any more than a town does. Each one is a picture in public/icons
 * named for the threat it is: ta412.png, ta422.png, and so on; `file` below is
 * that name without the .png.
 *
 * WHERE EACH ONE STANDS, in one of two ways:
 *
 *   BESIDE THE ROUTE — the usual way, since that is how they are thought of:
 *
 *       { file: 'ta412', after: 2, run: 3_000, left: 2_500 },
 *
 *     `after` is the waypoint it is measured from (2 = 2A), `run` how many
 *     metres on from there along the route, and `left` how far out to the side
 *     — to the LEFT of the way the aircraft is flying. A minus puts it right.
 *     Both may be 0; `run` past the end of that leg simply carries on straight.
 *
 *   OR AT A PLACE — when the spot is known:
 *
 *       { file: 'ta432', at: { lat: 33.35, lon: 35.62 } },
 *
 * WHICH LOOK IT IS DRAWN WITH, `kind`:
 *
 *   'threat'  the default, left out — the red triangles, ta412.png and the
 *             rest. Size, anchor and opacity come from the --target-* knobs.
 *   'after'   the grey struck mark, Target_after.png. The same place-keeping
 *             in every way; it only reads a second family of knobs,
 *             --target-after-*, so the kinds are sized and placed on their
 *             spot apart from one another.
 *   'befor'   the mark as it is before the strike, Target_befor.png, on a
 *             third family of its own: --target-befor-*.
 *   'truck'   the launcher's own mark, which stands on the same spot of ground
 *             as the model in the simulator AND ANSWERS A PRESS: pressing it
 *             on the map swaps its picture for the file of the same name with
 *             _selected on the end, and pressing it again puts the first one
 *             back. Its knobs are --target-truck-*.
 *
 * `kind` only chooses the knobs; `file` still says which picture. A second
 * struck-mark picture would be another line with the same kind and its own
 * file name.
 *
 * Add a line and a target appears, remove one and it is gone. Their size on
 * the screen is in map.html, which is about how they look rather than where
 * they are.
 */
interface TargetPlan {
  file: string;
  /** which family of look knobs it reads; left out, 'threat' */
  kind?: 'threat' | 'after' | 'befor' | 'truck';
  /** beside the route */
  after?: number; run?: number; left?: number;
  /** …or at a place of its own */
  at?: { lat: number; lon: number };
  /** CAN THE WEAPON TAKE IT OUT? Left out, yes, and the mark then has three
   *  faces: its own, _selected while it is picked out, and _after once it has
   *  been struck. `strike: false` says it has only the first two — there is no
   *  _after file for it, nothing in the world to destroy, and a release on the
   *  launcher leaves it standing where it is. */
  strike?: boolean;
}

const TARGETS: TargetPlan[] = [
  // The launcher's mark, on the very spot the model stands on in the
  // simulator — it takes its place from MODEL_AT, so moving the model moves
  // the mark with it and the two can never drift apart. Press it on the map
  // and it puts on BN222_icon_selected.png; press it again and it takes it
  // off. The triangles are not put on the map any more, but the machinery is
  // untouched: a line here brings one back.
  //
  // THE FILE'S NAME IS THE TARGET'S NAME. BN222 is what the map draws, what
  // the targets screens call it and what the foes list calls it, so pressing
  // it anywhere picks it out everywhere — see the lists in demo/map.ts.
  { file: 'BN222_icon', kind: 'truck', at: MODEL_AT },
  // TR383 — a mark and nothing else: there is no model of it in the simulator
  // and the weapon cannot take it out, so it has the two faces its files give
  // it and no struck one, which is what `strike: false` says. It is pressed,
  // ringed in the lists and slaved to the camera exactly as BN222 is.
  //
  // THE LAUNCHER MUST STAY FIRST in this list: the pink envelope's line is
  // drawn to the truck that can be struck, and that is BN222.
  { file: 'TR383_icon', kind: 'truck', strike: false,
    at: { lat: 33.59420871103045, lon: 35.70155672555636 } },
  // GE867 — the same again: two faces, no model, nothing for the weapon to
  // take out. It stands south of the launcher, the other side of it from
  // TR383.
  { file: 'GE867_icon', kind: 'truck', strike: false,
    at: { lat: 33.550926602628394, lon: 35.69945979402824 } },
];

/**
 * ══ THE AREAS ═══════════════════════════════════════════════════════════════
 *
 * Stretches of ground — Red Area.png and any other picture like it — laid on
 * the map the way a field is laid on the earth. An area is NOT a symbol: it is
 * a piece of ground, so unlike the targets it
 *
 *   • has a size in METRES, not in screen pixels, and therefore grows when you
 *     zoom in and shrinks when you zoom out, exactly like a town or a lake;
 *   • TURNS WITH THE GROUND, so it keeps the compass direction it was given
 *     however the aircraft is pointing.
 *
 * WHERE IT STANDS — the same two ways as a target, and it is the MIDDLE of the
 * picture that goes on the spot:
 *
 *   BESIDE THE ROUTE:
 *
 *       { file: 'Red Area', after: 3, run: 2_000, left: 4_000, width: 9_000 },
 *
 *     `after` the waypoint measured from (3 = 3A), `run` metres on from it
 *     along the route, `left` metres out to the side — plus is LEFT of the way
 *     ahead, minus is right.
 *
 *   AT A PLACE:
 *
 *       { file: 'Red Area', at: { lat: 33.42, lon: 35.63 }, width: 9_000 },
 *
 * ITS SIZE AND THE WAY IT LIES:
 *
 *   `width`  how many METRES of ground the picture covers across. The height
 *            follows the picture's own shape, so the artwork is never
 *            squashed. 9_000 is a nine-kilometre-wide area.
 *   `turn`   which way the picture's own UP points, in degrees of the compass:
 *            0 (or left out) is north, 90 east, 180 south, 270 west. The area
 *            keeps that direction whatever the aircraft does.
 *
 * How strongly they are drawn, and whether at all, is --area-* in map.html.
 */
interface AreaPlan {
  file: string;
  /** beside the route */
  after?: number; run?: number; left?: number;
  /** …or at a place of its own */
  at?: { lat: number; lon: number };
  /** metres across the ground; the height follows the picture's shape */
  width: number;
  /** degrees from north that the picture's own up points; 0 left out */
  turn?: number;
}

const AREAS: AreaPlan[] = [
  { file: 'Red Area', after: 1, run: 3_000, left: 6_500, width: 9_000, turn: 0 },
];

/** The areas as the map wants them: a picture, a place, a size on the ground
 *  and the way it lies. */
function areaMarks(): NonNullable<MapFix['areas']> {
  return AREAS.map((a) => {
    const at = a.at ?? besideRoute(a.after ?? 1, a.run ?? 0, a.left ?? 0);
    return { file: a.file, lat: at.lat, lon: at.lon, width: a.width, turn: a.turn ?? 0 };
  });
}

/** A place out to the side of the route: `run` metres on from a waypoint,
 *  then `left` metres square to the left of the way ahead. */
function besideRoute(after: number, run: number, left: number): { lat: number; lon: number } {
  const pts = ROUTE_WAYPOINTS;
  const i = Math.min(Math.max(0, Math.round(after) - 1), pts.length - 2);
  const a = pts[i];
  const b = pts[i + 1];
  const kx = Math.cos((a.lat * Math.PI) / 180);
  const bearing = (Math.atan2((b.lon - a.lon) * kx, b.lat - a.lat) * 180) / Math.PI;
  const on = legFrom(a, bearing, run);
  return legFrom(on, bearing - 90, left);      // 90° off the nose is the wing
}

/**
 * ══ THE THREAT CUES ═════════════════════════════════════════════════════════
 *
 * Each one is a place on the ground where a sequence plays out on the map:
 * SEARCHING, then TRACKING, then LAUNCH, with a line drawn to the aircraft and
 * a sound at each change. How long each stretch lasts, how the rings look and
 * what they sound like is the same for all of them and lives in map.html; what
 * is here is WHICH set of pictures a cue uses and WHERE it stands.
 *
 *   { set: '_22', after: 2, run: 0, left: 2_500 },
 *
 * `set` is the tail of the picture files — '_22' uses searching_icon_ring_22,
 * tracking_icon_ring_22 and Launch_icon_ring_22; '' uses the plain three.
 * `after`, `run` and `left` place it exactly as a target is placed: so many
 * metres along the route from a waypoint, then so many out to the left of the
 * line (minus for the right).
 *
 * WHEN IT STARTS: as the aircraft draws level with it along the route. `lead`
 * moves that moment, in metres: minus starts it earlier, plus later.
 */
interface CuePlan {
  set: string;
  after: number; run: number; left: number;
  lead?: number;
  // The four stretches of the sequence, in SECONDS. Leave one out and the map
  // uses its own knob for it (--cue-delay / --cue-searching / --cue-tracking /
  // --cue-launch in map.html); write one here and it holds for THIS set only.
  delay?: number;      // the quiet wait after the gate, before the first ring
  searching?: number;  // how long SEARCHING shows
  tracking?: number;   // how long TRACKING shows
  launch?: number;     // how long LAUNCH shows
}

const CUES: CuePlan[] = [
  // The one set, the three pictures with no tail to their names.
  //
  // IT LIGHTS AT 3A AND STANDS WELL BEYOND IT. Those are two different
  // things, and this is how they are told apart:
  //
  //   run   where the rings STAND — metres on from 3A ALONG THE ROUTE, which
  //         is to say up the screen. This is the one that lifts them: at 0
  //         they stand level with the aircraft, which is why they came out
  //         low however much `left` was changed, since `left` only ever
  //         moves them sideways.
  //   lead  how far the moment of lighting is moved from where they stand.
  //         MINUS THE SAME NUMBER brings that moment back to 3A, so keeping
  //         lead = -run lights them at the waypoint however far up the
  //         screen they have been put.
  //   left  out to the side; minus is to the RIGHT of the line.
  { set: '', after: 2, run: 8_000, lead: -8_000, left: -6_500,
    searching: 10, tracking: 10, launch: 15 },
];

/** How far along the route a point beside it stands, in metres. */
function alongTo(after: number, run: number): number {
  const pts = ROUTE_WAYPOINTS;
  const i = Math.min(Math.max(0, Math.round(after) - 1), pts.length - 2);
  let walked = 0;
  const kx = Math.cos((pts[0].lat * Math.PI) / 180);
  for (let leg = 0; leg < i; leg++) {
    const a = pts[leg];
    const b = pts[leg + 1];
    walked += Math.hypot((b.lon - a.lon) * kx, b.lat - a.lat) * 111_320;
  }
  return walked + run;
}

/** The cues as the map wants them: a set of pictures, a place, and the point
 *  along the route at which the sequence begins. */
function cueMarks(): NonNullable<MapFix['cues']> {
  return CUES.map((c) => {
    const at = besideRoute(c.after, c.run, c.left);
    return {
      set: c.set,
      lat: at.lat,
      lon: at.lon,
      gate: alongTo(c.after, c.run) + (c.lead ?? 0),
      delay: c.delay,
      searching: c.searching,
      tracking: c.tracking,
      launch: c.launch,
    };
  });
}

/** The targets as the map wants them: a picture and a place. */
function targetMarks(): NonNullable<MapFix['targets']> {
  return TARGETS.map((t) => {
    const at = t.at ?? besideRoute(t.after ?? 1, t.run ?? 0, t.left ?? 0);
    return { id: t.file, lat: at.lat, lon: at.lon, kind: t.kind, strike: t.strike };
  });
}

/**
 * THE LINE BEHIND THE AIRCRAFT AT ENTRY, in metres. The route is drawn
 * carrying straight on backwards out of its first waypoint for this distance,
 * so that the moment the flight begins there is already a stretch of route
 * behind the aircraft, in the flown colour, as if it had been flying for some
 * minutes. It is LINE ONLY: no waypoint sits on it, nothing is numbered
 * there, and the route's own first waypoint is still 1A. Set it to 0 and the
 * route simply begins at its first waypoint.
 *
 * (The aircraft is put down SPAWN_BACK — 2.5 km — behind the first waypoint,
 * so anything longer than that shows behind it.)
 */
const ROUTE_LEAD_IN_M = 10_000;

/** Where that line starts: straight back out of the first leg. */
function routeLeadIn(): { lat: number; lon: number } | undefined {
  if (ROUTE_LEAD_IN_M <= 0 || ROUTE_WAYPOINTS.length < 2) return undefined;
  const [a, b] = ROUTE_WAYPOINTS;                       // the first leg, a → b
  const kx = Math.cos((a.lat * Math.PI) / 180);         // lon degrees are shorter up here
  const dLat = b.lat - a.lat;
  const dLon = (b.lon - a.lon) * kx;
  const lengthDeg = Math.hypot(dLat, dLon) || 1;
  const t = ROUTE_LEAD_IN_M / 111_320 / lengthDeg;      // share of that leg, going backwards
  return { lat: a.lat - dLat * t, lon: a.lon - (dLon * t) / kx };
}

/** Append the aircraft's position to the flown track, thinned to TRAIL_STEP. */
const _trailAbs = new THREE.Vector3();
function recordTrail(): void {
  _trailAbs.copy(camera.position).sub(terrain.anchor.worldOffset);
  const last = trail[trail.length - 1];
  if (last && last.distanceTo(_trailAbs) < TRAIL_STEP) return;
  trail.push(_trailAbs.clone());
  if (trail.length > TRAIL_MAX) trail.shift();
}

/** One path update: extend the track. The route itself never changes here. */
function updatePath(dt: number): void {
  pathTimer += dt;
  if (pathTimer < 1 / PATH_UPDATE_HZ) return;
  pathTimer = 0;
  recordTrail();
}

/** Drop the track — a respawn starts a fresh one. The route is untouched. */
function clearPath(): void {
  trail.length = 0;
}

// -- the course centerline ---------------------------------------------------

/** How far (m) BEHIND the course start the aircraft spawns. Raise it to give
 *  more room to settle before reaching the start point. */
const SPAWN_BACK = 2500;
/** Constant course direction (start → end): the heading the aircraft launches
 *  on, and the direction E levels the nose back to. */
const courseNormal = new THREE.Vector3(0, 0, -1);
/** Absolute (rebase-independent) centerline start — the spawn reference. */
const courseStart = new THREE.Vector3();

/** Resolve the course's endpoints into world space. */
function setupCourse(): void {
  const a = worldPoint(world, COURSE.start.lat, COURSE.start.lon, COURSE.start.alt);
  const b = worldPoint(world, COURSE.end.lat, COURSE.end.lon, COURSE.end.alt);
  courseStart.copy(a);
  courseNormal.copy(b).sub(a).normalize();
}

let popTimer = 0;
function showPop(text: string, color: string): void {
  popEl.textContent = text;
  popEl.style.color = color;
  popEl.style.opacity = '1';
  popTimer = 0.9;
}

// -- game / flight state -----------------------------------------------------

let started = false;
let participant = { name: '', subject: '' };

const flight = {
  speed: SPEED_START,          // |velocity| in m/s (for the HUD; set by the model)
  vel: new THREE.Vector3(),    // world velocity vector — the actual flight path
  throttle: THROTTLE_START,    // engine command 0..1 (drives thrust, not speed)
  angVel: new THREE.Vector3(), // rad/s: x=pitch, y=yaw, z=roll
  crashed: false,
};

function resetCamera(): void {
  // Spawn on the course centerline, SPAWN_BACK metres behind the start point,
  // aimed straight down the course.
  const startAbs = courseStart.clone().addScaledVector(courseNormal, -SPAWN_BACK);
  camera.position.copy(startAbs).add(terrain.anchor.worldOffset);
  camera.up.set(0, 1, 0);
  camera.lookAt(courseStart.clone().addScaledVector(courseNormal, 1200).add(terrain.anchor.worldOffset));
  // Launch already moving straight down the nose at the spawn airspeed.
  camera.getWorldDirection(forward);
  flight.vel.copy(forward).multiplyScalar(SPEED_START);
  flight.speed = SPEED_START;
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  sizeCompass();
  sizeAttitude();
  sizeTape(spdTape);
  sizeTape(altTape);
}
window.addEventListener('resize', resize);

function crash(): void {
  flight.crashed = true;
  crashEl.style.display = 'block';
}

/**
 * Put the aircraft back on the start point, level and at the spawn airspeed.
 * Bound to R (any time) and to a tap after a crash. It never returns to the
 * login screen — the participant stays signed in.
 */
function resetRun(): void {
  flight.crashed = false;
  flight.angVel.set(0, 0, 0);
  flight.speed = SPEED_START;
  flight.throttle = THROTTLE_START;
  runId++; // a new run: the moving map starts a fresh track
  fuelStartedAt = performance.now(); // and a full tank
  clearPath();
  camPanDown = 0;      // the belly camera back to where it rests
  camPanSide = 0;
  resetCamera();
  crashEl.style.display = 'none';
}


/**
 * Continue (E) — available at any time, crashed or not. Both cases level the
 * wings and the nose back along the course; they differ in what else they
 * touch:
 *
 *   crashed    — the aircraft is lifted back to the course's start altitude
 *                over the same spot and the throttle returns to THROTTLE_START.
 *   in flight  — a pure attitude recovery: same position, same altitude, same
 *                airspeed, same throttle — the pilot only straightens out.
 */
const _contLook = new THREE.Vector3();
function continueFlight(): void {
  const wasCrashed = flight.crashed;
  flight.crashed = false;
  flight.angVel.set(0, 0, 0);
  if (wasCrashed) {
    flight.throttle = THROTTLE_START;
    // Start altitude, but never inside a hill that rises above it.
    const ground = terrain.groundHeight(camera.position) ?? 0;
    camera.position.y = Math.max(courseStart.y + terrain.anchor.worldOffset.y, ground + 150);
  }
  camera.up.set(0, 1, 0);
  _contLook.set(courseNormal.x, 0, courseNormal.z).normalize();
  camera.lookAt(_contLook.multiplyScalar(1000).add(camera.position));
  camera.getWorldDirection(forward);
  // A crash recovery relaunches at the spawn airspeed; a mid-air recovery keeps
  // the speed the pilot already had, so no energy is handed out for free.
  const speed = wasCrashed ? SPEED_START : flight.speed;
  flight.vel.copy(forward).multiplyScalar(speed);
  flight.speed = speed;
  crashEl.style.display = 'none';
}

// -- input: keyboard ---------------------------------------------------------

const keys = new Set<string>();
const justPressed = new Set<string>();

function keyDown(code: string): void {
  if (!started) return;
  if (code === 'Escape' && !keys.has(code)) setPaused(!paused);
  if (code === WEAPON_KEY && !keys.has(code)) pullTrigger();
  if (!keys.has(code)) justPressed.add(code);
  keys.add(code);
}
const keyUp = (code: string): void => { keys.delete(code); };

window.addEventListener('keydown', (e) => keyDown(e.code));
window.addEventListener('keyup', (e) => keyUp(e.code));
window.addEventListener('blur', () => keys.clear());

// -- input: touch ------------------------------------------------------------

const touchSteer = { x: 0, y: 0 };
let steerId: number | null = null;
let steerStart = { x: 0, y: 0 };
let pinchDist = 0;
let tapReset = false;

const touchDist = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const clearSteer = (): void => { steerId = null; touchSteer.x = 0; touchSteer.y = 0; };
const anchorSteer = (t: Touch): void => {
  steerId = t.identifier; steerStart = { x: t.clientX, y: t.clientY }; touchSteer.x = 0; touchSteer.y = 0;
};

canvas.addEventListener('touchstart', (e) => {
  if (!started) return;
  e.preventDefault();
  if (flight.crashed) { tapReset = true; return; }
  if (e.touches.length === 1) anchorSteer(e.touches[0]);
  else if (e.touches.length === 2) { clearSteer(); pinchDist = touchDist(e.touches[0], e.touches[1]); }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (!started) return;
  e.preventDefault();
  if (e.touches.length >= 2) {
    const d = touchDist(e.touches[0], e.touches[1]);
    if (pinchDist > 0) flight.throttle = Math.min(Math.max(flight.throttle + (d - pinchDist) / 300, 0), 1);
    pinchDist = d;
    return;
  }
  const t = e.touches[0];
  if (t === undefined || t.identifier !== steerId) return;
  const clamp1 = (v: number): number => Math.min(Math.max(v, -1), 1);
  touchSteer.x = clamp1((t.clientX - steerStart.x) / STEER_RADIUS);
  touchSteer.y = clamp1((t.clientY - steerStart.y) / STEER_RADIUS);
}, { passive: false });

const touchEnd = (e: TouchEvent): void => {
  e.preventDefault();
  pinchDist = 0;
  if (e.touches.length === 1) anchorSteer(e.touches[0]);
  else if (e.touches.length === 0) clearSteer();
};
canvas.addEventListener('touchend', touchEnd, { passive: false });
canvas.addEventListener('touchcancel', touchEnd, { passive: false });

// -- input: gamepad (Thrustmaster HOTAS Warthog) -----------------------------

/** The USB product id a browser reports inside a gamepad's name, e.g. "0404". */
function padProduct(p: Gamepad): string | null {
  return /product:\s*([0-9a-f]{4})/i.exec(p.id)?.[1]?.toLowerCase() ?? null;
}

/** Is this device the throttle? By product id first, then by name. */
function isThrottlePad(p: Gamepad): boolean {
  const product = padProduct(p);
  if (product && GP_THROTTLE_PRODUCTS.includes(product)) return true;
  if (product && GP_STICK_PRODUCTS.includes(product)) return false;
  return p.id.toLowerCase().includes(GP_THROTTLE_ID);
}

/** A HOTAS is two devices on two USB ports — sort them into stick and throttle. */
function warthogPads(): { stick: Gamepad | null; throttle: Gamepad | null } {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let stick: Gamepad | null = null;
  let throttle: Gamepad | null = null;
  for (const p of pads) {
    if (!p) continue;
    if (isThrottlePad(p)) { throttle ??= p; continue; }
    // Prefer the configured stick when more than one is connected.
    if (!stick || padProduct(p) === GP_STICK_PREFERRED) stick = p;
  }
  return { stick, throttle };
}
// Log each device's id + axis count on connect, so the mapping above can be
// checked/adjusted against what this machine actually reports (open the console).
window.addEventListener('gamepadconnected', (e) => {
  const g = e.gamepad;
  const role = isThrottlePad(g) ? 'THROTTLE' : 'STICK';
  console.log(`[gamepad] ${role}: "${g.id}" — ${g.axes.length} axes, ${g.buttons.length} buttons (index ${g.index})`);
});

/**
 * Axis probe. While the login screen is still up, every axis that moves is
 * logged with its device and index — so a new stick can be mapped by waggling
 * it and reading the console, instead of guessing the numbering. It stops the
 * moment the flight starts, so it never logs while flying.
 */
const gpProbe = new Map<string, number[]>();
const gpButtons = new Map<string, boolean[]>();
function probeGamepads(): void {
  if (started) return;
  for (const p of navigator.getGamepads ? navigator.getGamepads() : []) {
    if (!p) continue;
    const last = gpProbe.get(p.id) ?? Array.from(p.axes, () => 0);
    for (let i = 0; i < p.axes.length; i++) {
      if (Math.abs(p.axes[i] - last[i]) > 0.35) {
        const role = isThrottlePad(p) ? 'THROTTLE' : 'STICK';
        console.log(`[gamepad] ${role} "${p.id}" → axis ${i} = ${p.axes[i].toFixed(2)}`);
        last[i] = p.axes[i];
      }
    }
    gpProbe.set(p.id, last);
    // …and every button pressed, so the camera's four can be checked against
    // what this throttle actually reports.
    const was = gpButtons.get(p.id) ?? [];
    for (let i = 0; i < p.buttons.length; i++) {
      const down = p.buttons[i].pressed;
      if (down && !was[i]) {
        const role = isThrottlePad(p) ? 'THROTTLE' : 'STICK';
        console.log(`[gamepad] ${role} "${p.id}" → button ${i} pressed`);
      }
      was[i] = down;
    }
    gpButtons.set(p.id, was);
  }
}

/** Read an axis by index, 0 if that axis doesn't exist on this device. */
const axis = (a: readonly number[], i: number): number => (i < a.length ? a[i] : 0);
/** Suppress tiny centre noise so a resting stick doesn't drift. */
const deadzone = (v: number): number => (Math.abs(v) < GP_DEADZONE ? 0 : v);

// -- systems -----------------------------------------------------------------

const target = new THREE.Vector3();
const forward = new THREE.Vector3();
// Inputs are sampled once per rendered frame; the physics then runs in fixed
// sub-steps (see the frame loop), so behaviour is identical at any frame rate.
let throttleDir = 0; // −1 / 0 / +1 from the throttle keys, applied per physics step
let leverThrottle: number | null = null; // absolute HOTAS lever setting, if present

function gatherInputs(): void {
  // Stick / rudder: body-axis RATE commands (x = pitch, y = yaw, z = roll).
  // Holding deflects a rate; releasing an axis sets its rate to 0 → the aircraft
  // stops rotating on that axis and HOLDS attitude (no auto-level).
  target.set(0, 0, 0);
  if (keys.has('KeyA')) target.z += FM.ROLL_RATE;
  if (keys.has('KeyD')) target.z -= FM.ROLL_RATE;
  if (keys.has('KeyZ')) target.y += FM.YAW_RATE;
  if (keys.has('KeyC')) target.y -= FM.YAW_RATE;
  if (keys.has('KeyW')) target.x -= FM.PITCH_RATE;
  if (keys.has('KeyS')) target.x += FM.PITCH_RATE;
  target.z -= FM.ROLL_RATE * touchSteer.x;
  target.x += FM.PITCH_RATE * touchSteer.y;

  throttleDir = 0;
  if (keys.has('Equal') || keys.has('NumpadAdd')) throttleDir += 1;
  if (keys.has('Minus') || keys.has('NumpadSubtract')) throttleDir -= 1;

  leverThrottle = null;
  const { stick, throttle } = warthogPads();
  if (stick) {
    target.z -= FM.ROLL_RATE * deadzone(axis(stick.axes, GP_AXIS_ROLL)) * (GP_INVERT_ROLL ? -1 : 1);
    target.x += FM.PITCH_RATE * deadzone(axis(stick.axes, GP_AXIS_PITCH)) * (GP_INVERT_PITCH ? -1 : 1);
  }
  if (throttle && throttle.axes.length > GP_AXIS_THR_B) {
    const lever = (axis(throttle.axes, GP_AXIS_THR_A) + axis(throttle.axes, GP_AXIS_THR_B)) / 2;
    leverThrottle = Math.min(Math.max((1 - lever) / 2, 0), 1);
  }
}

/** One fixed physics sub-step: throttle, pose (rate command), then flight path. */
function physicsStep(h: number): void {
  if (flight.crashed) return;
  flight.throttle = Math.min(Math.max(flight.throttle + throttleDir * THROTTLE_RATE * h, 0), 1);
  if (leverThrottle !== null) flight.throttle = leverThrottle; // absolute lever wins
  applyStick(camera.quaternion, flight.angVel, target, h, flight.speed);
  const out = stepDynamics(camera.quaternion, flight.vel, flight.throttle, h);
  flight.speed = out.speed;
  camera.position.addScaledVector(flight.vel, h);
}

const shift = new THREE.Vector3();
function rebaseLargeWorld(): void {
  shift.set(0, 0, 0);
  if (Math.abs(camera.position.x) > REBASE_THRESHOLD) shift.x = -Math.sign(camera.position.x) * REBASE_THRESHOLD;
  if (Math.abs(camera.position.z) > REBASE_THRESHOLD) shift.z = -Math.sign(camera.position.z) * REBASE_THRESHOLD;
  if (shift.x !== 0 || shift.z !== 0) {
    camera.position.add(shift);
    terrain.rebase(shift);
  }
}


function crashCheck(): void {
  if (flight.crashed) return; // R / tap handling lives in the frame loop
  const ground = terrain.groundHeight(camera.position) ?? 0;
  if (ground > camera.position.y) crash();
}

/**
 * The terrain is streamed live from map servers (it is not bundled), so it must
 * download around the spawn before the run looks right. We do that WHILE the
 * participant is on the login screen: the Start button shows the progress and is
 * disabled until the map is ready — so the big "loading" splash never sits over
 * the flight. (Ongoing streaming as you fly north is normal and silent.)
 */
function loadingUi(): void {
  loadingEl.style.display = 'none'; // no center splash during gameplay
  if (started) return;
  if (terrain.status.loading) {
    startBtn.disabled = true;
    startBtn.textContent = `Loading map… ${(terrain.status.progress * 100).toFixed(0)}%`;
  } else {
    startBtn.disabled = false;
    startBtn.textContent = 'Start';
  }
}

function hud(): void {
  // Live cockpit tapes: airspeed left of the centre, altitude right of it.
  drawTape(spdTape, flight.speed * 1.94384);      // m/s → knots
  drawTape(altTape, camera.position.y * 3.28084); // m → feet
}

// -- compass heading tape ----------------------------------------------------
// The world's north is -Z and east is +X (the course runs south→north), so the
// aircraft's compass heading is the bearing of its forward direction.
const _heading = new THREE.Vector3();
function currentHeading(): number {
  camera.getWorldDirection(_heading);
  const deg = Math.atan2(_heading.x, -_heading.z) * 180 / Math.PI;
  return (deg % 360 + 360) % 360;
}

/** Tape look, matched to the reference: px per degree + tick/label metrics. */
const CMP_DEG = 2.2;           // px per degree (tick density)
let cmpW = 0, cmpH = 0;
function sizeCompass(): void {
  const r = compassEl.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cmpW = r.width; cmpH = r.height;
  compassEl.width = Math.round(cmpW * dpr);
  compassEl.height = Math.round(cmpH * dpr);
  compassCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function headingLabel(d: number): string {
  const dd = (d % 360 + 360) % 360;
  if (dd === 0) return 'N';
  if (dd === 90) return 'E';
  if (dd === 180) return 'S';
  if (dd === 270) return 'W';
  return String(dd / 10).padStart(2, '0'); // 300→"30", 60→"06"
}
// ── Compass fill colours ─ set these (the black outline stays black either way).
//    Each controls the FILL/line colour only, not the outline stroke.
// F-15 style HUD green (matches --hud in index.html).
const HUD_GREEN = '#3dff5c';
const HUD_OUTLINE = 'rgba(0, 0, 0, .7)'; // thin dark rim so symbols read over bright sky
const CMP_COLOR_MINOR = HUD_GREEN;    // short ticks (minor, every 10°)
const CMP_COLOR_MAJOR = HUD_GREEN;    // long ticks (every 30°) + their label (number/letter)
const CMP_COLOR_POINTER = HUD_GREEN;  // centre pointer line + the big heading number above it



function drawCompass(): void {
  const ctx = compassCtx, W = cmpW, H = cmpH;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2;
  const midY = H - 18;                 // tick centre line, near the bottom
  const heading = currentHeading();
  ctx.textAlign = 'center';

  // Black outline thickness (px), tuned separately because text and lines
  // render their outline differently: OUT_TEXT = visible rim around glyphs,
  // OUT_LINE = visible rim on each side of a tick / the pointer.
  const OUT_TEXT = 0.9;
  const OUT_LINE = 0.5;
  const strokedText = (t: string, x: number, y: number, color: string): void => {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = HUD_OUTLINE; ctx.lineWidth = OUT_TEXT * 2; ctx.strokeText(t, x, y);
    ctx.fillStyle = color; ctx.fillText(t, x, y);
  };
  const strokedLine = (x0: number, y0: number, x1: number, y1: number, w: number, color: string): void => {
    ctx.strokeStyle = HUD_OUTLINE; ctx.lineWidth = w + OUT_LINE * 2; // black underlay
    ctx.beginPath(); ctx.moveTo(x0, y0 - OUT_LINE); ctx.lineTo(x1, y1 + OUT_LINE); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = w;                 // fill colour on top
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  };

  // ticks + labels: every 10°, major (taller/thicker) + labelled every 30°
  const halfDeg = (W / 2) / CMP_DEG + 20;
  const startD = Math.ceil((heading - halfDeg) / 10) * 10;
  const endD = Math.floor((heading + halfDeg) / 10) * 10;
  for (let d = startD; d <= endD; d += 10) {
    const diff = ((d - heading + 540) % 360) - 180; // shortest signed offset
    const x = cx + diff * CMP_DEG;
    const major = ((d % 30) + 30) % 30 === 0;
    const half = major ? 8 : 5;
    strokedLine(x, midY - half, x, midY + half, major ? 1.6 : 1.0, major ? CMP_COLOR_MAJOR : CMP_COLOR_MINOR);
    if (major && Math.abs(x - cx) > 16) {   // no label under the centre readout
      ctx.font = '400 16px Roboto, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      strokedText(headingLabel(d), x, midY - half - 6, CMP_COLOR_MAJOR);
    }
  }

  // fixed centre pointer, from just under the readout down past the ticks
  strokedLine(cx, 35, cx, midY + 21, 2.0, CMP_COLOR_POINTER);

  // big current-heading readout, centred at top
  ctx.font = '500 20px Roboto, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  strokedText(String(Math.round(heading) % 360).padStart(3, '0'), cx, 10, CMP_COLOR_POINTER);
}

// -- airspeed / altitude tapes -----------------------------------------------
// Fighter-HUD moving scales: the scale slides past a fixed boxed readout at the
// tape's vertical centre. Ticks sit on the edge facing the centre and the
// readout box has a caret pointing inward, mirrored for the two sides.

interface Tape {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  inner: 'left' | 'right'; // which canvas edge faces the screen centre
  unit: string;
  minor: number;           // value between minor ticks
  major: number;           // value between labelled major ticks
  pxPerMinor: number;      // spacing between minor ticks
  min: number;             // lowest value drawn on the scale (-Infinity = none)
  readoutStep: number;     // boxed number is rounded to this step (1 = exact)
  w: number; h: number;
}
function makeTape(el: HTMLCanvasElement, inner: Tape['inner'], unit: string,
                  minor: number, major: number, min: number, readoutStep = 1): Tape {
  return { el, ctx: el.getContext('2d')!, inner, unit, minor, major, pxPerMinor: 12, min, readoutStep, w: 0, h: 0 };
}
const spdTape = makeTape(spdTapeEl, 'right', 'KT', 10, 50, 0);           // left of centre
// Altitude readout in 100 ft steps (the scale behind it still slides smoothly).
const ALT_READOUT_STEP = 100;
const altTape = makeTape(altTapeEl, 'left', 'FT', 100, 500, -Infinity, ALT_READOUT_STEP); // right of centre

function sizeTape(t: Tape): void {
  const r = t.el.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  t.w = r.width; t.h = r.height;
  t.el.width = Math.round(t.w * dpr);
  t.el.height = Math.round(t.h * dpr);
  t.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawTape(t: Tape, value: number): void {
  const { ctx, w: W, h: H } = t;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  // Author everything as if the inner edge is on the right, then mirror x.
  const X = (x: number): number => (t.inner === 'right' ? x : W - x);
  const align = (a: 'left' | 'right'): CanvasTextAlign =>
    t.inner === 'right' ? a : (a === 'left' ? 'right' : 'left');

  const unitH = 22;                 // room for the unit label at the bottom
  const top = 4, bot = H - unitH;
  const cy = (top + bot) / 2;
  const edge = W - 3;               // scale spine, on the inner edge
  const pxPerUnit = t.pxPerMinor / t.minor;

  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  const line = (pts: [number, number][], width: number, close = false): void => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), y) : ctx.moveTo(X(x), y)));
    if (close) ctx.closePath();
    ctx.strokeStyle = HUD_OUTLINE; ctx.lineWidth = width + 1.2; ctx.stroke();
    ctx.strokeStyle = HUD_GREEN; ctx.lineWidth = width; ctx.stroke();
  };
  const text = (s: string, x: number, y: number, a: 'left' | 'right', font: string): void => {
    ctx.font = font; ctx.textAlign = align(a); ctx.textBaseline = 'middle';
    ctx.strokeStyle = HUD_OUTLINE; ctx.lineWidth = 2; ctx.strokeText(s, X(x), y);
    ctx.fillStyle = HUD_GREEN; ctx.fillText(s, X(x), y);
  };

  // moving scale, clipped to the tape window
  ctx.save();
  ctx.beginPath(); ctx.rect(0, top, W, bot - top); ctx.clip();
  line([[edge, top], [edge, bot]], 1.4);
  const span = (bot - top) / 2 / pxPerUnit + t.minor;
  const first = Math.ceil((value - span) / t.minor) * t.minor;
  for (let v = first; v <= value + span; v += t.minor) {
    if (v < t.min) continue;
    const y = cy - (v - value) * pxPerUnit;
    const isMajor = Math.round(v) % t.major === 0;
    const len = isMajor ? 14 : 7;
    line([[edge - len, y], [edge, y]], isMajor ? 1.6 : 1.1);
    if (isMajor) text(String(Math.round(v)), edge - len - 5, y, 'right', '400 13px Roboto, system-ui, sans-serif');
  }
  ctx.restore();

  // fixed readout box with a caret pointing at the scale
  const bh = 24, caret = 8;
  const bx0 = 6, bx1 = edge - 18;
  const by0 = cy - bh / 2, by1 = cy + bh / 2;
  ctx.beginPath();
  [[bx0, by0], [bx1, by0], [bx1 + caret, cy], [bx1, by1], [bx0, by1]]
    .forEach(([x, y], i) => (i ? ctx.lineTo(X(x), y) : ctx.moveTo(X(x), y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 14, 4, .78)'; ctx.fill(); // hide the scale behind it
  line([[bx0, by0], [bx1, by0], [bx1 + caret, cy], [bx1, by1], [bx0, by1]], 1.6, true);
  text(String(Math.round(value / t.readoutStep) * t.readoutStep), bx1 - 5, cy + 1, 'right', '500 16px Roboto, system-ui, sans-serif');

  // unit label under the tape
  text(t.unit, edge, H - unitH / 2, 'right', '500 11px Roboto, system-ui, sans-serif');
}

// -- attitude symbology (F-15 / F-16 style) ------------------------------------
// Everything is placed by projecting real directions through the camera (the
// camera IS the aircraft: its forward axis is the nose), so pitch and roll come
// out exactly right with no separate attitude maths:
//   • W aircraft datum — fixed at screen centre = where the nose points.
//   • Flight path marker — the direction of flight.vel (the physics' world
//     velocity), so it sits below the W when the nose is up but the aircraft
//     climbs less steeply (angle of attack), and drifts sideways in a skid.
//   • Horizon line (0°, solid) + pitch ladder every PITCH_STEP° (dashed), end
//     ticks pointing toward the horizon, numbered both ends. Only rungs within
//     LADDER_RANGE° of the nose's current pitch are drawn.

const PITCH_STEP = 5;       // degrees between ladder rungs
const LADDER_RANGE = 15;    // show rungs only within ± this many degrees of the nose
const LADDER_DASH = [7, 5]; // rung dash pattern (px on, px off); [] = solid lines
const RUNG_HALF = 70;       // px from the ladder centre to each rung's outer end
const RUNG_GAP = 32;        // px of empty centre on each side (keeps W/FPM clear)
const HORIZON_HALF = 230;   // px — the horizon line is longer than a rung
const HORIZON_GAP = 40;
const RUNG_TICK = 9;        // px end tick pointing toward the horizon

let attW = 0, attH = 0;
function sizeAttitude(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  attW = window.innerWidth; attH = window.innerHeight;
  attitudeEl.width = Math.round(attW * dpr);
  attitudeEl.height = Math.round(attH * dpr);
  attitudeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const _attFwd = new THREE.Vector3();
const _attDir = new THREE.Vector3();
const _attP = new THREE.Vector3();
const _attQ = new THREE.Vector3();
const _attH = new THREE.Vector3();
const _attR = new THREE.Vector3();
/** Screen position (CSS px) of a world DIRECTION from the aircraft, or null if behind. */
function projectDir(dir: THREE.Vector3, out: { x: number; y: number }): boolean {
  if (dir.dot(_attFwd) < 0.05) return false; // behind / at the edge of view
  _attP.copy(camera.position).addScaledVector(dir, 1000).project(camera);
  out.x = (_attP.x + 1) / 2 * attW;
  out.y = (1 - _attP.y) / 2 * attH;
  return true;
}

function drawAttitude(): void {
  const ctx = attitudeCtx;
  ctx.clearRect(0, 0, attW, attH);
  if (!attW) return;
  camera.updateMatrixWorld();
  camera.getWorldDirection(_attFwd);

  // Horizontal heading axes: along the nose (flattened) and to its right.
  _attH.set(_attFwd.x, 0, _attFwd.z);
  if (_attH.lengthSq() < 1e-6) _attH.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0); // nose vertical
  _attH.normalize();
  _attR.set(-_attH.z, 0, _attH.x); // right of heading (north → east)

  const stroke = (draw: () => void, width: number, dash: number[] = []): void => {
    ctx.setLineDash(dash);
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.beginPath(); draw(); ctx.strokeStyle = HUD_OUTLINE; ctx.lineWidth = width + 1.4; ctx.stroke();
    ctx.beginPath(); draw(); ctx.strokeStyle = HUD_GREEN; ctx.lineWidth = width; ctx.stroke();
    ctx.setLineDash([]);
  };

  // Ladder + horizon, clipped to the window between the speed/alt tapes and
  // below the compass, like a real HUD's field of view.
  const sp = spdTapeEl.getBoundingClientRect(), al = altTapeEl.getBoundingClientRect();
  const cm = compassEl.getBoundingClientRect();
  const clipL = sp.right + 8, clipR = al.left - 8, clipT = cm.bottom + 6, clipB = attH - 30;
  ctx.save();
  ctx.beginPath(); ctx.rect(clipL, clipT, clipR - clipL, clipB - clipT); ctx.clip();

  const c = { x: 0, y: 0 }, cr = { x: 0, y: 0 };
  ctx.font = '400 13px Roboto, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const nosePitch = (Math.asin(Math.max(-1, Math.min(1, _attFwd.y))) * 180) / Math.PI;
  for (let deg = -90; deg <= 90; deg += PITCH_STEP) {
    if (Math.abs(deg - nosePitch) > LADDER_RANGE) continue;
    const a = (deg * Math.PI) / 180;
    _attDir.copy(_attH).multiplyScalar(Math.cos(a)).addScaledVector(_WORLD_UP, Math.sin(a));
    if (!projectDir(_attDir, c)) continue;
    // on-screen rung direction: nudge the direction a hair to the right
    _attQ.copy(_attDir).addScaledVector(_attR, 0.01);
    if (!projectDir(_attQ, cr)) continue;
    let ux = cr.x - c.x, uy = cr.y - c.y;
    const len = Math.hypot(ux, uy) || 1; ux /= len; uy /= len;
    const nx = -uy, ny = ux; // screen "down" relative to the rung (toward − pitch)
    if (c.x < clipL - 300 || c.x > clipR + 300 || c.y < clipT - 300 || c.y > clipB + 300) continue;

    const half = deg === 0 ? HORIZON_HALF : RUNG_HALF;
    const gap = deg === 0 ? HORIZON_GAP : RUNG_GAP;
    const tick = deg > 0 ? RUNG_TICK : deg < 0 ? -RUNG_TICK : 0; // toward the horizon
    stroke(() => {
      for (const s of [-1, 1]) {
        const x0 = c.x + ux * gap * s, y0 = c.y + uy * gap * s;
        const x1 = c.x + ux * half * s, y1 = c.y + uy * half * s;
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        if (tick) ctx.lineTo(x1 + nx * tick, y1 + ny * tick);
      }
    }, deg === 0 ? 1.8 : 1.5, deg < 0 ? LADDER_DASH : []); // climb rungs solid, dive rungs dashed

    if (deg !== 0) {
      const label = String(deg);
      const ang = Math.atan2(uy, ux);
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(c.x + ux * (half + 6) * s, c.y + uy * (half + 6) * s);
        ctx.rotate(ang);
        ctx.textAlign = s > 0 ? 'left' : 'right';
        // labels sit level with the tick end, so nudge toward it
        const ty = tick * 0.55;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = HUD_OUTLINE; ctx.lineWidth = 2; ctx.strokeText(label, 0, ty);
        ctx.fillStyle = HUD_GREEN; ctx.fillText(label, 0, ty);
        ctx.restore();
      }
    }
  }
  ctx.restore();

  // W aircraft datum — fixed at the boresight (screen centre).
  const wx = attW / 2, wy = attH / 2;
  stroke(() => {
    ctx.moveTo(wx - 26, wy); ctx.lineTo(wx - 13, wy);
    ctx.lineTo(wx - 6.5, wy + 9); ctx.lineTo(wx, wy);
    ctx.lineTo(wx + 6.5, wy + 9); ctx.lineTo(wx + 13, wy);
    ctx.lineTo(wx + 26, wy);
  }, 2);

  // Flight path marker — where the aircraft is actually going.
  if (flight.speed > 1) {
    _attDir.copy(flight.vel).normalize();
    const f = { x: 0, y: 0 };
    if (projectDir(_attDir, f)) {
      // keep it inside the HUD window (a real FPM is caged to the HUD's FOV)
      f.x = Math.min(Math.max(f.x, clipL + 20), clipR - 20);
      f.y = Math.min(Math.max(f.y, clipT + 20), clipB - 20);
      const r = 6;
      stroke(() => {
        ctx.moveTo(f.x + r, f.y); ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
        ctx.moveTo(f.x - r, f.y); ctx.lineTo(f.x - r - 11, f.y); // left wing
        ctx.moveTo(f.x + r, f.y); ctx.lineTo(f.x + r + 11, f.y); // right wing
        ctx.moveTo(f.x, f.y - r); ctx.lineTo(f.x, f.y - r - 7);  // tail
      }, 1.8);
    }
  }
}
const _WORLD_UP = new THREE.Vector3(0, 1, 0);


// -- frame loop --------------------------------------------------------------

const PHYS_DT = 1 / 120; // fixed physics step — decoupled from the render rate
let physAcc = 0;
let last = performance.now();
/** When the ground is next asked for again — see TILE_RETRY_S. */
let tileRetryAt = 0;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (started && !paused) {
    // R (any layout — it's the physical key) or a post-crash tap puts the
    // aircraft back on the start point; it never returns to the login screen.
    if (justPressed.has('KeyR') || tapReset) resetRun();
    // E continues at any time — after a crash, or as a mid-air attitude recovery.
    // It is the physical key (KeyE), so Hebrew (ק) and English layouts both work.
    else if (justPressed.has('KeyE')) continueFlight();
    // Sample inputs once, then advance the physics in fixed PHYS_DT sub-steps so
    // the result is frame-rate independent (the leftover time carries over).
    gatherInputs();
    physAcc = Math.min(physAcc + dt, 0.25); // cap to avoid a spiral of death
    while (physAcc >= PHYS_DT) {
      physicsStep(PHYS_DT);
      physAcc -= PHYS_DT;
    }
    rebaseLargeWorld();
    crashCheck();
    updatePath(dt);
    // M reopens the moving map if it was closed (the key press is the user
    // gesture a popup needs). Focusing it does not steal the keyboard for long:
    // the simulator keeps flying, and clicking back resumes control.
    if (justPressed.has('KeyM')) openMapWindow();
    mapFixTimer += dt;
    if (mapFixTimer >= MAP_FIX_INTERVAL) { mapFixTimer = 0; sendMapFix(); }
    hud();
    drawCompass();
    drawAttitude();
  }
  terrain.update();
  // …and every TILE_RETRY_S, ask again for whatever has not come down. This
  // runs on the wall clock, started or held alike: it is not part of the
  // flight, it changes nothing in it, and the ground is as worth filling in
  // while the thing is held as while it is flying.
  if (now >= tileRetryAt) {
    // A look costs nothing, so it is frequent; having ASKED for something,
    // it holds off a little before asking again — see TILE_RETRY_S.
    const asked = terrain.retryMissing();
    tileRetryAt = now + (asked > 0 ? TILE_RETRY_S : TILE_CHECK_S) * 1000;
  }
  loadingUi();
  probeGamepads();

  if (popTimer > 0) {
    popTimer -= dt;
    if (popTimer <= 0) popEl.style.opacity = '0';
  }

  justPressed.clear();
  tapReset = false;
  if (started && !paused) {
    panCamera(dt);
    zoomCamera(dt);
    watchTrigger();
    updateFire(dt);
    updateSmoke(dt);
    sendCamFrame(performance.now());
  }
  updateHoops();
  updateModel();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// -- boot: login → simulator -------------------------------------------------

function startSimulation(): void {
  started = true;
  fuelStartedAt = performance.now(); // the fuel clock starts with the flight
  loginEl.style.display = 'none';
  attitudeEl.style.display = 'block';
  spdTapeEl.style.display = 'block';
  altTapeEl.style.display = 'block';
  compassEl.style.display = 'block';
  sizeCompass();
  sizeTape(spdTape);
  sizeTape(altTape);
  resetCamera();
  canvas.focus();
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (terrain.status.loading) return; // map not ready yet (button is disabled anyway)
  const name = fullNameEl.value.trim();
  const subject = subjectIdEl.value.trim();
  if (!name) { loginErr.textContent = 'Please enter your full name.'; return; }
  if (!subject) { loginErr.textContent = 'Please enter your participant ID.'; return; }
  // The map is a popup, so it has to be opened by this very click.
  if (!openMapWindow()) {
    loginErr.textContent = 'Allow pop-ups for this page — the moving map could not open.';
    return;
  }
  loginErr.textContent = '';
  participant = { name, subject };
  startSimulation();
  sendMapFix(); // put the aircraft on the map before the first frame is flown
});

if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  crashEl.textContent = 'You crashed! Tap to reset.';
}

// Anchor the world on the course and start rendering immediately, so the
// terrain around the start point is already loading behind the login screen.
setupCourse();
resetCamera();
resize();
requestAnimationFrame(frame);

// dev convenience: expose live state for debugging in the console
Object.defineProperty(window, '__sim', {
  configurable: true,
  get: () => ({ terrain, flight, camera, camCamera, participant, courseNormal, courseStart, course: COURSE,
    scene, hoops, path: { trail, route: ROUTE_WAYPOINTS } }),
});
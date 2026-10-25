/**
 * THE MOVING MAP — the second screen.
 *
 * A TRACK-UP satellite map: the aircraft symbol is nailed to one spot — low on
 * the screen, so most of the map is the ground AHEAD of it — always upright and
 * always pointing straight up, and it is the MAP that turns underneath it. Up the screen is therefore wherever the aircraft is
 * flying — a turn in the simulator swings the ground round, and the symbol
 * settles back level the moment the turn stops. The
 * imagery is the SAME Esri World Imagery the simulator's terrain is textured
 * with, fetched as plain slippy-map tiles and drawn on a 2D canvas — no
 * three.js, no terrain streaming, so the second screen costs almost nothing.
 *
 * Positions arrive from the simulator window over a BroadcastChannel (see
 * mapLink.ts). One thing travels the other way: the order that slaves the
 * belly camera to a mark that has been pressed here.
 *
 * THE ROUTE is a line fixed in the world — the way the aircraft is meant to
 * fly — and it is drawn where it is, not where the aircraft is: fly off it and
 * it stays put. It is split at the point on it nearest the aircraft, so the
 * stretch still to be flown reads in one colour and the stretch already passed
 * in the other. The route itself is defined in the simulator (`buildRoute` in
 * main.ts) and arrives with every fix.
 *
 * Nothing else is drawn here on purpose: the read-outs and controls this page
 * carried while it was being built are gone, leaving a clean map for the final
 * design to be laid over.
 */
import {
  MAP_CHANNEL, type CamFrame, type MapFix, type MapMessage, type PauseOrder,
  type ResetOrder, type SlaveOrder,
} from './mapLink';

/*
 * THREE THINGS THAT HAVE TO EXIST BEFORE ANYTHING ELSE RUNS.
 *
 * The page sets itself up from top to bottom, but some of that setting up —
 * laying out the panes, and the artwork that arrives out of the browser's own
 * cache — reaches back for these. They are therefore declared here, where
 * they are ready before the first line of work runs, rather than beside the
 * parts that use them further down. What each one is for is written there.
 */

/** Fixes arrive faster than the screen refreshes, so drawing is left to rAF. */
let dirty = false;
/** True while everything is held — see setPausedHere. Declared up here with
 *  the rest of the state so that nothing can read it before it exists: the
 *  threats' own clock asks for it, and that is read on the first message. */
let paused = false;
let heldAt = 0;
/** The quieter set of camera markings, and which set is on screen now —
 *  see "THE MARKINGS, AND THE ZOOM" near the end of this file. */
const CAM_OVERLAY_ZOOM: Record<string, string> = {
  './icons/cam_5_layout.png': './icons/cam_5_layout_zoomin.png',
  './icons/cam_3_layout.png': './icons/cam_3_layout_zoomin.png',
};
let camZoomed = false;

/** Esri World Imagery, the simulator's own texture provider (zoom/y/x order). */
const TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/:zoom:/:y:/:x:';
/** Web-mercator tile edge in CSS pixels. */
const TILE = 256;
/** Zoom limits: 8 ≈ the whole country, 17 ≈ individual buildings. */
const ZOOM_MIN = 8;
const ZOOM_MAX = 17;
/** The aircraft itself. Drawn nose-up; on a track-up map it never rotates. */
const ICON_URL = './icons/Me_icon.png';
/** The compass ring around it, carrying the N. It is one piece with its mark,
 *  so it is not placed but TURNED: the whole ring rotates until its N points
 *  at true north, and the aircraft is drawn over it, upright. */
const RING_URL = './icons/Me_ring.png';
/** On-screen size (px) of the aircraft symbol, from map.html, in design px. */
const ICON_SIZE_DEFAULT = 72;
function cssNumber(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * HOW THE ROUTE IS DRAWN — every size and every colour of it, read from the
 * knob block in map.html so that one file holds the whole look. The values are
 * cached rather than read per frame: getComputedStyle is not free, and they
 * only change when the window does or when a knob is edited, both of which
 * already run `fitButtons`.
 */
interface RouteStyle {
  /** the line */
  showLine: boolean; width: number; casing: number;
  ahead: string; flown: string; casingColor: string;
  dash: number; dashGap: number; shadow: number; shadowColor: string;
  /** the ring at each waypoint */
  showRing: boolean; ring: number; ringStroke: number; ringCasing: number;
  ringColor: string; ringFill: string;
  /** the dot at its centre */
  showDot: boolean; dot: number; dotColor: string;
  /** its name plate */
  showLabel: boolean; labelH: number; labelText: number; labelPad: number;
  labelDx: number; labelDy: number; labelBg: string; labelColor: string;
  labelWeight: string; labelFont: string; labelRadius: number;
}
let routeStyle: RouteStyle | null = null;

/** A colour (or any text) from the knob block. */
function cssText(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * One of the two knobs that place a name plate, in PIXELS on this screen.
 * `12px` is taken as 12 design px; a bare `0.4` is taken as four tenths of
 * the ring's diameter, so the plate keeps its distance when the ring grows.
 */
function offset(name: string, fallback: number, scale: number): number {
  const n = cssNumber(name, fallback);
  return cssText(name, '').includes('px')
    ? n * scale
    : n * cssNumber('--route-marker', 30) * scale;
}

/** Re-read the knobs. Called whenever anything about the screen changes. */
function readRouteStyle(): void {
  const scale = uiScale();
  // A knob that is a switch: anything but 0 means "draw it".
  const on = (name: string) => cssNumber(name, 1) !== 0;
  routeStyle = {
    // the line
    showLine: on('--route-show-line'),
    width: cssNumber('--route-width', 6) * scale,
    casing: cssNumber('--route-casing', 2) * scale,
    ahead: cssText('--route-color-ahead', '#40A0FF'),
    flown: cssText('--route-color-flown', '#5A899A'),
    casingColor: cssText('--route-color-casing', '#001838'),
    dash: cssNumber('--route-dash', 0) * scale,
    dashGap: cssNumber('--route-dash-gap', 0) * scale,
    shadow: cssNumber('--route-shadow', 0) * scale,
    shadowColor: cssText('--route-shadow-color', 'rgba(0, 0, 0, .5)'),
    // the ring
    showRing: on('--route-show-ring'),
    ring: cssNumber('--route-marker', 41) * scale,
    ringStroke: cssNumber('--route-marker-stroke', 6) * scale,
    ringCasing: cssNumber('--route-marker-casing', 2) * scale,
    // `auto` means the ring says what the line says: blue ahead, grey-blue behind.
    ringColor: cssText('--route-marker-color', 'auto'),
    // `auto` here too: the shade inside takes the stretch's own colour.
    ringFill: cssText('--route-marker-fill', 'rgba(0, 12, 28, .45)'),
    // the dot
    showDot: on('--route-show-dot'),
    dot: cssNumber('--route-dot', 6) * scale,
    dotColor: cssText('--route-dot-color', '#E8F2FF'),
    // the name plate
    showLabel: on('--route-show-label'),
    labelH: cssNumber('--route-label-h', 46) * scale,
    labelText: cssNumber('--route-label-text', 30) * scale,
    labelPad: cssNumber('--route-label-pad', 0.42),
    // Where the plate sits, measured from the RING'S CENTRE. A plain number
    // is a share of the ring's diameter (0.5 = half a ring across); write it
    // with px instead and it is that many design px, whatever the ring does.
    labelDx: offset('--route-label-dx', 0.1, scale),
    labelDy: offset('--route-label-dy', 0.3, scale),
    labelBg: cssText('--route-label-bg', 'rgba(52, 59, 66, .68)'),
    labelColor: cssText('--route-label-color', '#FFFFFF'),
    labelWeight: cssText('--route-label-weight', '500'),
    labelFont: cssText('--route-label-font', 'Roboto, system-ui, sans-serif'),
    // In per cent OF THE PLATE'S OWN HEIGHT: 50% is a full pill, 0% square.
    // A px value works too, and is scaled like every other size here.
    labelRadius: cssText('--route-label-radius', '50%').includes('%')
      ? (cssNumber('--route-label-radius', 50) / 100) * cssNumber('--route-label-h', 46) * scale
      : cssNumber('--route-label-radius', 23) * scale,
  };
}

// -- DOM ---------------------------------------------------------------------

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const waitEl = document.getElementById('wait')!;
const topPanelEl = document.getElementById('topPanel') as HTMLImageElement;
const mapButtonsEl = document.getElementById('mapButtons')!;
const friendsBtn = document.getElementById('btnFriends') as HTMLImageElement;
const listImg = document.getElementById('friendList') as HTMLImageElement;
const foesBar = document.getElementById('foesBar') as HTMLImageElement;
const friendsBar = document.getElementById('friendsBar') as HTMLImageElement;
const friendPanelEl = document.getElementById('friendPanel')!;
const mapButtonsLeftEl = document.getElementById('mapButtonsLeft')!;
const screenEl = document.getElementById('screen')!;
const bottomPanelEl = document.getElementById('bottomPanel')!;
const bottomPanelImg = document.getElementById('bottomPanelImg') as HTMLImageElement;
const fuelNumEl = document.getElementById('fuelNum')!;
const altNumEl = document.getElementById('altNum')!;
const mapButtons = Array.from(document.querySelectorAll<HTMLImageElement>('.mapBtn'));
const zoomBtn = document.getElementById('btnZoom') as HTMLImageElement;

// -- state -------------------------------------------------------------------

/** The latest fix from the simulator; null until the first one arrives. */
let fix: MapFix | null = null;
let zoom = 13;
let cssW = 0, cssH = 0;

const icon = new Image();
icon.src = ICON_URL;
const ringIcon = new Image();
ringIcon.src = RING_URL;
/** The green marks that sit round the compass ring — green_icon.png. */
const greenIcon = new Image();
greenIcon.src = './icons/green_icon.png';
/**
 * THE LIT QUADRANTS, one file for each way a threat can lie. They are the
 * same drawing as green_icon.png with one sector burning green, and they are
 * laid down on exactly the same spot and at exactly the same size, so the
 * cross and the circle fall on themselves and only the glow is added.
 *
 * In the order of the compass round the aircraft's own nose.
 */
const GREEN_GLOW_FILES = [
  'Full_front green',    // dead ahead
  'right_front green',   // ahead and to the right
  'Full_ right green',   // abeam right
  'right_under green',   // behind and to the right
  'Full_under green',    // dead astern
  'left_under green',    // behind and to the left
  'Full_ left green',    // abeam left
  'left_front green',    // ahead and to the left
];
const greenGlowArt = new Map<string, HTMLImageElement>();
function greenGlow(name: string): HTMLImageElement {
  const had = greenGlowArt.get(name);
  if (had) return had;
  const img = new Image();
  img.src = `./icons/${encodeURIComponent(name)}.png`;   // the names carry spaces
  greenGlowArt.set(name, img);
  return img;
}

/**
 * WHICH WAY A THREAT LIES from the aircraft, as one of the eight files above.
 *
 * The angle is measured from the NOSE and round to the right, and the circle
 * is cut into eight equal slices of 45°, each centred on its own name: a
 * threat within 22.5° of straight ahead is 'front', one between 22.5° and
 * 67.5° is 'front and right', and so on round.
 */
function greenSector(lat: number, lon: number): string {
  const kx = Math.cos((mapLat * Math.PI) / 180);
  const bearing = Math.atan2((lon - mapLon) * kx, lat - mapLat);
  let off = bearing - mapHeading;                     // 0 is off the nose
  while (off > Math.PI) off -= 2 * Math.PI;
  while (off < -Math.PI) off += 2 * Math.PI;
  const slice = Math.round((off / (2 * Math.PI)) * 8);   // −4…4, 0 = ahead
  return GREEN_GLOW_FILES[((slice % 8) + 8) % 8];
}
/** The beam out of the nose — Ellipse.png, apex at the aircraft. */
const beamIcon = new Image();
beamIcon.src = './icons/Ellipse.png';
/** The wingman's own artwork — the cyan jet that holds formation. */
const friendIcon = new Image();
friendIcon.src = './icons/Friend.png';

/**
 * WHERE THE AIRCRAFT SITS on the map, as a fraction of the map's height:
 * 0 is the top edge, 0.5 the middle, 1 the bottom. It is set in map.html
 * (--map-aircraft-y) and read here, so the one number moves the symbol, the
 * centre the map scrolls around and the point it turns about, together.
 */
function aircraftFrac(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--map-aircraft-y'));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.75;
}
/** That fraction as a pixel position down the map. */
const aircraftY = (): number => cssH * aircraftFrac();

/** The map's own heading (rad), eased towards the aircraft's. Easing it here
 *  rather than snapping to each fix is what keeps the ground from twitching
 *  under the aircraft; the symbol never moves at all. */
let mapHeading = 0;
let haveMapHeading = false;
/** Share of the remaining difference the map turns through each frame. */
const HEADING_EASE = 0.12;

/** THE MAP'S OWN POSITION, eased towards the aircraft's the same way.
 *
 *  Fixes arrive twenty times a second while the screen draws sixty: left to
 *  itself the ground would advance in twenty jerks a second, which the eye
 *  reads on anything with a hard edge — a name plate above all, since its
 *  letters sit still and then jump. Easing towards each fix instead spreads
 *  the movement over the frames in between, so everything slides. The cost is
 *  a lag of a few hundredths of a second, which nothing on this map depends
 *  on; a jump of more than JUMP_DEG (a respawn, a restart) is taken at once
 *  rather than flown across. */
let mapLat = 0;
let mapLon = 0;
let haveMapPos = false;
const POS_EASE = 0.25;
const JUMP_DEG = 0.02;   // about 2 km: further than any fix-to-fix step

// -- web-mercator ------------------------------------------------------------
// Standard slippy-map math: the whole world is 2^zoom tiles across, x grows
// east and y grows south. Fractional tile coordinates are what the drawing
// works in — one unit = one tile = TILE pixels.

const tileX = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;
/** The way back: a fractional tile coordinate to the degrees it stands for. */
const lonFromTileX = (x: number, z: number): number => (x / 2 ** z) * 360 - 180;
const latFromTileY = (y: number, z: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
function tileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

// -- tiles -------------------------------------------------------------------

/** Tiles already requested, by "z/x/y". A null value = that tile 404'd. */
const tiles = new Map<string, HTMLImageElement | null>();

/**
 * The image for one tile, or null while it is still on its way. Each tile is
 * requested once; when it arrives the map is redrawn, so tiles appear as they
 * land instead of blocking the first frame.
 */
function tile(z: number, x: number, y: number): HTMLImageElement | null {
  const key = `${z}/${x}/${y}`;
  const have = tiles.get(key);
  if (have !== undefined) return have;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { draw(); };
  img.onerror = () => { tiles.set(key, null); };
  img.src = TILE_URL.replace(':zoom:', String(z)).replace(':x:', String(x)).replace(':y:', String(y));
  tiles.set(key, img);
  return img;
}

/**
 * ASK AGAIN FOR THE TILES THAT DID NOT COME DOWN.
 *
 * A tile whose fetch failed is remembered as null and never asked for again,
 * so one busy moment at the start leaves a blank patch on the map for the
 * rest of the flight. Every TILE_RETRY_S the nulls are simply forgotten:
 * the next frame asks for those tiles afresh, and they fill in as they
 * arrive.
 *
 * NOTHING THAT IS ALREADY THERE IS TOUCHED — a tile that came down stays
 * exactly as it is — so there is nothing to see. A patch that was blank goes
 * on being blank until its picture lands.
 */
const TILE_RETRY_S = 60;
window.setInterval(() => {
  let missing = 0;
  for (const [key, img] of tiles) if (img === null) { tiles.delete(key); missing++; }
  if (missing) dirty = true;
}, TILE_RETRY_S * 1000);

/** Is this image ready to be drawn? (A tile that errored is stored as null.) */
const ready = (img: HTMLImageElement | null): img is HTMLImageElement => !!img && img.complete && img.naturalWidth > 0;

// -- drawing -----------------------------------------------------------------

/** The screen's own pixel grid, as a multiple of one CSS pixel. Kept so that
 *  text can be put down on whole device pixels — see drawWaypointLabel. */
let dpr = 1;

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  // The canvas is laid out under the top panel, so its own box — not the
  // window — is what the map is drawn into and centred in.
  cssW = canvas.clientWidth;
  cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

function draw(): void {
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#0B1220';
  ctx.fillRect(0, 0, cssW, cssH);
  if (!fix) return;

  // The aircraft sits at the centre of the screen; everything else is placed
  // relative to it, in fractional tile units scaled by TILE. The position
  // drawn is the map's own eased one, not the raw fix — see POS_EASE.
  const here = { ...fix, lat: mapLat, lon: mapLon };
  const cx = tileX(here.lon, zoom);
  const cy = tileY(here.lat, zoom);
  const anchorY = aircraftY();
  lastFrame = { cx, cy, anchorY };          // so a press can be read back
  const screenX = (tx: number): number => cssW / 2 + (tx - cx) * TILE;
  const screenY = (ty: number): number => anchorY + (ty - cy) * TILE;

  // EVERYTHING GEOGRAPHIC is drawn inside this rotation — the imagery and both
  // halves of the path — so the ground turns as one piece around the aircraft.
  // The symbol is drawn after it is lifted, and so stays upright.
  ctx.save();
  // The map turns about the AIRCRAFT, not about the middle of the screen.
  ctx.translate(cssW / 2, anchorY);
  ctx.rotate(-mapHeading); // heading up the screen
  ctx.translate(-cssW / 2, -anchorY);

  // Imagery. A rotated viewport can expose any corner of itself, so the tiles
  // are taken from a square that covers the screen's DIAGONAL, not its sides.
  const n = 2 ** zoom;
  // Far enough from the aircraft to cover the furthest corner once rotated.
  const reach = (Math.hypot(cssW, Math.max(anchorY, cssH - anchorY) * 2) / 2) / TILE + 1;
  const x0 = Math.floor(cx - reach);
  const x1 = Math.floor(cx + reach);
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(n - 1, Math.floor(cy + reach));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wrapped = ((tx % n) + n) % n; // the map wraps around the date line
      const img = tile(zoom, wrapped, ty);
      if (!ready(img)) continue;
      // +1 px of overlap: without it the seams between tiles shimmer through
      // on fractional device-pixel positions.
      ctx.drawImage(img, screenX(tx), screenY(ty), TILE + 1, TILE + 1);
    }
  }

  ctx.restore();

  // The compass rose is the FIRST thing over the imagery and under everything
  // else: the route, the areas, the marks, the wingman and the aircraft are
  // all drawn on top of it.
  drawCompass(anchorY);

  // The areas go down next, flat on the ground under everything but the rose:
  // they are pieces of land, not marks on the glass.
  drawAreas(here, cx, cy, anchorY);

  // The route is drawn OUT of the rotation, from projected screen positions:
  // the line and the rings turn with the ground either way, but the labels
  // have to stay upright however the map is turned.
  drawRoute(here, cx, cy, anchorY);

  // The release envelope goes OVER the line on purpose: the picture is
  // see-through where it is filled, so the route reads on through it and is
  // plainly underneath. Then the line from the envelope out to the mark —
  // before the marks themselves, so the mark covers the end of it.
  drawZone(here, cx, cy, anchorY);
  drawZoneLine(here, cx, cy, anchorY);

  drawTargets(here, cx, cy, anchorY);
  drawTd(cx, cy, anchorY);
  drawFriend(cx, cy, anchorY);
  drawAircraft();
  drawCue(cx, cy, anchorY);
}

// -- the weapon cue ----------------------------------------------------------
/**
 * THE THREE RINGS, one after the other, once the aircraft is past a waypoint.
 *
 * Flying past the waypoint named by --cue-waypoint (4 means 4A) starts a
 * sequence on the right-hand side of the map: nothing for a moment, then
 * SEARCHING, then TRACKING, then LAUNCH, then nothing again. All three sit in
 * exactly the same place and the same size — only the picture changes.
 *
 * "Past" is measured ALONG THE ROUTE, not by distance to the waypoint itself,
 * so passing it wide, left or right of the line, still counts: the aircraft's
 * place is projected onto the route and compared with the waypoint's.
 *
 * Each knob in map.html, with the times in seconds:
 *   --cue-waypoint  which waypoint starts it (4 = 4A); 0 switches it off
 *   --cue-offset    metres along the route from that waypoint to the line
 *                   that actually starts it: plus further on, minus short of
 *   --cue-delay     the wait after crossing it, before the first ring
 *   --cue-opacity   how strongly the rings are drawn, 100% as the files are
 *   --cue-searching / --cue-tracking / --cue-launch   how long each one shows
 *   --cue-size      how big
 *   --cue-x / --cue-y   where they first appear: right of the aircraft, and
 *                       above it, in design px. That place is read ONCE, as a
 *                       place on the GROUND, and they stay on it: the map
 *                       carries them along as it moves, so the aircraft flies
 *                       past them and in time they leave the screen behind.
 */
type CuePhase = 'searching' | 'tracking' | 'launch';

/**
 * ONE SET OF RINGS PER THREAT. The pictures are named for the threat they
 * belong to — searching_icon_ring_22.png and so on — and a cue says which set
 * it uses. The plain three, with no tail to their names, are a set like any
 * other. Each set is fetched the first time a cue asks for it and kept.
 */
const cueArt = new Map<string, Record<CuePhase, HTMLImageElement>>();
function cueImages(set: string): Record<CuePhase, HTMLImageElement> {
  const had = cueArt.get(set);
  if (had) return had;
  const load = (name: string) => {
    // NOT UNPACKED ON THE PAGE'S OWN THREAD. These are ninety-five million
    // pixels each; unpacked the usual way the screen stops dead for a second
    // or two while it happens, which is what came just before the first ring.
    //
    // So the picture is NOT given to this element at all. The element is only
    // a name to file the working copy under; the file itself is fetched and
    // shrunk away from the page, and the small copy is what is ever drawn.
    // (If that fails, and only then, the picture is given to the element in
    // the ordinary way as a last resort.)
    const img = new Image();
    img.decoding = 'async';
    smallFromFile(`./icons/${name}_icon_ring${set}.png`, img);
    return img;
  };
  const made = { searching: load('searching'), tracking: load('tracking'), launch: load('Launch') };
  cueArt.set(set, made);
  return made;
}

/**
 * THE SOUND THAT GOES WITH EACH RING.
 *
 * One file per stretch, played at the very moment its ring comes up — the
 * sound is started from the same frame that first draws the picture, so the
 * two cannot drift apart.
 *
 * A browser will not let a page make a noise before the person has touched
 * it, so the first click or key anywhere in the map window arms the sounds
 * (each is started and stopped again, silently, which is what a browser
 * accepts as permission). Until then nothing is heard and nothing breaks.
 */
const cueSounds: Record<'searching' | 'tracking' | 'launch', HTMLAudioElement> = {
  searching: new Audio('./SEARCH 1. GRND.mp3'),
  tracking: new Audio('./TRACKING 1. GRND.mp3'),
  launch: new Audio('./MS 1. GRND.mp3'),
};
for (const sound of Object.values(cueSounds)) sound.preload = 'auto';

let cueSoundsArmed = false;
function armCueSounds(): void {
  if (cueSoundsArmed) return;
  cueSoundsArmed = true;
  for (const sound of Object.values(cueSounds)) {
    const was = sound.volume;
    sound.volume = 0;
    sound.play().then(() => {
      sound.pause();
      sound.currentTime = 0;
      sound.volume = was;
    }).catch(() => { sound.volume = was; });
  }
}
addEventListener('pointerdown', armCueSounds, { once: true });
addEventListener('keydown', armCueSounds, { once: true });

function playCueSound(phase: CuePhase): void {
  if (cssNumber('--cue-sound', 1) === 0) return;
  const sound = cueSounds[phase];
  sound.volume = Math.max(0, Math.min(1, cssNumber('--cue-volume', 100) / 100));
  sound.currentTime = 0;
  // A browser that has not been touched yet simply refuses; nothing else
  // depends on this, so the refusal is let go.
  sound.play().catch(() => {});
}

/**
 * THE CUES THE MAP IS WATCHING.
 *
 * The flight plan says where each one stands and how far along the route the
 * aircraft must be for it to begin (see CUES in demo/main.ts); this end keeps
 * the clock for each, draws its rings on its own spot of ground, and sounds
 * its three sounds as they come up. Several may be running at once.
 */
interface CueLive {
  set: string;
  lat: number;
  lon: number;
  gate: number;              // metres along the route where it begins
  started: number;           // performance.now(), or 0 before it does
  sounded: CuePhase | null;  // the stretch whose sound has been played
  // Times this cue was given in the flight plan, in seconds. Where one is
  // missing the map's own knob stands in, so a plan that says nothing about
  // times behaves exactly as it did before.
  delay?: number;
  searching?: number;
  tracking?: number;
  launch?: number;
}

let cues: CueLive[] = [];
/** The run they belong to — a respawn arms them all again. */
let cueRunId = -1;

/** Called on every fix: set the list up, and start any the aircraft has
 *  drawn level with. */
function updateCue(f: MapFix): void {
  const plan = f.cues ?? [];
  const sameList = cues.length === plan.length
    && cues.every((c, i) => c.set === plan[i].set && c.gate === plan[i].gate
      && c.lat === plan[i].lat && c.lon === plan[i].lon
      && c.delay === plan[i].delay && c.searching === plan[i].searching
      && c.tracking === plan[i].tracking && c.launch === plan[i].launch);
  if (f.runId !== cueRunId || !sameList) {
    cueRunId = f.runId;
    cues = plan.map((c) => ({ ...c, started: 0, sounded: null }));
    // ASKED FOR THE MOMENT THE PLAN ARRIVES, which is long before the
    // aircraft reaches the first gate: the pictures are fetched and shrunk
    // while there is nothing else going on, so the ring comes up on a copy
    // that is already waiting rather than stopping the screen to make one.
    for (const cue of cues) cueImages(cue.set);
  }
  const points = f.route ?? [];
  if (points.length < 2) return;
  // How far along the route the aircraft is, in metres — the same measure the
  // plan gives each cue, so the two can simply be compared.
  const along = alongRoute(points, f) * 111_320;
  for (const cue of cues) {
    if (!cue.started && along >= cue.gate) cue.started = nowHeld();
  }
}

/**
 * How long one stretch of one cue lasts, in seconds.
 *
 * The flight plan may give a cue its own time for any of the four stretches
 * (see CUES in demo/main.ts). Where it does, that time wins; where it says
 * nothing, the knob in map.html is used, so every set that was never given a
 * time of its own keeps running on the shared one.
 */
function cueSpan(cue: CueLive, part: 'delay' | 'searching' | 'tracking' | 'launch'): number {
  const mine = cue[part];
  const knob = { delay: 2, searching: 3, tracking: 3, launch: 10 }[part];
  return typeof mine === 'number' ? Math.max(0, mine) : cssNumber(`--cue-${part}`, knob);
}

/** How long one cue's whole sequence lasts, in seconds. */
function cueLength(cue: CueLive): number {
  return cueSpan(cue, 'delay') + cueSpan(cue, 'searching')
    + cueSpan(cue, 'tracking') + cueSpan(cue, 'launch');
}

/**
 * THE CLOCK THE THREATS RUN ON, AND WHY IT IS NOT THE WALL'S.
 *
 * A threat knows the moment it began and reads the time to see which stretch
 * it is in. While everything is held, that reading must not move — or the
 * screen walks on through searching, tracking and launch with nothing else
 * moving at all, and then jumps back to where it really was when the hold
 * ends. So the hold STOPS this clock where it stands; when it ends, the
 * moment each threat began is carried forward by however long the hold
 * lasted, and it goes on from exactly the stretch it was in.
 */
function nowHeld(): number {
  return paused ? heldAt : performance.now();
}

/** True while any cue still has something to show — the map redraws for them,
 *  so the rings change over on time whatever the aircraft is doing. */
function cueRunning(): boolean {
  const now = nowHeld();
  return cues.some((c) => c.started && now - c.started < cueLength(c) * 1000);
}

/** Which stretch a cue is in, and the picture that goes with it. */
function cuePhase(cue: CueLive): { phase: CuePhase; image: HTMLImageElement } | null {
  if (!cue.started) return null;
  const t = (nowHeld() - cue.started) / 1000;
  const art = cueImages(cue.set);
  const spans: [number, CuePhase][] = [
    [cueSpan(cue, 'searching'), 'searching'],
    [cueSpan(cue, 'tracking'), 'tracking'],
    [cueSpan(cue, 'launch'), 'launch'],
  ];
  let until = cueSpan(cue, 'delay');
  if (t < until) return null;
  for (const [span, phase] of spans) {
    until += span;
    if (t < until) return { phase, image: art[phase] };
  }
  return null;
}

/**
 * THE LINE BETWEEN THE CUE AND THE AIRCRAFT.
 *
 * From the moment TRACKING comes up, a straight line joins the middle of the
 * cue — the little badge at the heart of the ring — to the compass ring round
 * the aircraft, touching it at whatever angle the aircraft happens to lie.
 * One end is pinned to the ground with the cue, the other rides the aircraft,
 * so the line swings and stretches as the aircraft flies on or turns away.
 *
 * It is drawn as two strokes in the same place: a black one, wider, and the
 * coloured one over it — which leaves an even black edge either side. Where it
 * meets the ring sits a dot, centred ON the ring's line.
 *
 * The LAUNCH stretch has knobs of its own (--cueline-launch-*), which simply
 * follow the tracking ones until they are given values.
 */
/**
 * A WORKING COPY OF EACH CUE PICTURE, AT A SIZE A SCREEN CAN USE.
 *
 * The artwork is 9594 by 9914 — ninety-five million pixels — and it is drawn
 * about four hundred across. Handing the browser the whole of it on every
 * frame costs some thirty milliseconds a frame, and the first frame of each
 * new one costs the best part of a second while it is unpacked and handed to
 * the card: that is the catch at every change of stretch, and the heaviness
 * in between.
 *
 * So each picture is shrunk ONCE, as it arrives — while the map is still
 * waiting for the simulator and nothing else is going on — and the small
 * copy is what is drawn from then on. --cue-art-px is how big that copy is;
 * it only has to beat the size the ring is drawn at, which is a few hundred
 * pixels even on a large screen at twice the density.
 */
const cueSmalls = new Map<HTMLImageElement, CanvasImageSource>();
const cueShrinking = new Set<HTMLImageElement>();

/**
 * The working copy, if it is ready — otherwise the picture itself, but ONLY
 * where it was given one as a last resort. Nothing at all until then, which
 * is right: drawing the big picture is what unpacks it, and unpacking it is
 * the second of nothing this is all here to avoid. A cue simply waits a
 * moment for its copy, which is far less than it waits for the file.
 */
function cueSmall(img: HTMLImageElement): CanvasImageSource | null {
  return cueSmalls.get(img) ?? (ready(img) ? img : null);
}

/**
 * THE COPY IS MADE FROM THE FILE ITSELF, NOT FROM THE PICTURE ON THE PAGE.
 *
 * Handing createImageBitmap a picture the page has already taken in means
 * the page has to unpack it first, and unpacking ninety-five million pixels
 * on its own thread is the second or two of nothing. Given the file instead
 * — fetched and handed over as it came off the wire — the unpacking and the
 * shrinking both happen away from the page, which goes on drawing as if
 * nothing were happening, and simply starts using the copy when it arrives.
 */
function smallFromFile(url: string, key: HTMLImageElement): void {
  if (cueSmalls.has(key) || cueShrinking.has(key)) return;
  cueShrinking.add(key);
  const px = Math.max(256, cssNumber('--cue-art-px', 2048));
  fetch(url)
    .then((r) => r.blob())
    .then((blob) => createImageBitmap(blob, {
      resizeWidth: px, resizeHeight: px, resizeQuality: 'high',
    }))
    .then((bitmap) => {
      cueSmalls.set(key, bitmap);
      cueShrinking.delete(key);
      cueBadgeFrom(key, bitmap, bitmap.width, bitmap.height);
      dirty = true;
    })
    .catch(() => {
      cueShrinking.delete(key);
      if (!key.src) key.src = url;              // the ordinary way, as a last resort
    });
}

/**
 * THE SOLID PART OF A CUE'S PICTURE — the badge at its middle, and nothing
 * else — kept as a picture of its own so it can be laid back over the line.
 *
 * It is cut from the WORKING COPY above, not from the file: that copy is a
 * couple of thousand pixels across and already to hand, while reading the
 * middle of the file itself means unpacking ninety-five million pixels first,
 * and that is a second of nothing.
 *
 * ONLY THE MIDDLE IS CUT. The badge lives within CUE_BADGE_SHARE of the
 * middle, so that little square is the only part taken.
 *
 * Where it belongs is kept as a SHARE of the picture — a number between
 * nought and one — and not in pixels, so it goes back in exactly the right
 * place whatever size the copy happens to be and whatever size the ring is
 * drawn at.
 */
const CUE_BADGE_SHARE = 500 / 9594;      // how far out from the middle it reaches
interface CueBadge { art: HTMLCanvasElement; fx: number; fy: number; fw: number; fh: number }
const cueBadges = new Map<HTMLImageElement, CueBadge | null>();

/** Cut the badge out of `src`, and keep it against the picture it came from. */
function cueBadgeFrom(key: HTMLImageElement, src: CanvasImageSource, w: number, h: number): void {
  const reach = Math.max(1, Math.round(Math.min(w, h) * CUE_BADGE_SHARE));
  const left = Math.max(0, Math.round(w / 2 - reach));
  const top = Math.max(0, Math.round(h / 2 - reach));
  const side = Math.max(1, Math.min(reach * 2, w - left, h - top));
  const cut = document.createElement('canvas');
  cut.width = side;
  cut.height = side;
  const g = cut.getContext('2d', { willReadFrequently: true });
  if (!g) { cueBadges.set(key, null); return; }
  g.drawImage(src, left, top, side, side, 0, 0, side, side);
  const pic = g.getImageData(0, 0, side, side);
  const d = pic.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 200) d[i] = 0;
  g.putImageData(pic, 0, 0);
  cueBadges.set(key, { art: cut, fx: left / w, fy: top / h, fw: side / w, fh: side / h });
}

/**
 * The badge, if there is one yet. Normally it was cut the moment the working
 * copy arrived; if that never came — the file could not be fetched — it is
 * cut from the picture on the page instead, once, as a last resort.
 */
function cueBadge(img: HTMLImageElement): CueBadge | null {
  const had = cueBadges.get(img);
  if (had !== undefined) return had;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;                   // not loaded yet: ask again
  cueBadgeFrom(img, img, w, h);
  return cueBadges.get(img) ?? null;
}

function drawCueLine(from: { x: number; y: number }, phase: 'tracking' | 'launch'): void {
  const scale = uiScale();
  const at = (name: string, fallbackNumber: number): number =>
    cssNumber(`--cueline-${phase === 'launch' ? 'launch-' : ''}${name}`, fallbackNumber) * scale;
  const colour = (name: string, fallback: string): string =>
    cssText(`--cueline-${phase === 'launch' ? 'launch-' : ''}${name}`, fallback);

  const aircraft = { x: cssW / 2, y: aircraftY() };
  const ring = ringCentre();
  const size = cssNumber('--aircraft-size', ICON_SIZE_DEFAULT) * scale;
  // The ring as it is drawn: its own radius in the artwork, scaled the way
  // the artwork is, so the line stops exactly on the ring the eye sees.
  const ringRadius = ring && ready(ringIcon)
    ? (ring.r / ringIcon.naturalWidth) * ((size * cssNumber('--ring-size', 98)) / 100)
    : size * 0.28;

  const dx = from.x - aircraft.x;
  const dy = from.y - aircraft.y;
  const away = Math.hypot(dx, dy);
  if (away < ringRadius + 1) return;            // the cue is inside the ring
  // Where the line meets the ring: straight towards the cue, one radius out.
  const touch = {
    x: aircraft.x + (dx / away) * ringRadius,
    y: aircraft.y + (dy / away) * ringRadius,
  };

  ctx.save();
  ctx.lineCap = 'butt';
  // the black beneath, then the colour over it
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(touch.x, touch.y);
  ctx.strokeStyle = colour('casing-color', '#000000');
  ctx.lineWidth = at('casing', 4);
  ctx.stroke();
  ctx.strokeStyle = colour('color', '#FFCC00');
  ctx.lineWidth = at('width', 2);
  ctx.stroke();
  // the dot, centred on the ring's own line
  const dot = at('dot', 12);
  const edge = at('dot-stroke', 1.5);
  ctx.beginPath();
  ctx.arc(touch.x, touch.y, Math.max(0, dot / 2 - edge / 2), 0, Math.PI * 2);
  ctx.fillStyle = colour('dot-color', '#FFCC00');
  ctx.fill();
  ctx.lineWidth = edge;
  ctx.strokeStyle = colour('dot-stroke-color', '#000000');
  ctx.stroke();
  ctx.restore();
}

function drawCue(cx: number, cy: number, anchorY: number): void {
  if (!cues.length) return;
  const scale = uiScale();
  const size = cssNumber('--cue-size', 420) * scale;
  const fade = Math.max(0, Math.min(1, cssNumber('--cue-opacity', 100) / 100));

  for (const cue of cues) {
    const now = cuePhase(cue);
    if (!now) continue;
    // The sound belongs to the stretch, not to the picture: it starts even if
    // the artwork has not finished loading, so the two never fall out of step.
    if (cue.sounded !== now.phase) {
      cue.sounded = now.phase;
      playCueSound(now.phase);
    }
    const art = cueSmall(now.image);
    if (!art) continue;

    // Each cue stands on its own spot of ground: the map carries it along as
    // it moves, the aircraft flies past it, and it never turns.
    const p = project(cue.lat, cue.lon, cx, cy, anchorY);
    ctx.save();
    ctx.globalAlpha = fade;
    // The ring goes down first and the line over it, so the line reads from
    // the middle of the cue — except over the badge at the very middle, where
    // the line is simply not drawn, so it comes out from under the badge and
    // passes over everything else.
    //
    // The hole is cut out of the LINE rather than the badge being laid back
    // over it. Laying it back over would paint that circle of the artwork
    // twice, and the artwork there is see-through: painted on itself it comes
    // out denser than the ring around it, which reads as a disc sitting under
    // the middle of the picture.
    ctx.drawImage(art, p.x - size / 2, p.y - size / 2, size, size);
    if (now.phase === 'tracking' || now.phase === 'launch') {
      drawCueLine(p, now.phase);
      // …and the badge goes back on top of it, in its own shape. Cutting a
      // ROUND hole in the line instead, as this used to, can only ever be
      // the wrong size: the badge is a rounded oblong and a different one in
      // each of the three pictures, so a circle that clears its corners
      // leaves the line stopping short of its sides — a gap between the line
      // and the badge, which is what showed. Laid back over, the badge ends
      // the line exactly where the badge's own edge is, whichever way the
      // line comes in.
      //
      // Only the SOLID part of the picture is laid back, which is why this
      // costs nothing: solid pixels drawn twice come out exactly as they
      // were, while the see-through ring and area — which would darken if
      // they were painted over themselves — are not touched.
      const badge = cueBadge(now.image);
      if (badge) {
        // Back in its own place: the big picture is drawn into a square of
        // `size`, so the little one goes where its own corner falls in that.
        ctx.drawImage(
          badge.art,
          p.x - size / 2 + badge.fx * size, p.y - size / 2 + badge.fy * size,
          badge.fw * size, badge.fh * size,
        );
      }
    }
    ctx.restore();
  }
}

/**
 * THE AREAS, lying on the ground.
 *
 * Where a target is a MARK — the same size on the screen whatever the zoom,
 * always upright — an area is a piece of LAND. So it is drawn differently in
 * two ways: its size is given in metres and turned into pixels at the zoom of
 * the moment, which makes it grow and shrink with the map; and it is turned
 * with the ground, so the direction it was given is a compass direction and it
 * holds that direction however the aircraft is pointing.
 *
 * The middle of the picture stands on the spot. Everything else about it —
 * where it is, how wide, which way round — is the AREAS list in demo/main.ts;
 * --area-* in map.html only says how strongly it is drawn.
 */
const areaArt = new Map<string, HTMLImageElement>();
function areaImage(file: string): HTMLImageElement {
  const had = areaArt.get(file);
  if (had) return had;
  const img = new Image();
  img.src = `./icons/${encodeURIComponent(file)}.png`;
  areaArt.set(file, img);
  return img;
}

/** How many metres of ground one screen pixel covers, here and at this zoom. */
function metresPerPixel(lat: number): number {
  return (156_543.033_928 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom * (256 / TILE);
}

function drawAreas(f: MapFix, cx: number, cy: number, anchorY: number): void {
  const marks = f.areas ?? [];
  if (!marks.length || cssNumber('--area-show', 1) === 0) return;
  const alpha = Math.max(0, Math.min(1, cssNumber('--area-opacity', 100) / 100));
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const mark of marks) {
    const img = areaImage(mark.file);
    if (!ready(img)) continue;
    // Metres to pixels at this zoom: the area breathes with the map.
    const width = mark.width / metresPerPixel(mark.lat);
    const height = (width * img.naturalHeight) / img.naturalWidth;
    const p = project(mark.lat, mark.lon, cx, cy, anchorY);
    ctx.save();
    ctx.translate(p.x, p.y);
    // The map is already turned track-up; turning by the area's own compass
    // direction on top of that leaves it lying the way the ground lies.
    ctx.rotate(-mapHeading + (mark.turn * Math.PI) / 180);
    ctx.drawImage(img, -width / 2, -height / 2, width, height);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * THE WINGMAN, Friend.png, holding formation.
 *
 * He is not flown: he flies the lead's own track, a moment late. Every fix is
 * written down — where the aircraft was and which way it was pointing — and
 * the wingman is drawn at the place the aircraft held --friend-delay seconds
 * ago, moved --friend-back metres further back along that old heading and
 * --friend-side metres out to the side of it.
 *
 * Doing it that way, rather than by holding a fixed place on the screen, is
 * what makes him behave like an aircraft: through a turn he cuts the corner
 * late, exactly as a man holding formation does, and he is pointing the way
 * the lead was pointing when it was there — not the way it is pointing now.
 *
 * The trail is kept in lat/lon, so he is pinned to the ground between fixes
 * like everything else: the map carries him, and the zoom does not move him.
 */
interface LeadStep { t: number; lat: number; lon: number; hdg: number; spd: number }
const leadTrack: LeadStep[] = [];
let leadRunId = -1;
/** As long a memory as the delay could ever ask for, in milliseconds. */
const LEAD_MEMORY_MS = 60_000;

function rememberLead(f: MapFix): void {
  if (f.runId !== leadRunId) { leadRunId = f.runId; leadTrack.length = 0; }
  const now = performance.now();
  leadTrack.push({
    t: now, lat: f.lat, lon: f.lon,
    hdg: (f.headingDeg * Math.PI) / 180,
    spd: f.speedKt * 0.514_444,          // knots to metres a second
  });
  while (leadTrack.length > 1 && now - leadTrack[0].t > LEAD_MEMORY_MS) leadTrack.shift();
}

/**
 * Where the lead was `ms` milliseconds ago, between the two fixes that
 * straddle that moment.
 *
 * AT THE START there is no such moment — the flight is younger than the delay
 * — and standing the wingman on the first fix would leave him parked on the
 * runway watching the lead go, which is not what a formation looks like. So
 * for a moment BEFORE the first fix, the track is carried backwards instead:
 * the lead is taken to have been flying the same way at the same speed, and
 * the wingman is already in his place and already moving on the first frame.
 */
function leadWas(ms: number): LeadStep | null {
  if (!leadTrack.length) return null;
  const want = performance.now() - ms;
  const first = leadTrack[0];
  if (want <= first.t) {
    const missing = (first.t - want) / 1000;       // seconds short of the trail
    const run = missing * first.spd;               // how far back that is
    const kx = Math.cos((first.lat * Math.PI) / 180);
    return {
      ...first,
      t: want,
      lat: first.lat - (run * Math.cos(first.hdg)) / 111_320,
      lon: first.lon - (run * Math.sin(first.hdg)) / 111_320 / kx,
    };
  }
  if (leadTrack.length < 2) return first;
  for (let i = leadTrack.length - 1; i > 0; i--) {
    const b = leadTrack[i];
    const a = leadTrack[i - 1];
    if (want >= a.t && want <= b.t) {
      const k = b.t === a.t ? 0 : (want - a.t) / (b.t - a.t);
      return {
        t: want,
        lat: a.lat + (b.lat - a.lat) * k,
        lon: a.lon + (b.lon - a.lon) * k,
        hdg: a.hdg + angleDelta(a.hdg, b.hdg) * k,
        spd: a.spd + (b.spd - a.spd) * k,
      };
    }
  }
  return leadTrack[leadTrack.length - 1];
}

function drawFriend(cx: number, cy: number, anchorY: number): void {
  if (cssNumber('--friend-show', 1) === 0) return;
  const img = friendIcon;
  if (!ready(img)) return;
  const was = leadWas(cssNumber('--friend-delay', 2) * 1000);
  if (!was) return;

  // Back along the old heading, and out to its side: plus is LEFT, as it is
  // everywhere else in this project.
  const back = cssNumber('--friend-back', 0);
  const side = cssNumber('--friend-side', 900);
  const kx = Math.cos((was.lat * Math.PI) / 180);
  const dNorth = -back * Math.cos(was.hdg) + side * Math.cos(was.hdg - Math.PI / 2);
  const dEast = -back * Math.sin(was.hdg) + side * Math.sin(was.hdg - Math.PI / 2);
  const lat = was.lat + dNorth / 111_320;
  const lon = was.lon + dEast / 111_320 / kx;

  const size = cssNumber('--friend-size', 120) * uiScale();
  const height = (size * img.naturalHeight) / img.naturalWidth;
  const p = project(lat, lon, cx, cy, anchorY);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, cssNumber('--friend-opacity', 100) / 100));
  ctx.translate(p.x, p.y);
  // Pointing the way the lead was pointing then, seen on a map turned the way
  // the lead is pointing now.
  ctx.rotate(was.hdg - mapHeading);
  ctx.drawImage(img, -size / 2, -height / 2, size, height);
  ctx.restore();
}

/**
 * ══ THE COMPASS ROSE ════════════════════════════════════════════════════════
 *
 * compass.png: the rings and the bearings, drawn about the aircraft's own
 * place on the map. It is the LOWEST thing the map draws over its imagery —
 * the route, the areas, the marks, the wingman and the aircraft itself all
 * come down on top of it, so it reads as being behind the picture rather than
 * over it.
 *
 * ONLY THE OUTER RING TURNS. The bearings are written on the outermost ring,
 * and that one swings so its N lies on true north, as a compass does; the
 * rings inside it carry no bearings and stand still. The picture is drawn
 * twice to do it — once cut to a disc and left alone, once cut to everything
 * outside that disc and turned — with --compass-split saying where the cut
 * falls.
 *
 * Its size is in design px and does not follow the zoom.
 *
 * It is drawn about the aircraft, and the aircraft sits low on the screen,
 * so --compass-shift-y lifts it off that spot to bring more of it into view;
 * the lift is dropped when the aircraft is centred, where there is nothing to
 * make up for.
 */
const compassArt = new Image();
compassArt.addEventListener('load', () => { dirty = true; });
compassArt.src = './icons/compass.png';

function drawCompass(anchorY: number): void {
  if (cssNumber('--compass-show', 1) === 0 || !ready(compassArt)) return;
  const alpha = Math.max(0, Math.min(1, cssNumber('--compass-opacity', 100) / 100));
  if (alpha <= 0) return;
  const scale = uiScale();
  const width = cssNumber('--compass-size', 2_000) * scale;
  const height = (width * compassArt.naturalHeight) / compassArt.naturalWidth;
  const ax = cssNumber('--compass-anchor-x', 50) / 100;
  const ay = cssNumber('--compass-anchor-y', 50) / 100;
  // Lifted off the aircraft's spot while the aircraft is low on the screen,
  // and left where it is when it has been centred.
  const lift = centred ? 0 : cssNumber('--compass-shift-y', 0) * scale;
  const put = (): void => {
    ctx.drawImage(compassArt, -width * ax, -height * ay, width, height);
  };
  const turn = (cssNumber('--compass-with-north', 1) !== 0 ? -mapHeading : 0)
    + (cssNumber('--compass-turn', 0) * Math.PI) / 180;
  // Where the turning ring gives way to the still ones, as a share of the
  // picture's width.
  const split = (cssNumber('--compass-split', 35.6) / 100) * width;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cssW / 2, anchorY + lift);

  // The rings inside the split: still.
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, split, 0, Math.PI * 2);
  ctx.clip();
  put();
  ctx.restore();

  // …and everything outside it: the ring the bearings are written on, turned.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-width, -height, width * 2, height * 2);
  // The pen is lifted on to the circle before it is drawn — see the note in
  // drawCue. Without it the hole has a wedge cut out of it.
  ctx.moveTo(split, 0);
  ctx.arc(0, 0, split, 0, Math.PI * 2);
  ctx.clip('evenodd');
  ctx.rotate(turn);
  put();
  ctx.restore();

  ctx.restore();
}

/**
 * ══ THE RELEASE ENVELOPE ════════════════════════════════════════════════════
 *
 * Pink Zone.png: the stretch of ground a weapon can be let go over. It hangs
 * on ONE WAYPOINT — the one named by --zone-at, AAT as the design has it —
 * with the dot drawn at the middle of the picture on that waypoint, so the
 * envelope sits about the point it belongs to.
 *
 * IT IS THE SAME SIZE ON THE SCREEN whatever the zoom — it is a mark, not a
 * piece of land — but it is LAID ON THE GROUND the way a field is: it turns
 * with the map, so that however the aircraft comes at it, it covers the same
 * ground and nothing of it appears to swing round as the aircraft turns.
 * (--zone-with-ground 0 nails it to the screen instead, which is what it did
 * at first and what made part of it seem to move.)
 *
 * THE WAYPOINT IS NOT ITS MIDDLE. The envelope's own middle is set a little
 * off the waypoint by --zone-shift-x / --zone-shift-y, so the waypoint passes
 * near the middle of the shape without sitting on it — and the line that
 * leaves the middle leaves the middle, not the waypoint, so the two do not
 * read as one thing.
 *
 * It is drawn OVER the route, because the picture is see-through where it is
 * filled and the line is meant to read through it, plainly underneath.
 */
const zoneArt = new Image();
zoneArt.addEventListener('load', () => { dirty = true; });
zoneArt.src = './icons/Pink%20Zone.png';
/** Where the middle of the shape came out on the screen this frame, so the
 *  line that leaves it starts exactly there. Null when it is not drawn. */
let zoneCentre: { x: number; y: number } | null = null;

/** True once the launcher has been struck: the envelope and the line that
 *  reaches it are about a target that is no longer there, so both go. */
function targetGone(f: MapFix): boolean {
  return (f.targets ?? []).some((t) =>
    t.kind === 'truck' && t.strike !== false && destroyed.has(t.id));
}

function drawZone(f: MapFix, cx: number, cy: number, anchorY: number): void {
  zoneCentre = null;
  if (cssNumber('--zone-show', 1) === 0 || !ready(zoneArt)) return;
  // The launcher has been destroyed: there is nothing left to release on,
  // so the envelope goes — and with no middle recorded, so does its line.
  if (targetGone(f)) return;
  const alpha = Math.max(0, Math.min(1, cssNumber('--zone-opacity', 100) / 100));
  if (alpha <= 0) return;
  const name = cssText('--zone-at', 'AAT').replace(/^["']|["']$/g, '');
  const at = (f.route ?? []).find((p) => p.name === name);
  if (!at) return;

  const width = cssNumber('--zone-size', 900) * uiScale();
  const height = (width * zoneArt.naturalHeight) / zoneArt.naturalWidth;
  // Which point of the picture is its MIDDLE — measured off the file, where
  // the dot at its middle sits. That point is what the shift below places,
  // and what the line leaves from.
  const ax = cssNumber('--zone-anchor-x', 49.8) / 100;
  const ay = cssNumber('--zone-anchor-y', 45.4) / 100;
  const p = project(at.lat, at.lon, cx, cy, anchorY);
  // Turned with the ground, so it keeps the same stretch of land however the
  // aircraft comes at it, and then shifted off the waypoint by its own
  // offset — which turns with it, so that too stays over the same ground.
  const ground = cssNumber('--zone-with-ground', 1) !== 0 ? -mapHeading : 0;
  const th = ground + (cssNumber('--zone-turn', 0) * Math.PI) / 180;
  const scale = uiScale();
  const ox = cssNumber('--zone-shift-x', 0) * scale;
  const oy = cssNumber('--zone-shift-y', 0) * scale;
  zoneCentre = {
    x: p.x + ox * Math.cos(th) - oy * Math.sin(th),
    y: p.y + ox * Math.sin(th) + oy * Math.cos(th),
  };

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(zoneCentre.x, zoneCentre.y);
  ctx.rotate(th);
  ctx.drawImage(zoneArt, -width * ax, -height * ay, width, height);
  ctx.restore();
}

/**
 * THE LINE FROM THE ENVELOPE TO THE MARK.
 *
 * It runs from the middle of the filled shape — the same spot the envelope
 * hangs on — to the middle of the launcher's mark, and it is drawn in two
 * passes: a heavier black line first and the pink one over it, which is what
 * gives the pink its black casing. A round pink head sits on the envelope
 * end; the other end is left bare, because the mark itself is drawn
 * afterwards and covers it, so the line reads as coming out from under it.
 */
function drawZoneLine(f: MapFix, cx: number, cy: number, anchorY: number): void {
  if (cssNumber('--zoneline-show', 1) === 0 || !zoneCentre) return;
  const to = (f.targets ?? []).find((t) => t.kind === 'truck' && t.strike !== false);
  if (!to) return;

  const scale = uiScale();
  // From the MIDDLE OF THE SHAPE — not from the waypoint, which is a little
  // off it — to the middle of the mark.
  const a = zoneCentre;
  const b = project(to.lat, to.lon, cx, cy, anchorY);

  ctx.save();
  ctx.lineCap = 'round';
  // The casing first, then the line itself over it.
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = cssText('--zoneline-casing', '#000000');
  ctx.lineWidth = cssNumber('--zoneline-casing-width', 5) * scale;
  ctx.stroke();
  ctx.strokeStyle = cssText('--zoneline-colour', '#FF5FDC');
  ctx.lineWidth = cssNumber('--zoneline-width', 2) * scale;
  ctx.stroke();

  // The head, on the envelope's end.
  const r = (cssNumber('--zoneline-dot', 10) * scale) / 2;
  if (r > 0) {
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fillStyle = cssText('--zoneline-colour', '#FF5FDC');
    ctx.fill();
    ctx.lineWidth = cssNumber('--zoneline-dot-edge', 1.5) * scale;
    ctx.strokeStyle = cssText('--zoneline-casing', '#000000');
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * THE TARGETS, standing on the ground.
 *
 * Each is a picture named for the threat — ta412.png and the like — and it is
 * drawn at its own place on the earth, upright however the map is turned, so
 * it sits on its spot the way a town does: the map slides and turns beneath
 * it, and the aircraft flies past it.
 *
 * The spot is not the middle of the picture: the artwork carries a plate under
 * the mark, so --target-anchor-x / --target-anchor-y say which point of it
 * stands on the ground. Measured off the artwork, that is the middle of the
 * triangle — half way across, a third of the way down.
 *
 * THERE ARE TWO KINDS, and each reads its own family of knobs: the threats,
 * on --target-*, and the struck marks, on --target-after-*. The flight plan
 * says which kind each mark is (see TARGETS in demo/main.ts); nothing else
 * about them differs, so a mark of either kind keeps its spot on the ground
 * in exactly the same way.
 */
const targetArt = new Map<string, HTMLImageElement>();
function targetImage(id: string): HTMLImageElement {
  const had = targetArt.get(id);
  if (had) return had;
  const img = new Image();
  // The map draws when it is told something has changed, and a picture
  // arriving IS a change: without this a mark whose artwork is still on its
  // way would be left out of the frame and stay out until the next fix came
  // in — which, with the simulator's window behind another, can be a long
  // while. This is why a mark seemed to vanish when it was pressed.
  img.addEventListener('load', () => { dirty = true; });
  img.src = `./icons/${id}.png`;
  targetArt.set(id, img);
  return img;
}

/**
 * ══ THE MARK THAT CAN BE PRESSED ════════════════════════════════════════════
 *
 * One kind of mark — 'truck' — is not only drawn but answers a press. It
 * stands on the same spot of ground as the launcher in the simulator, and
 * pressing it on the map swaps its picture for the one with _selected on the
 * end of its name; pressing it again puts the first one back.
 *
 * Knowing WHERE it was pressed means knowing where it was drawn, so every
 * mark that can be pressed writes down the box it took up on the screen as it
 * is drawn, and a press is looked up against those boxes — the last drawn
 * first, so the one on top wins.
 */
const picked = new Set<string>();
interface MarkBox { id: string; x: number; y: number; w: number; h: number }
let markBoxes: MarkBox[] = [];

function markAt(x: number, y: number): string | null {
  for (let i = markBoxes.length - 1; i >= 0; i--) {
    const b = markBoxes[i];
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
  }
  return null;
}

canvas.addEventListener('click', (e) => {
  const box = canvas.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  const hit = markAt(x, y);
  if (!hit) { designate(x, y); return; }    // bare ground: put the box there
  if (picked.has(hit)) picked.delete(hit);
  else picked.add(hit);
  // A mark that is let go takes the camera with it, if it was the one being
  // held: nothing is slaved to a mark that is no longer chosen.
  if (!picked.has(hit) && slavedId === hit) setSlaved(null);
  clearTd();                                // a mark was chosen instead
  dressRowRings();                          // and every list says so too
  dirty = true;
});

/**
 * ══ THE DESIGNATION BOX ═════════════════════════════════════════════════════
 *
 * Press anywhere on the map — bare ground, a waypoint, anything that is not a
 * mark of its own — and TD_box.png is put on that spot: this is the place I
 * mean. It is pinned to the GROUND, so it stays on the spot while the map
 * moves under it, and it is drawn at a fixed size on the screen, as a sight
 * is, rather than growing and shrinking with the zoom.
 *
 * What it is for is the Slave key: press that while the box is up and the
 * belly camera is sent to hold that spot, exactly as it holds a mark. The box
 * then stays for as long as the camera is on it.
 *
 * And if nothing is done with it, it goes: --td-hold seconds after it was put
 * down it simply is not there any more, having got in the way of nothing.
 */
const tdArt = new Image();
tdArt.src = './icons/TD_box.png';
tdArt.addEventListener('load', () => { dirty = true; });

let tdAt: { lat: number; lon: number } | null = null;
let tdTimer = 0;

/** A press on bare ground: the box goes there, and its clock starts. */
function designate(x: number, y: number): void {
  const at = unproject(x, y);
  if (!at) return;
  tdAt = at;
  // Pressing somewhere else while the camera is held on the old spot lets
  // that spot go: the camera follows the box, not the other way about.
  if (slavedTd) setSlaved(null);
  startTdClock();
  dirty = true;
}

/** It waits --td-hold seconds to be used, and then it is gone. */
function startTdClock(): void {
  window.clearTimeout(tdTimer);
  tdTimer = window.setTimeout(() => {
    if (slavedTd) return;                   // in use: it stays
    tdAt = null;
    dirty = true;
  }, Math.max(0, cssNumber('--td-hold', 7)) * 1000);
}

/** Take it away now — because something else was chosen, or the camera that
 *  was holding it has been let go. */
function clearTd(): void {
  window.clearTimeout(tdTimer);
  if (!tdAt) return;
  tdAt = null;
  dirty = true;
}

/** Every frame: the box on its spot, upright and at its own size. */
function drawTd(cx: number, cy: number, anchorY: number): void {
  if (!tdAt || !ready(tdArt)) return;
  const w = cssNumber('--td-size', 92) * uiScale();
  const h = (w * tdArt.naturalHeight) / tdArt.naturalWidth;
  const p = project(tdAt.lat, tdAt.lon, cx, cy, anchorY);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, cssNumber('--td-opacity', 100) / 100));
  ctx.drawImage(tdArt, p.x - w / 2, p.y - h / 2, w, h);
  ctx.restore();
}

/**
 * ══ SLAVING THE CAMERA TO A MARK ════════════════════════════════════════════
 *
 * The key on the left of the bottom panel. Press a mark on the map to pick it
 * out, then press this, and the belly camera is told to hold that spot of
 * ground: the simulator does the pointing, and goes on doing it however the
 * aircraft turns. Press it again and the camera is let go.
 *
 * With no mark picked out the key does nothing at all — there is nothing to
 * hold. Where two marks are picked out, the first of them is taken.
 */
const slaveKey = document.getElementById('slaveKey');
let slavedId: string | null = null;

/**
 * THE PANEL HAS TWO PICTURES: the plain one, and the one drawn with the Slave
 * key lit. Which of them is on screen is the whole of the key's look — there
 * is no lit key laid over a plain one, and so nothing that can sit a hair
 * out of place. The lit one is fetched at the start, so the swap is
 * instant rather than a blink.
 */
const PANEL_PLAIN = './icons/Bottom%20Panel.png';
const PANEL_SLAVED = './icons/Bottom%20Panel_slave.png';
new Image().src = PANEL_SLAVED;

/** True while the camera is holding the designation box rather than a mark. */
let slavedTd = false;

function setSlaved(id: string | null): void {
  slavedId = id;
  slavedTd = false;
  const mark = id ? (fix?.targets ?? []).find((t) => t.id === id) : null;
  tellSlave(mark ? { lat: mark.lat, lon: mark.lon } : null);
}

/** Hold the spot the designation box is on — the box then stays up for as
 *  long as the camera is on it, and its clock is stopped. */
function slaveToTd(): void {
  if (!tdAt) return;
  slavedId = null;
  slavedTd = true;
  window.clearTimeout(tdTimer);
  tellSlave(tdAt);
}

/** Say what the camera is to hold, and dress the panel to match. */
function tellSlave(at: { lat: number; lon: number } | null): void {
  channel.postMessage({ kind: 'slave', at } satisfies SlaveOrder);
  const want = at ? PANEL_SLAVED : PANEL_PLAIN;
  if (!bottomPanelImg.src.endsWith(want.slice(1))) bottomPanelImg.src = want;
  dirty = true;
}

/**
 * ══ THE STRIKE ══════════════════════════════════════════════════════════════
 *
 * The trigger is on the stick, in the other window, and all it sends is that
 * it has been pulled. Everything else happens here, because this is the
 * screen that knows which store was chosen and where the mark stands:
 *
 *   · the store that was blinking on the weapons screen stops — it has gone;
 *   · when the weapon lands, the mark is taken off the map for good.
 *
 * THE BURST IS NOT A PICTURE ANY MORE, and it is not on this screen. It is
 * fire in the WORLD, standing on the truck itself, so it is seen through the
 * camera and from the pilot's own window alike — see THE FIRE in
 * demo/main.ts. Nothing of it is drawn here.
 */
/**
 * THE MARKS THAT HAVE BEEN DESTROYED, by id.
 *
 * THIS IS NOT THE MAP'S OWN TALLY — it is a COPY of the simulator's, handed
 * over with every fix. The simulator counts the weapon's flight time and
 * burns the truck; the map is told which marks are struck and makes its set
 * match, so a mark leaves the map on the same frame the model takes fire and
 * comes back whole on the same frame the model does.
 *
 * Following the list rather than adding to it is what makes START AGAIN
 * safe. The map lets go of everything the moment the key is pressed, but a
 * fix sent a breath earlier — carrying the old list — can still land after
 * that; if this only ever ADDED, that stale word would mark the truck struck
 * for good and nothing would ever clear it again. Following the list, the
 * next fix puts it right.
 */
const destroyed = new Set<string>();

function noteStruck(ids: string[] | undefined): void {
  if (!ids) return;                       // nothing said: leave it as it is
  const struck = new Set(ids);
  for (const id of struck) {
    if (destroyed.has(id)) continue;
    destroyed.add(id);
    picked.delete(id);
    // THE CAMERA IS LEFT WHERE IT IS. If it was slaved to this mark it stays
    // slaved: the fire burns on that very spot for the next few seconds,
    // and letting go here would swing the camera off it at the one moment
    // there is something to see. The Slave key lets go when she does.
    dirty = true;
  }
  // …and a mark the simulator no longer counts as struck is whole again.
  for (const id of destroyed) {
    if (struck.has(id)) continue;
    destroyed.delete(id);
    dirty = true;
  }
}

/**
 * THE TRIGGER, PULLED IN THE OTHER WINDOW — the map's whole share of it.
 *
 * The burst is not the map's business: it burns in the world, where the truck
 * stands, and the simulator sees to it. What the map does on the trigger is
 * let the store go: it is the screen that knows which one was chosen.
 */
function fireWeapon(): void {
  spendPickedWeapon();
}

/**
 * THE SLAVE KEY, pressed either way: the key on the panel under the map, or
 * b6 on the throttle in the other window. Both land here, so the two can
 * never say different things about what the camera is holding.
 */
function pressSlaveKey(): void {
  // Holding something already: let it go. A box that was being held goes
  // with it — it was only ever there to say where to look.
  if (slavedTd) { setSlaved(null); clearTd(); return; }
  if (slavedId) { setSlaved(null); return; }
  // THE BOX FIRST, when one is up: it is the thing just pressed, and taking
  // it is what the press was for. Otherwise the first mark picked out.
  if (tdAt) { slaveToTd(); return; }
  const chosen = (fix?.targets ?? []).find((t) => picked.has(t.id));
  if (chosen) setSlaved(chosen.id);
}

slaveKey?.addEventListener('click', (e) => {
  e.stopPropagation();
  pressSlaveKey();
});

/** The look knobs for one kind of target: --target-* for the threats,
 *  --target-after-* for the struck marks, --target-truck-* for the launcher. */
type TargetKind = 'threat' | 'after' | 'befor' | 'truck';
function targetLook(kind: TargetKind, chosen = false): {
  show: boolean; width: number; ax: number; ay: number; alpha: number;
} {
  const tail = kind === 'threat' ? '' : `-${kind}`;
  if (chosen) {
    // The pressed face is a FILE OF ITS OWN and need not be drawn the same:
    // where the two differ — a frame of brackets round one of them and not
    // the other — these knobs bring the ring in the two to the same size on
    // the same spot, so nothing jumps when it is pressed. Each falls back to
    // the unpressed one, so leaving them alone changes nothing.
    const base = targetLook(kind);
    return {
      show: base.show,
      width: cssNumber(`--target${tail}-sel-size`, base.width / uiScale()) * uiScale(),
      ax: cssNumber(`--target${tail}-sel-anchor-x`, base.ax * 100) / 100,
      ay: cssNumber(`--target${tail}-sel-anchor-y`, base.ay * 100) / 100,
      alpha: Math.max(0, Math.min(1,
        cssNumber(`--target${tail}-sel-opacity`, base.alpha * 100) / 100)),
    };
  }
  // The two square pictures carry their mark in the middle of a wide frame,
  // so they are given a bigger default than the threats and an anchor of
  // their own, both measured off the artwork.
  const square = kind === 'after' || kind === 'befor';
  // The launcher's mark is a ring over a name, and the ring is what stands on
  // the ground: half way across, and a third of the way down.
  const truck = kind === 'truck';
  return {
    show: cssNumber(`--target${tail}-show`, 1) !== 0,
    width: cssNumber(`--target${tail}-size`, square ? 320 : truck ? 90 : 110) * uiScale(),
    ax: cssNumber(`--target${tail}-anchor-x`, 50) / 100,
    ay: cssNumber(`--target${tail}-anchor-y`, square ? 47.8 : truck ? 33 : 32) / 100,
    alpha: Math.max(0, Math.min(1, cssNumber(`--target${tail}-opacity`, 100) / 100)),
  };
}

function drawTargets(f: MapFix, cx: number, cy: number, anchorY: number): void {
  const marks = f.targets ?? [];
  if (!marks.length) return;
  const looks = {
    threat: targetLook('threat'),
    after: targetLook('after'),
    befor: targetLook('befor'),
    truck: targetLook('truck'),
  };
  markBoxes = [];
  ctx.save();
  for (const mark of marks) {
    const kind = mark.kind ?? 'threat';
    // A MARK THAT HAS BEEN DESTROYED still stands on the map — it wears its
    // burnt face instead, truck_icon_after.png. That file is the same size
    // as truck_icon.png and carries its ink in the same place on it, so it
    // is drawn with the very same knobs: one picture simply takes the
    // other's place, same size, same spot, nothing moves. It cannot be
    // pressed or chosen any more.
    // A mark with `strike: false` has no struck face at all, so it is never
    // dead however the release went: it simply stands there.
    const strikeable = mark.strike !== false;
    const dead = strikeable && destroyed.has(mark.id);
    // A mark that can be pressed has two faces, and which one it wears is
    // whether it has been pressed. The pressed one is sized on its own.
    //
    // A STRUCK MARK CAN BE CHOSEN AGAIN, and be struck again — but it keeps
    // its burnt face while it is chosen, since there is no second artwork
    // for a wreck that has been picked out. What says it is chosen is a thin
    // white ring round it, the same ring the lists put round their rows.
    const chosen = !dead && kind === 'truck' && picked.has(mark.id);
    const ringed = dead && kind === 'truck' && picked.has(mark.id);
    const look = chosen ? targetLook('truck', true) : looks[kind];
    if (!look.show) continue;
    const face = dead ? `${mark.id}_after` : chosen ? `${mark.id}_selected` : mark.id;
    // Every face is asked for the first time this mark is drawn, so the one
    // it is not wearing is already in hand when it is pressed or struck and
    // the swap happens in the same frame.
    const img = targetImage(face);
    if (kind === 'truck' && !dead) {
      targetImage(chosen ? mark.id : `${mark.id}_selected`);
      if (strikeable) targetImage(`${mark.id}_after`);
    }
    if (!ready(img)) continue;
    const height = (look.width * img.naturalHeight) / img.naturalWidth;
    const p = project(mark.lat, mark.lon, cx, cy, anchorY);
    const x = p.x - look.width * look.ax;
    const y = p.y - height * look.ay;
    ctx.globalAlpha = look.alpha;
    ctx.drawImage(img, x, y, look.width, height);
    if (ringed) {
      // Never thinner than a pixel: on a small screen the knob's 1.5 design
      // px comes out at a third of one, which draws as a grey hair or as
      // nothing at all.
      const edge = Math.max(1, cssNumber('--row-ring-width', 1.5) * uiScale());
      ctx.globalAlpha = 1;
      ctx.lineWidth = edge;
      ctx.strokeStyle = cssText('--row-ring-colour', '#FFFFFF').trim();
      ctx.strokeRect(x - edge, y - edge, look.width + edge * 2, height + edge * 2);
    }
    // The box a press is read against. A struck mark keeps one: it can be
    // chosen again, and struck again.
    if (kind === 'truck') markBoxes.push({ id: mark.id, x, y, w: look.width, h: height });
  }
  ctx.restore();
}

/**
 * THE LAST FRAME'S OWN NUMBERS, kept so that a press can be read back into
 * degrees. Drawing turns a place on the ground into a place on the screen;
 * a press has to go the other way, and it can only be answered against the
 * frame that was actually on the glass when the finger came down.
 */
let lastFrame: { cx: number; cy: number; anchorY: number } | null = null;

/** The way back from a place on the screen to the ground under it — project()
 *  run backwards, rotation and all. */
function unproject(x: number, y: number): { lat: number; lon: number } | null {
  if (!lastFrame) return null;
  const { cx, cy, anchorY } = lastFrame;
  const dxs = x - cssW / 2;
  const dys = y - anchorY;
  // project() turns by -mapHeading, so coming back turns by +mapHeading.
  const c = Math.cos(-mapHeading);
  const sn = Math.sin(-mapHeading);
  const dx = dxs * c + dys * sn;
  const dy = -dxs * sn + dys * c;
  return {
    lat: latFromTileY(cy + dy / TILE, zoom),
    lon: lonFromTileX(cx + dx / TILE, zoom),
  };
}

/** Where a coordinate lands on the screen, rotation and all. */
function project(lat: number, lon: number, cx: number, cy: number, anchorY: number): { x: number; y: number } {
  const dx = (tileX(lon, zoom) - cx) * TILE;
  const dy = (tileY(lat, zoom) - cy) * TILE;
  const c = Math.cos(-mapHeading);
  const s = Math.sin(-mapHeading);
  return { x: cssW / 2 + dx * c - dy * s, y: anchorY + dx * s + dy * c };
}

/**
 * HOW FAR ALONG THE ROUTE the aircraft is: the point on the route — on a leg,
 * not necessarily at a waypoint — nearest to it, as a distance from the first
 * waypoint. Everything that has to know "passed or still to come" asks this
 * one question, so the line's colours and the waypoints' agree by
 * construction. It is measured from the aircraft TO the route, so straying off
 * the route moves this point along the route rather than moving the route.
 */
function alongRoute(points: { lat: number; lon: number }[], at: { lat: number; lon: number }): number {
  const kx = Math.cos((at.lat * Math.PI) / 180); // a degree of longitude is shorter here
  let best = 0;
  let bestD = Infinity;
  let walked = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = (points[i].lon - at.lon) * kx, ay = points[i].lat - at.lat;
    const bx = (points[i + 1].lon - at.lon) * kx, by = points[i + 1].lat - at.lat;
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    // Where on this leg the aircraft is abeam, clamped to the leg's own ends.
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * vx + ay * vy) / len2)) : 0;
    const px = ax + vx * t, py = ay + vy * t;
    const d = px * px + py * py;
    const legLength = Math.sqrt(len2);
    if (d < bestD) { bestD = d; best = walked + legLength * t; }
    walked += legLength;
  }
  return best;
}

/** The route's waypoints, each with how far along the route it sits. */
function alongEach(points: { lat: number; lon: number }[], refLat: number): number[] {
  const kx = Math.cos((refLat * Math.PI) / 180);
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i].lon - points[i - 1].lon) * kx;
    const dy = points[i].lat - points[i - 1].lat;
    out.push(out[i - 1] + Math.hypot(dx, dy));
  }
  return out;
}

/** The name a waypoint carries: its number, 1A, 2A, 3A…, unless the flight
 *  plan gave it one of its own (see ROUTE_NAMES in demo/main.ts). */
function waypointName(index: number, points?: { name?: string }[]): string {
  return points?.[index]?.name ?? `${index + 1}A`;
}

/**
 * THE ROUTE, drawn the way the design has it:
 *
 *   · one line, in two colours, split at the point the aircraft is abeam of —
 *     behind it the flown colour, ahead of it the colour still to fly;
 *   · every part of it carries a dark casing, drawn first and wider;
 *   · each waypoint is a ring with a shaded middle and a small bright dot,
 *     and takes the colour of the stretch it belongs to;
 *   · each ring is named, on a plate below and right of it, and the line is
 *     drawn OVER the plates — as in the design, where a leg crosses one.
 */
function drawRoute(f: MapFix, cx: number, cy: number, anchorY: number): void {
  const waypoints = f.route ?? [];
  if (waypoints.length < 2) return;
  // The lead-in is part of the LINE and of nothing else: it is drawn, split
  // and coloured like any other stretch, but it carries no ring and no name,
  // and the route's first real waypoint is still 1A. `first` is where the
  // waypoints begin in the drawn line.
  const points = f.leadIn ? [f.leadIn, ...waypoints] : waypoints;
  const first = f.leadIn ? 1 : 0;
  if (!routeStyle) readRouteStyle();
  const st = routeStyle!;

  const at = alongRoute(points, f);
  const along = alongEach(points, f.lat);
  const screen = points.map((p) => project(p.lat, p.lon, cx, cy, anchorY));

  // Everything the route draws sits under one shadow, set here and nowhere
  // else: --route-shadow is its blur, 0 switching it off.
  ctx.save();
  if (st.shadow > 0) {
    ctx.shadowBlur = st.shadow;
    ctx.shadowColor = st.shadowColor;
  }

  // 1. the labels, under everything else the route draws
  if (st.showLabel) {
    for (let i = first; i < screen.length; i++) {
      drawWaypointLabel(waypointName(i - first, waypoints), screen[i], st);
    }
  }

  // 2. the line: the casing in one pass, then the two colours over it
  if (st.showLine) {
    const split = splitScreenPath(screen, along, at);
    strokePath(screen, st.casingColor, st.width + st.casing * 2, st);
    if (split.behind.length > 1) strokePath(split.behind, st.flown, st.width, st);
    if (split.ahead.length > 1) strokePath(split.ahead, st.ahead, st.width, st);
  }

  // 3. the rings, each in the colour of the stretch it belongs to. A waypoint
  //    counts as passed only once the aircraft is PAST it — level with it is
  //    not past it, and an aircraft short of the route's first waypoint has
  //    passed nothing at all, so the comparison has to be strict.
  for (let i = first; i < screen.length; i++) {
    drawWaypoint(screen[i], along[i] < at ? st.flown : st.ahead, st);
  }
  ctx.restore();
}

/** The line as two lists of screen points, parted where the aircraft is abeam. */
function splitScreenPath(screen: { x: number; y: number }[], along: number[], at: number):
{ behind: { x: number; y: number }[]; ahead: { x: number; y: number }[] } {
  const behind: { x: number; y: number }[] = [];
  const ahead: { x: number; y: number }[] = [];
  for (let i = 0; i < screen.length; i++) {
    if (along[i] < at) behind.push(screen[i]); else ahead.push(screen[i]);
  }
  // The join itself: the point on the leg the aircraft is abeam of, which
  // belongs to both halves so the colours meet without a gap.
  const i = along.findIndex((a) => a > at);
  if (i > 0) {
    const t = (at - along[i - 1]) / (along[i] - along[i - 1] || 1);
    const join = {
      x: screen[i - 1].x + (screen[i].x - screen[i - 1].x) * t,
      y: screen[i - 1].y + (screen[i].y - screen[i - 1].y) * t,
    };
    behind.push(join);
    ahead.unshift(join);
  }
  return { behind, ahead };
}

/** One stroke along a list of screen points. */
function strokePath(
  points: { x: number; y: number }[], color: string, width: number, st: RouteStyle,
): void {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.lineJoin = 'miter';   // the design's corners are sharp
  ctx.lineCap = 'butt';
  ctx.miterLimit = 8;
  // A dashed route: --route-dash is the length of a stroke, --route-dash-gap
  // the hole after it. Dash 0 is a solid line, and a gap of 0 is read as the
  // dash's own length, so one knob is enough for an even dash.
  ctx.setLineDash(st.dash > 0 ? [st.dash, st.dashGap || st.dash] : []);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A waypoint: shaded middle, ring, and the dot at its centre. */
function drawWaypoint(p: { x: number; y: number }, color: string, st: RouteStyle): void {
  // The ring is measured by its OUTER edge, so its line is drawn on a circle
  // half its own thickness inside that — give it a thicker line and it grows
  // inwards, and --route-marker stays the size a ruler would measure.
  const r = Math.max(0, st.ring / 2 - st.ringStroke / 2);
  if (st.showRing) {
    // the shade inside, which darkens the ground and the line passing through;
    // `auto` fills it with the stretch's own colour instead of a shade.
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0, r - st.ringStroke / 2), 0, Math.PI * 2);
    ctx.fillStyle = st.ringFill === 'auto' ? color : st.ringFill;
    ctx.fill();
    // the ring, cased like the line
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = st.casingColor;
    ctx.lineWidth = st.ringStroke + st.ringCasing * 2;
    ctx.stroke();
    ctx.strokeStyle = st.ringColor === 'auto' ? color : st.ringColor;
    ctx.lineWidth = st.ringStroke;
    ctx.stroke();
  }
  // and the dot at the very centre; `auto` takes the stretch's colour too
  if (st.showDot) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, st.dot / 2, 0, Math.PI * 2);
    ctx.fillStyle = st.dotColor === 'auto' ? color : st.dotColor;
    ctx.fill();
  }
}

/**
 * A waypoint's name, on its plate, below and right of the ring.
 *
 * THE PLATE IS DRAWN ONCE AND THEN STAMPED. Canvas puts a filled shape down
 * wherever it falls, half-covered pixels and all, but lays glyphs on whole
 * pixels — so a plate sliding along by fractions of a pixel, as it does on a
 * map that moves, would creep smoothly while the name inside it stepped, and
 * the name would look as though it were shuffling about in its plate. Rounding
 * the plate onto whole pixels instead holds the name still, but then the plate
 * steps while its own ring, drawn as a shape, glides — the jump just moves
 * somewhere else.
 *
 * So the pill and the name are drawn together, once, into a small canvas of
 * their own, and that picture is stamped onto the map at the exact position
 * wanted, fractions and all. Nothing inside it can shift, because inside it
 * nothing is being drawn any more; and the stamp itself lands wherever the
 * waypoint is, so it travels as smoothly as the ring it belongs to. The
 * picture is kept until the name or the look of the plates changes.
 */
const labelPlates = new Map<string, { img: HTMLCanvasElement; w: number; h: number }>();

function labelPlate(text: string, st: RouteStyle): { img: HTMLCanvasElement; w: number; h: number } | null {
  const font = `${st.labelWeight} ${st.labelText}px ${st.labelFont}`;
  const key = [text, font, st.labelH, st.labelPad, st.labelRadius, st.labelBg, st.labelColor, dpr].join('|');
  const had = labelPlates.get(key);
  if (had) return had;

  ctx.font = font;
  const padX = st.labelH * st.labelPad;
  const w = ctx.measureText(text).width + padX * 2;
  const h = st.labelH;
  // A PLATE OF NO SIZE IS NEVER MADE, AND NEVER KEPT. The window can be
  // measured at nothing at all — while it is still opening, while it is
  // hidden, in the moment a layout changes — and everything on the map is
  // then scaled by nothing. A plate made in that moment is a canvas of zero
  // width, which cannot be drawn: it would throw, and a throw in the middle
  // of a frame takes the whole of the drawing down with it, camera and all.
  // So nothing is made here until there is a size to make it at.
  if (!(w >= 1) || !(h >= 1) || !(dpr > 0)) return null;
  const img = document.createElement('canvas');
  img.width = Math.ceil(w * dpr);
  img.height = Math.ceil(h * dpr);
  const g = img.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.beginPath();
  // --route-label-radius rounds the corners, never past a full pill.
  g.roundRect(0, 0, w, h, Math.min(st.labelRadius, h / 2));
  g.fillStyle = st.labelBg;
  g.fill();
  g.font = font;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = st.labelColor;
  g.fillText(text, padX, h / 2 + st.labelText * 0.02);

  // One plate per name per look; the map carries a handful at a time, and a
  // changed knob simply makes new ones, so the old are dropped.
  if (labelPlates.size > 64) labelPlates.clear();
  const made = { img, w, h };
  labelPlates.set(key, made);
  return made;
}

function drawWaypointLabel(text: string, p: { x: number; y: number }, st: RouteStyle): void {
  const plate = labelPlate(text, st);
  if (!plate) return;                 // nothing to draw it at, this frame
  // The plate hangs from its TOP-LEFT corner: dx moves that corner right of
  // the ring's centre, dy moves it down from it. The plate then grows right
  // and down from there, as wide as the name needs.
  ctx.drawImage(plate.img, p.x + st.labelDx, p.y + st.labelDy, plate.w, plate.h);
}


/**
 * The aircraft symbol: dead centre, dead upright, never rotated. It is drawn
 * outside the map's rotation, so whatever the aircraft does the symbol stays
 * level and the ground is what moves.
 *
 * The NORTH MARKER is the one piece of it that does move. The symbol's ring is
 * a compass rose, and on a track-up map true north is wherever the map has
 * been turned to — screen angle −heading. The marker is placed at that angle,
 * out on the ring, and carried round with it, so it always points at real
 * north while the aircraft stays level.
 */
/**
 * THE SYMBOL IN TWO LAYERS: the disc, and the aircraft on it.
 *
 * Me_icon.png is the aircraft over a soft dark disc, and that disc is NOT
 * solid — it is black at about three quarters strength, so the ground shows
 * through it, which is how it is drawn in the design. The ring has to go over
 * the disc (under it, the disc swallows it) while the nose, which reaches past
 * the disc, has to stay over the ring. So the picture is cut once into the two
 * layers, and they go down with the ring between them.
 *
 * The cut is a flood fill from the middle of the picture across the aircraft's
 * own white and the black outline around it, which the weaker disc stops —
 * nothing else in the picture is drawn at full strength. The aircraft keeps
 * one pixel more than the fill found, so it holds the soft edge it was drawn
 * with, and the disc keeps everything under the fill, so no seam opens up
 * between them.
 *
 * Nothing here darkens anything: each pixel of the original is put in exactly
 * one of the two layers, and neither is drawn twice.
 */
let symbolLayers: { disc: HTMLCanvasElement; jet: HTMLCanvasElement } | null | undefined;

function aircraftLayers(): { disc: HTMLCanvasElement; jet: HTMLCanvasElement } | null {
  if (symbolLayers !== undefined) return symbolLayers;
  if (!ready(icon)) return null;                 // cut on a later frame
  const w = icon.naturalWidth;
  const h = icon.naturalHeight;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  const jet = make();
  const disc = make();
  const gj = jet.getContext('2d')!;
  const gd = disc.getContext('2d')!;
  gj.drawImage(icon, 0, 0);
  const jetData = gj.getImageData(0, 0, w, h);
  const d = jetData.data;
  const discData = new ImageData(new Uint8ClampedArray(d), w, h);
  const dd = discData.data;

  const solid = (i: number) => d[i + 3] > 230 && (d[i] > 200 || d[i] < 60);
  const keep = new Uint8Array(w * h);
  const stack = [Math.floor(h / 2) * w + Math.floor(w / 2)];
  keep[stack[0]] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= w * h || keep[q] || !solid(q * 4)) continue;
      keep[q] = 1;
      stack.push(q);
    }
  }
  // The aircraft's layer: the fill, and one pixel out for its soft edge.
  const edge = new Uint8Array(keep);
  for (let p = 0; p < w * h; p++) {
    if (!keep[p]) continue;
    const x = p % w;
    if (x > 0) edge[p - 1] = 1;
    if (x < w - 1) edge[p + 1] = 1;
    if (p >= w) edge[p - w] = 1;
    if (p < w * (h - 1)) edge[p + w] = 1;
  }
  for (let p = 0; p < w * h; p++) {
    if (!edge[p]) d[p * 4 + 3] = 0;              // out of the aircraft's layer
    if (keep[p]) dd[p * 4 + 3] = 0;              // out of the disc's layer
  }
  gj.putImageData(jetData, 0, 0);
  gd.putImageData(discData, 0, 0);
  symbolLayers = { disc, jet };
  return symbolLayers;
}


/**
 * WHERE THE RING'S OWN MIDDLE IS, in the artwork's pixels.
 *
 * The ring has to turn about its own centre, or it would wobble as it goes
 * round. That centre is not promised to be the middle of the file — artwork
 * usually carries uneven space around it — so it is measured once, from the
 * ring's own outline, and the drawing is hung from the point found.
 */
let ringPivot: { x: number; y: number; r: number } | null | undefined;

function ringCentre(): { x: number; y: number; r: number } | null {
  if (ringPivot !== undefined) return ringPivot;
  if (!ready(ringIcon)) return null;           // measured on a later frame
  const w = ringIcon.naturalWidth;
  const h = ringIcon.naturalHeight;
  const cut = document.createElement('canvas');
  cut.width = w; cut.height = h;
  const g = cut.getContext('2d')!;
  g.drawImage(ringIcon, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let p = 0; p < w * h; p++) {
    if (d[p * 4 + 3] < 20) continue;           // clear space around the ring
    const x = p % w;
    const y = (p / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // …and how far out the ring itself runs, which is what the line to the
  // aircraft has to stop on.
  ringPivot = x1 > x0
    ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: ((x1 - x0) + (y1 - y0)) / 4 }
    : { x: w / 2, y: h / 2, r: w / 2 };
  return ringPivot;
}

/**
 * THE AIRCRAFT AND ITS RING.
 *
 * Two pictures, one on top of the other, both centred on the aircraft's place
 * on the screen:
 *
 *   · the RING turns. Its N is drawn into it, a little way round from the top
 *     — --ring-north says how far — so the ring is turned until that mark
 *     points at true north, which on a track-up map is the screen angle
 *     −heading. Every other mark on it comes round with it, as a compass rose
 *     does.
 *   · the AIRCRAFT does not turn, ever. Its dark disc goes down first, under
 *     the ring; the aircraft itself goes back on top of the ring, so where
 *     the nose and the ring meet, the nose is what reads.
 */
/**
 * THE BEAM OUT OF THE NOSE, Ellipse.png.
 *
 * The artwork is a wedge with its point at the BOTTOM of the picture and its
 * wide end at the top, so it is laid down with that point on the aircraft's
 * nose and the rest reaching away ahead of it. Measured off the file, the
 * point sits 47.3% across and at the very bottom — that is the pair of
 * anchor numbers below, and the one thing to re-measure if the file changes.
 *
 * It is drawn FIRST, before the disc, the ring and the aircraft, so all three
 * lie over it and only the part of the beam beyond the symbol shows.
 *
 * The map is turned track-up, so the nose always points up the screen and so
 * does the beam; --beam-turn swings it off the nose when something other than
 * straight ahead is wanted.
 */
function drawBeam(size: number, scale: number): void {
  if (cssNumber('--beam-show', 1) === 0 || !ready(beamIcon)) return;
  const alpha = Math.max(0, Math.min(1, cssNumber('--beam-opacity', 100) / 100));
  if (alpha <= 0) return;
  const length = cssNumber('--beam-length', 1_000) * scale;
  const width = (length * beamIcon.naturalWidth) / beamIcon.naturalHeight;
  const ax = cssNumber('--beam-anchor-x', 47.3) / 100;
  // How far ahead of the middle of the symbol the point of the beam sits.
  // Given as a share of the aircraft's own width, so it stays on the nose
  // when the symbol is resized.
  const nose = (size * cssNumber('--beam-nose', 32)) / 100;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.rotate((cssNumber('--beam-turn', 0) * Math.PI) / 180);
  ctx.translate(0, -nose);
  // The picture's own point goes on that spot: the beam reaches up the screen.
  ctx.drawImage(beamIcon, -width * ax, -length, width, length);
  ctx.restore();
}

/**
 * THE GREEN MARKS ROUND THE RING, green_icon.png.
 *
 * The artwork is a cross and four sets of arcs built around a circle in its
 * middle. That circle is the thing that matters: it is drawn so that it sits
 * exactly on the white compass ring, which is what makes the green read as a
 * frame around the ring rather than a picture of its own size.
 *
 * So the picture is not scaled to the aircraft but to the RING: the ring is
 * measured where it is drawn, the circle in this file is measured once (the
 * three --green-* numbers below, taken off the artwork), and the picture is
 * made big enough for the two circles to agree.
 */
function drawGreen(size: number): void {
  if (cssNumber('--green-show', 1) === 0 || !ready(greenIcon) || !ready(ringIcon)) return;
  const alpha = Math.max(0, Math.min(1, cssNumber('--green-opacity', 100) / 100));
  if (alpha <= 0) return;
  const ring = ringCentre();
  if (!ring) return;

  // How wide the ring is drawn, and so how far out its edge runs.
  const ringK = (size * cssNumber('--ring-size', 90)) / 100 / ringIcon.naturalWidth;
  const ringR = ring.r * ringK;

  const w = greenIcon.naturalWidth;
  const h = greenIcon.naturalHeight;
  // The circle inside the file, measured off it: where its middle is and how
  // far out it runs. Worked out from green_icon.png and then used in PICTURE
  // PIXELS, because the lit files are the same drawing with a little more
  // room at one edge — their corners differ, their middles do not.
  const cxArt = (cssNumber('--green-anchor-x', 49.96) / 100) * w;
  const cyArt = (cssNumber('--green-anchor-y', 49.98) / 100) * h;
  const ownR = (cssNumber('--green-radius', 7.49) / 100) * w;
  if (ownR <= 0) return;
  // Big enough for the two circles to lie on one another; --green-fit opens
  // the green a little wider than the ring, or draws it in.
  const k = (ringR * (cssNumber('--green-fit', 100) / 100)) / ownR;

  // Which of the lit files, if any, belong on top: one for every threat that
  // is up at this moment. It lights with the searching ring and goes out with
  // the launch ring — the whole of the sequence, from first to last.
  const lit: HTMLImageElement[] = [];
  if (cssNumber('--green-glow-show', 1) !== 0) {
    for (const cue of cues) {
      const now = cuePhase(cue);
      if (!now) continue;
      const img = greenGlow(greenSector(cue.lat, cue.lon));
      if (ready(img) && !lit.includes(img)) lit.push(img);
    }
  }

  ctx.save();
  // Upright on the screen by default. --green-with-north makes it come round
  // with the compass ring instead, and --green-turn swings it either way.
  if (cssNumber('--green-with-north', 0) !== 0) {
    ctx.rotate(-mapHeading - (cssNumber('--ring-north', 30.2) * Math.PI) / 180);
  }
  ctx.rotate((cssNumber('--green-turn', 0) * Math.PI) / 180);
  const stamp = (img: HTMLImageElement): void => {
    ctx.drawImage(img, -cxArt * k, -cyArt * k, img.naturalWidth * k, img.naturalHeight * k);
  };
  ctx.globalAlpha = alpha;
  stamp(greenIcon);
  ctx.globalAlpha = Math.max(0, Math.min(1, cssNumber('--green-glow-opacity', 100) / 100));
  for (const img of lit) stamp(img);
  ctx.restore();
}

function drawAircraft(): void {
  if (!ready(icon)) return;
  const scale = uiScale();
  const size = cssNumber('--aircraft-size', ICON_SIZE_DEFAULT) * scale;
  ctx.save();
  ctx.translate(cssW / 2, aircraftY());

  // Under everything else the symbol is made of.
  drawBeam(size, scale);
  drawGreen(size);

  // Both layers go down exactly as they were drawn, and nothing is added to
  // them: the artwork carries its own glow and its own edges.
  const layers = aircraftLayers();
  if (layers) {
    // The disc is drawn at whatever strength the artwork has it — black at
    // about three quarters. --symbol-disc thins that down without touching
    // the file: 100% is the file as it is, 50% lets twice as much ground
    // through, 0% leaves no disc at all.
    const discStrength = cssNumber('--symbol-disc', 100) / 100;
    ctx.globalAlpha = Math.max(0, Math.min(1, discStrength));
    ctx.drawImage(layers.disc, -size / 2, -size / 2, size, size);
    ctx.globalAlpha = 1;
  }

  const pivot = ringCentre();
  if (ready(ringIcon) && pivot) {
    // --ring-size is the ring's width as a share of the aircraft's own.
    const k = (size * cssNumber('--ring-size', 90)) / 100 / ringIcon.naturalWidth;
    const north = (cssNumber('--ring-north', 30.2) * Math.PI) / 180;
    ctx.save();
    ctx.rotate(-mapHeading - north);           // the N swung round onto north
    ctx.drawImage(
      ringIcon,
      -pivot.x * k, -pivot.y * k,
      ringIcon.naturalWidth * k, ringIcon.naturalHeight * k,
    );
    ctx.restore();
  }

  // The aircraft last, over the ring.
  if (layers) ctx.drawImage(layers.jet, -size / 2, -size / 2, size, size);
  ctx.restore();
}

// -- zoom --------------------------------------------------------------------
// THE RANGE IS SET FROM THE SCREEN ITSELF — the + and − keys either side of
// the range control, bottom right. The MOUSE WHEEL DOES NOT TOUCH IT: a roll
// of the wheel anywhere in this window used to step the range, which meant
// that scrolling a list, or simply resting the hand on the wheel over the
// camera, moved the map out from under her. The +/- keys on the keyboard are
// kept, as a way of checking the map at another scale while building.

function setZoom(z: number): void {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (next === zoom) return;
  zoom = next;
  draw();
}

/**
 * ══ THE RANGE THE MAP IS SET TO ═════════════════════════════════════════════
 *
 * The map is not zoomed freely: it steps between the five ranges the control
 * carries, and the control's artwork changes with it — one picture per range,
 * zoom in:out_15.png and so on.
 *
 * ZOOM_RANGES are those five, in the order the + key walks through them (the
 * + key goes towards 15, the − key towards 240). ZOOM_START is the one the map
 * opens on, and ZOOM_AT_START is the map's own zoom there — which is the zoom
 * the map had before any of this, so the opening view is unchanged. Each step
 * from it is one zoom level, exactly what the + and − keys on the keyboard
 * have always done.
 *
 * The names are what the control says, not a measurement: the five steps are
 * five zoom levels, each twice the ground of the one before it, and these are
 * the numbers the design puts on them. The two widest were called 90 and 120
 * and are now called 120 and 240 — the same two steps, the same views, named
 * for what they are meant to read as.
 */
const ZOOM_RANGES = [15, 30, 60, 120, 240];
const ZOOM_START = 1;          // the second of them: 30 NM
const ZOOM_AT_START = 13;      // the map's own zoom at that range
let zoomStep = ZOOM_START;

function setZoomStep(next: number): void {
  const step = Math.min(ZOOM_RANGES.length - 1, Math.max(0, next));
  zoomStep = step;
  setZoom(ZOOM_AT_START + (ZOOM_START - step));
  const face = `./icons/zoom%20in:out_${ZOOM_RANGES[step]}.png`;
  if (!zoomBtn.src.endsWith(face.slice(1))) zoomBtn.src = face;
}

window.addEventListener('keydown', (e) => {
  if (e.key === '+' || e.key === '=') setZoomStep(zoomStep - 1);
  else if (e.key === '-' || e.key === '_') setZoomStep(zoomStep + 1);
});

// -- the buttons -------------------------------------------------------------
// They are artwork for now: nothing behind them is wired up yet. The one
// exception is the friends button, which already knows its two states, so
// clicking it shows the open panel's artwork and clicking again closes it.

/**
 * ══ ONE TARGET, EVERY SCREEN ════════════════════════════════════════════════
 *
 * A target's NAME is its file's name: BN222_icon.png is BN222, and BN222 is
 * what the map draws, what the targets screens list and what the foes list
 * lists. Pressing it anywhere picks it out everywhere — on the map it puts on
 * its chosen face, and in every list its row is ringed.
 *
 * The lists are PICTURES, so where each row lies in them was measured off the
 * artwork, in the file's own pixels, and is scaled by however big the picture
 * is drawn. Every list here has rows of one height at one spacing, so a row
 * is `top + pitch * n` and the names are simply in order — add a name to a
 * list and its row answers a press at once.
 */
interface ListRows {
  /** The artwork, as it appears in the markup. */
  src: string;
  /** The file's own size, which everything below is measured in. */
  w: number;
  /** Where a row's box lies across the picture. */
  x: number;
  width: number;
  /** The first row's top, how tall a row is, and how far to the next. */
  top: number;
  height: number;
  pitch: number;
  /** How round the corners are drawn, in the file's pixels. */
  radius: number;
  /** The rows themselves, top to bottom. */
  names: string[];
}

/** The nine of Cobra 1, in the order every list puts them in. */
const COBRA_1 = ['BN222', 'TR383', 'GE867', 'BN799', 'TR113', 'GE167', 'BN229', 'TR313', 'TR370'];

const LIST_ROWS: ListRows[] = [
  // The targets screen, in the five-way arrangement and in the bar.
  { src: 'list_5_layout_all.png', w: 2284, x: 70, width: 2160,
    top: 494, height: 292, pitch: 308, radius: 40, names: COBRA_1 },
  { src: 'list_3_layout.png', w: 1540, x: 56, width: 1424,
    top: 492, height: 292, pitch: 308, radius: 40, names: COBRA_1 },
  // The foes list at full length, and the top half of the pair — where only
  // the first four rows are drawn whole, so only those four are listed.
  { src: 'Foes_FULL_list_open.png', w: 448, x: 16, width: 416,
    top: 232, height: 416, pitch: 424, radius: 28, names: COBRA_1 },
  { src: 'Friend and Foes_list_open.png', w: 448, x: 16, width: 416,
    top: 232, height: 416, pitch: 424, radius: 28, names: COBRA_1.slice(0, 4) },
];

/** The target a file name stands for: BN222_icon -> BN222. */
function targetName(id: string): string {
  return id.replace(/_icon$/, '');
}

/** Which list, if any, a picture is — by the end of its own file name. */
function listRowsFor(img: HTMLImageElement): ListRows | undefined {
  const src = decodeURIComponent(img.getAttribute('src') ?? '');
  return LIST_ROWS.find((l) => src.endsWith(l.src));
}

/**
 * THE WHITE RING ROUND A CHOSEN ROW.
 *
 * Every ring is MADE AFRESH each time, and the old ones are taken away
 * first. It is tempting to keep them against the picture they belong to and
 * move them about, but a picture does not stay the same picture: the panel
 * swaps one list for another in place, and a ring kept against that element
 * would be left standing over a list that is no longer there — white boxes
 * on the bare map. Made afresh, a ring can only ever exist where a list that
 * is on screen says that row is.
 */
function dressRowRings(): void {
  for (const old of document.querySelectorAll('.rowRing')) old.remove();
  const chosen = new Set([...picked].map(targetName));
  if (!chosen.size) return;
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    const list = listRowsFor(img);
    if (!list) continue;
    const parent = img.parentElement;
    if (!parent) continue;
    // A SHUT LIST HAS NO ROWS TO RING. It may still be in the page, keeping
    // its place and its size so that everything round it can be measured, so
    // its box alone does not say whether it can be seen; asked all three
    // ways it does.
    if (img.offsetParent === null) continue;
    if (img.classList.contains('is-shut')) continue;
    if (getComputedStyle(img).visibility === 'hidden') continue;
    const box = img.getBoundingClientRect();
    if (!box.width) continue;
    const frame = parent.getBoundingClientRect();
    const s = box.width / list.w;            // drawn pixels per file pixel
    list.names.forEach((name, i) => {
      if (!chosen.has(name)) return;
      const ring = document.createElement('div');
      ring.className = 'rowRing';
      ring.style.left = `${(box.left - frame.left + list.x * s).toFixed(2)}px`;
      ring.style.top = `${(box.top - frame.top + (list.top + list.pitch * i) * s).toFixed(2)}px`;
      ring.style.width = `${(list.width * s).toFixed(2)}px`;
      ring.style.height = `${(list.height * s).toFixed(2)}px`;
      ring.style.borderRadius = `${(list.radius * s).toFixed(2)}px`;
      parent.appendChild(ring);
    });
  }
}

/** A press on a list: the row it landed on is picked out, or let go. */
function pressListRow(e: MouseEvent): boolean {
  const img = e.currentTarget as HTMLImageElement;
  const list = listRowsFor(img);
  if (!list) return false;
  const box = img.getBoundingClientRect();
  if (!box.width) return false;
  const s = box.width / list.w;
  const x = (e.clientX - box.left) / s;
  const y = (e.clientY - box.top) / s;
  if (x < list.x || x > list.x + list.width) return false;
  const n = Math.floor((y - list.top) / list.pitch);
  if (n < 0 || n >= list.names.length) return false;
  if (y - list.top - list.pitch * n > list.height) return false;   // in the gap
  const id = `${list.names[n]}_icon`;
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  dressRowRings();
  dirty = true;                       // the map's own mark changes face too
  return true;
}

/** Every list picture on screen answers a press, however it got there. */
function wireListPresses(): void {
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    if (!listRowsFor(img) || img.dataset.rowsWired) continue;
    img.dataset.rowsWired = '1';
    img.style.pointerEvents = 'auto';
    img.style.cursor = 'pointer';
    img.addEventListener('click', pressListRow);
  }
}

/**
 * ══ THE FOES AND THE FRIENDS ════════════════════════════════════════════════
 *
 * The button at the top left drops BOTH LISTS at once — the foes above, the
 * friends below — and each of them has its own bar as its heading. Pressing a
 * bar shuts that list; pressing it again opens it. There are four ways the
 * panel can stand, and a picture for each, so nothing is ever stretched or
 * cut to fit:
 *
 *   both open     Friend and Foes_list_open.png — one picture, foes over
 *                 friends, with both bars drawn into it.
 *   foes shut     Foes_list_close.png above, and the friends at full length
 *                 under it: Friend_FULL_list_open.png.
 *   friends shut  the foes at full length, Foes_FULL_list_open.png, and the
 *                 friends' bar BELOW them: Friend_list_close.png.
 *   both shut     the two bars alone, in that order.
 *
 * WHICH BAR WAS PRESSED is worked out from where in the picture the press
 * landed. The bars were measured off the files — a bar is the coloured band
 * at the top of its list — and are given as shares of the picture's height,
 * so they hold at any size the panel is drawn.
 */
const FRIENDS_CLOSED = './icons/Friends%20and%20targets_Close.png';
const FRIENDS_OPEN = './icons/Friends%20and%20targets_Open.png';
/**
 * THE THREE LISTS, and the SLOT each leaves for a heading.
 *
 * The lists are drawn without their headings: each has an empty place where
 * its bar belongs, and the bar is laid into it here. So a heading is one
 * picture — Foes_list_open.png, Friend_list_open.png — whether its list is
 * open or shut, and it never has to be cut out of a list or drawn twice.
 *
 * The slots were measured off the artwork: every list is 448 across and its
 * bar 408, so a bar sits 20 in from either side; the slot is 176 tall. They
 * are kept as SHARES of the picture, so they hold at any size it is drawn.
 */
const BAR_X = 20;          // in from the list's left edge, in file pixels
const BAR_W = 408;         // and how wide it is drawn there
const BAR_H = 176;         // the slot's own height
const LIST_W = 448;        // every list is this wide
const SLOT_Y = 20;         // the first slot starts this far down a list
const LIST_BOTH = { src: './icons/Friend%20and%20Foes_list_open.png' };
const LIST_FRIENDS_FULL = { src: './icons/Friend_FULL_list_open.png' };
const LIST_FOES_FULL = { src: './icons/Foes_FULL_list_open.png' };

/**
 * WHERE THE SLOTS ARE — FOUND IN THE PICTURE, NOT WRITTEN DOWN HERE.
 *
 * A list leaves an empty slot wherever a heading belongs, and the headings
 * are laid into those slots. Writing those places down as numbers works
 * right up until the list is drawn again with one more row in it — and then
 * every heading below that row is out of place, which is exactly what
 * happened.
 *
 * So the picture is asked instead. It is read once: each row of it is tested
 * for being nothing but the panel it is drawn on, and a run of empty rows
 * tall enough to hold a heading is a slot. The first slot is known to begin
 * SLOT_Y down — that is the margin the design gives it — so what the reading
 * says about THAT slot tells us how much of an empty run is air above the
 * heading, and the same is taken off every slot below it.
 *
 * Draw a list as long or as short as you like; the headings follow.
 */
const listSlots = new Map<string, number[]>();
function slotsIn(img: HTMLImageElement): number[] {
  const key = img.getAttribute('src') ?? '';
  const had = listSlots.get(key);
  if (had) return had;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return [];                     // not loaded yet: ask again
  const cut = document.createElement('canvas');
  cut.width = w;
  cut.height = h;
  const g = cut.getContext('2d', { willReadFrequently: true });
  if (!g) return [];
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  const far = (x: number, y: number, bg: number[]): number => {
    const i = (y * w + x) * 4;
    return Math.abs(d[i]! - bg[0]!) + Math.abs(d[i + 1]! - bg[1]!) + Math.abs(d[i + 2]! - bg[2]!);
  };
  const o = ((8 * w) + (w >> 1)) * 4;
  const bg = [d[o]!, d[o + 1]!, d[o + 2]!];    // the panel, read near the top
  const bands: number[] = [];
  let from: number | null = null;
  for (let y = 0; y < h; y++) {
    let plain = true;
    for (let x = 8; x < w - 8; x += 6) {
      if (far(x, y, bg) > 14) { plain = false; break; }
    }
    if (plain) { if (from === null) from = y; continue; }
    if (from !== null && y - from >= BAR_H - 20) bands.push(from);
    from = null;
  }
  if (from !== null && h - from >= BAR_H - 20) bands.push(from);
  // The first band says how much of a band is air; the rest are read the same.
  const trim = bands.length ? bands[0]! - SLOT_Y : 0;
  const tops = bands.map((b) => b - trim);
  listSlots.set(key, tops);
  return tops;
}
/** The two faces of each heading: pressed open, and pressed shut. */
const FOES_BAR = { open: './icons/Foes_list_open.png', shut: './icons/Foes_list_close.png' };
const FRIENDS_BAR = { open: './icons/Friend_list_open.png', shut: './icons/Friend_list_close.png' };

let friendsOpen = false;        // the panel itself
let foesListOpen = true;        // and the two lists within it
let friendListOpen = true;

/** Open or close the panel. It always opens showing BOTH lists. */
function setFriendsOpen(open: boolean): void {
  friendsOpen = open;
  friendsBtn.src = open ? FRIENDS_OPEN : FRIENDS_CLOSED;
  friendsBtn.alt = open ? 'Foes and friends (open)' : 'Foes and friends';
  mapButtonsLeftEl.classList.toggle('is-friendsOpen', open);
  if (open) { foesListOpen = true; friendListOpen = true; }
  dressLists();
}

/** Put the panel into whichever of its four ways it now stands in. */
function dressLists(): void {
  const both = foesListOpen && friendListOpen;
  const neither = !foesListOpen && !friendListOpen;
  // The shut bars: the foes' above whatever is there, the friends' below it.
  foesBar.classList.toggle('is-shut', foesListOpen);
  friendsBar.classList.toggle('is-shut', friendListOpen);
  listImg.classList.toggle('is-shut', neither);
  if (!neither) {
    const want = both ? LIST_BOTH.src
      : friendListOpen ? LIST_FRIENDS_FULL.src : LIST_FOES_FULL.src;
    if (!listImg.src.endsWith(want.slice(1))) listImg.src = want;
    listImg.alt = both ? 'Foes and friends' : friendListOpen ? 'Friends' : 'Foes';
  }
  // Each heading is ONE button: only the picture on it changes.
  setFace(foesBar, foesListOpen ? FOES_BAR.open : FOES_BAR.shut);
  setFace(friendsBar, friendListOpen ? FRIENDS_BAR.open : FRIENDS_BAR.shut);
  if (friendsOpen) fitButtons();   // nothing hidden can be measured
  placeListBars();
  dressRowRings();                 // a list that has gone takes its rings
}

function setFace(img: HTMLImageElement, want: string): void {
  if (!img.src.endsWith(want.slice(1))) img.src = want;
}

/**
 * WHERE THE TWO HEADINGS GO, and why none of it is left to the page's own
 * stacking.
 *
 * Everything here is worked out in the LIST'S OWN PIXELS and then scaled by
 * however big the list is drawn — so a heading lands on the same spot of the
 * artwork at any window size. The foes' heading never moves: it is at the
 * top, in the first slot, whether its list is open or shut. The list itself
 * is slid DOWN to make room when the foes are shut, which is what keeps that
 * heading still while everything under it collapses.
 */
function placeListBars(): void {
  const box = listImg.getBoundingClientRect();
  const panel = friendPanelEl.getBoundingClientRect();
  if (!box.width) return;
  const s = box.width / LIST_W;              // drawn pixels per file pixel
  const gap = cssNumber('--panel-gap', 8) * uiScale();
  // The foes' heading holds the first slot. When its list is shut, whatever
  // is under it starts below the heading instead of at the top.
  const drop = foesListOpen ? 0 : (SLOT_Y + BAR_H) * s + gap;
  listImg.style.transform = drop ? `translateY(${drop.toFixed(2)}px)` : '';
  const left = box.left - panel.left + BAR_X * s;
  const top0 = box.top - panel.top - drop;   // the list's place before the slide
  const slots = slotsIn(listImg);            // read off the picture itself
  const foesTop = top0 + (slots[0] ?? SLOT_Y) * s;
  // The friends' heading: in its own slot in the middle of the pair, in the
  // first slot of the friends' own list when the foes are shut, and below
  // the whole picture when the friends themselves are shut.
  let friendsTop: number;
  if (foesListOpen && friendListOpen) friendsTop = top0 + (slots[1] ?? 0) * s;
  else if (friendListOpen) friendsTop = top0 + drop + (slots[0] ?? SLOT_Y) * s;
  else if (foesListOpen) friendsTop = top0 + box.height + gap;
  else friendsTop = foesTop + (BAR_H * s) + gap;
  for (const [bar, y] of [[foesBar, foesTop], [friendsBar, friendsTop]] as const) {
    bar.style.left = `${left.toFixed(2)}px`;
    bar.style.top = `${y.toFixed(2)}px`;
    bar.style.width = `${(BAR_W * s).toFixed(2)}px`;
  }
}

/**
 * THE LAYOUT CHOOSER, behind the left third of the layout plate.
 *
 * The button opens a small menu of the four ways the screen can be split, each
 * drawn as a picture of itself (the markup and the greys are in map.html). One
 * of them is always the one in use and is shown light.
 *
 * Choosing only RECORDS the choice for now — the screen is not split yet. When
 * it is, `applyLayout` below is the single place that has to learn how; every
 * other part of this, the menu, the selected state, the button, is done.
 */
const layoutLeftBtn = document.getElementById('btnLayoutLeft') as HTMLButtonElement;
const layoutMenu = document.getElementById('layoutMenu')!;
const layoutOptions = Array.from(document.querySelectorAll<HTMLButtonElement>('.layoutOpt'));

/** The arrangements, by the name each option carries in the markup. */
type LayoutId = 'full' | 'side' | 'half' | 'five';
/** What the screen is showing now. The map full screen is where we start. */
let layout: LayoutId = 'full';

function setLayoutMenuOpen(open: boolean): void {
  layoutMenu.classList.toggle('is-open', open);
  layoutLeftBtn.setAttribute('aria-expanded', String(open));
}

/**
 * Put one arrangement into effect.
 *
 * The screen itself is divided in CSS (see #screen in map.html) — all this
 * does is say which arrangement is in force. What follows from it matters
 * though: the map's box has changed shape, so the canvas has to be re-measured
 * at its new size and the chrome inside it re-fitted. Without that the map
 * would go on drawing at the old width, with the aircraft off its centre.
 */
function applyLayout(next: LayoutId): void {
  layout = next;
  for (const opt of layoutOptions) {
    const on = opt.dataset.layout === next;
    opt.classList.toggle('is-selected', on);
    opt.setAttribute('aria-checked', String(on));
  }
  // 'full' is the plain row with nothing beside the map; the other
  // arrangements each add their own panes.
  screenEl.classList.toggle('is-five', next === 'five');
  screenEl.classList.toggle('is-half', next === 'half');
  screenEl.classList.toggle('is-side', next === 'side');
  resize();      // the canvas, at the map's new size
  fitButtons();  // and everything laid out inside it
  draw();
}

layoutLeftBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setLayoutMenuOpen(!layoutMenu.classList.contains('is-open'));
});

for (const opt of layoutOptions) {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    applyLayout((opt.dataset.layout ?? 'full') as LayoutId);
    setLayoutMenuOpen(false);
  });
}

// A click anywhere else puts the menu away, the way a menu should behave.
document.addEventListener('click', () => setLayoutMenuOpen(false));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setLayoutMenuOpen(false); });

// The two keys on the zoom control: + towards 15 NM, − towards 120.
document.getElementById('btnZoomIn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  setZoomStep(zoomStep - 1);
});
document.getElementById('btnZoomOut')?.addEventListener('click', (e) => {
  e.stopPropagation();
  setZoomStep(zoomStep + 1);
});

/**
 * ══ WHERE THE AIRCRAFT SITS, BY THE BUTTON ══════════════════════════════════
 *
 * The map normally keeps the aircraft low on the screen, so that most of what
 * is shown is the ground ahead of it. Pressing this button centres it instead,
 * which gives as much behind as in front; pressing it again puts it back.
 *
 * The button carries the two faces: Location on the map.png for the low
 * setting it starts in, and Location on the map_middle.png while centred. The
 * wingman needs no thought here — he is drawn relative to the lead, so he
 * comes along on his own.
 *
 * The two places themselves are --map-aircraft-y and --map-aircraft-y-middle
 * in map.html: this only chooses which of them is in force.
 */
const LOCATION_LOW = './icons/Location%20on%20the%20map.png';
const LOCATION_MIDDLE = './icons/Location%20on%20the%20map_middle.png';
const locationBtn = document.getElementById('btnLocation') as HTMLImageElement | null;
let centred = false;

function setCentred(on: boolean): void {
  centred = on;
  if (on) {
    // The middle place wins while it is on; taking the property off again
    // hands the map straight back to its own knob.
    document.documentElement.style.setProperty(
      '--map-aircraft-y', String(cssNumber('--map-aircraft-y-middle', 0.5)),
    );
  } else {
    document.documentElement.style.removeProperty('--map-aircraft-y');
  }
  if (locationBtn) locationBtn.src = on ? LOCATION_MIDDLE : LOCATION_LOW;
  dirty = true;
}

locationBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  setCentred(!centred);
});
// Fetched up front, so the first press swaps without a blink.
new Image().src = LOCATION_MIDDLE;

/**
 * ══ THE WEAPONS SCREEN ══════════════════════════════════════════════════════
 *
 * weapon_5_layout.png carries eight stores — six 84s down the middle and an AA
 * at each wingtip. One of them is the SELECTED one and blinks slowly; pressing
 * another hands the blink over to it. That is the whole of it: nothing else in
 * the simulator looks at which one is chosen.
 *
 * HOW THE BLINK IS DONE. There are two more files — weapon_84.png and
 * weapon_AA.png — each holding ONE store on nothing, cut to its own shape. A
 * copy of the right one is laid exactly over the store that is selected, and
 * its brightness is breathed up and down. Because the picture is the shape
 * itself and not a rectangle cut out of the screen, there is no edge to catch
 * the eye: only the store appears to dim.
 *
 * BOTH SETS OF MEASUREMENTS BELOW ARE OF THE GREEN, and that matters: each
 * store is drawn with a black outline, which on the screen's black ground
 * cannot be told from the background at all. The green body is the one thing
 * that can be measured the same way in both files, so the green of the shape
 * is laid on the green of the store and the outline follows it.
 */
/** A shape file, and where the GREEN of the shape sits on its own canvas. */
interface StoreArt { src: string; cw: number; chh: number; x: number; w: number; y: number; h: number }
const WEAPON_ART: Record<'84' | 'AA', StoreArt> = {
  '84': { src: './icons/weapon_84.png', cw: 139, chh: 496, x: 20, w: 99, y: 5, h: 485 },
  'AA': { src: './icons/weapon_AA.png', cw: 126, chh: 569, x: 7, w: 112, y: 5, h: 558 },
};
interface WeaponStore { id: string; art: '84' | 'AA'; x: number; y: number; w: number; h: number }
const WEAPON_STORES: WeaponStore[] = [
  // 1-2: the top pair of 84s          3-4: the middle pair
  { id: '84_top_left',  art: '84', x: 39.011, y: 19.220, w: 4.334, h: 21.235 },
  { id: '84_top_right', art: '84', x: 56.436, y: 19.220, w: 4.334, h: 21.235 },
  { id: '84_mid_left',  art: '84', x: 39.011, y: 42.820, w: 4.334, h: 21.235 },
  { id: '84_mid_right', art: '84', x: 56.436, y: 42.820, w: 4.334, h: 21.235 },
  // 5-6: the bottom pair               7-8: the two AA at the wingtips
  { id: '84_low_left',  art: '84', x: 39.011, y: 66.418, w: 4.334, h: 21.235 },
  { id: '84_low_right', art: '84', x: 56.436, y: 66.418, w: 4.334, h: 21.235 },
  { id: 'AA_left',      art: 'AA', x: 27.566, y: 41.331, w: 4.895, h: 24.387 },
  { id: 'AA_right',     art: 'AA', x: 67.540, y: 41.331, w: 4.895, h: 24.387 },
];

/** Blink the chosen store in ONE weapons screen. Each screen keeps its own
 *  choice, so the same screen may be shown twice and chosen differently. */
interface WeaponLive { lamps: HTMLImageElement[]; gones: HTMLElement[]; picked: number }
const weaponLive = new WeakMap<HTMLElement, WeaponLive>();

/**
 * THE STORES THAT HAVE BEEN FIRED, by id — and why they are kept HERE rather
 * than in each screen. A weapons screen is built fresh every time it is
 * chosen from a pane's menu, so anything held in the pane itself would come
 * back the moment the screen was shown again. A store in this set is spent
 * for the rest of the flight, on every screen, however often the panes are
 * rebuilt: it cannot blink and it cannot be pressed.
 */
const spent = new Set<string>();

/**
 * HOW A SPENT STORE IS TAKEN OFF THE SCREEN. The eight stores are part of the
 * screen's own picture, so one of them cannot simply be hidden — the picture
 * is one file. Instead the store's SHAPE is laid over it in the colour of the
 * screen's own background (--weapon-gone-colour, the flat green-black the
 * artwork is drawn on), using the shape file as a stencil. The shape covers
 * the store exactly, outline and all, so what is left is bare screen: the
 * pylon is empty, with no rectangle or seam to give it away.
 */
function dressWeaponPane(pane: HTMLElement): void {
  const live = weaponLive.get(pane);
  if (!live) return;
  WEAPON_STORES.forEach((store, i) => {
    const gone = spent.has(store.id);
    live.gones[i]?.classList.toggle('is-off', !gone);
    // A spent store cannot be chosen: its hotspot stops answering.
    const hit = pane.querySelectorAll<HTMLButtonElement>('.weaponStore')[i];
    if (hit) hit.disabled = gone;
  });
  // If the one that was blinking is the one that has gone, nothing blinks.
  if (live.picked >= 0 && spent.has(WEAPON_STORES[live.picked]!.id)) setWeaponPicked(pane, -1);
}

function setWeaponPicked(pane: HTMLElement, index: number): void {
  const live = weaponLive.get(pane);
  if (!live) return;
  // A store that has been fired is not there to be chosen.
  if (index >= 0 && spent.has(WEAPON_STORES[index]?.id ?? '')) return;
  live.picked = index;
  live.lamps.forEach((lamp, i) => lamp.classList.toggle('is-off', i !== index));
}

/**
 * THE TRIGGER'S SIDE OF THE WEAPONS SCREEN: the store that was chosen is let
 * go. It is taken off every weapons screen on the map, and nothing blinks
 * until another is pressed.
 */
function spendPickedWeapon(): string | null {
  const panes = [...document.querySelectorAll<HTMLElement>('.weaponPane')];
  let id: string | null = null;
  for (const pane of panes) {
    const live = weaponLive.get(pane);
    if (live && live.picked >= 0) { id = WEAPON_STORES[live.picked]!.id; break; }
  }
  if (id) spent.add(id);
  for (const pane of panes) { setWeaponPicked(pane, -1); dressWeaponPane(pane); }
  return id;
}

/**
 * Lay one shape file over the store it belongs to.
 *
 * The file's GREEN is what has to land on the store's green, not the file's
 * canvas — there is clear space and a black outline around the shape — so the
 * picture is made big enough for its green to come out the right size and
 * then slid back by however much lies to its left and above.
 */
function placeWeaponLamp(lamp: HTMLElement, store: WeaponStore): void {
  const art = WEAPON_ART[store.art];
  const fullW = (store.w * art.cw) / art.w;
  const fullH = (store.h * art.chh) / art.h;
  lamp.style.width = `${fullW}%`;
  lamp.style.height = `${fullH}%`;
  lamp.style.left = `${store.x - (art.x / art.cw) * fullW}%`;
  lamp.style.top = `${store.y - (art.y / art.chh) * fullH}%`;
}

/** Give one weapons screen its eight lamps and its eight hotspots. */
function buildWeaponPane(pane: HTMLElement): void {
  const pad = cssNumber('--weapon-hotspot-pad', 1);
  const lamps: HTMLImageElement[] = [];
  const gones: HTMLElement[] = [];
  WEAPON_STORES.forEach((store, i) => {
    const lamp = document.createElement('img');
    lamp.className = 'weaponBlink is-off';
    lamp.src = WEAPON_ART[store.art].src;
    lamp.alt = '';
    lamp.setAttribute('aria-hidden', 'true');
    placeWeaponLamp(lamp, store);
    pane.appendChild(lamp);
    lamps.push(lamp);

    // The stencil that takes this store off the screen once it has been
    // fired: the same shape, in the same place, in the background's colour.
    const gone = document.createElement('div');
    gone.className = 'weaponGone is-off';
    gone.setAttribute('aria-hidden', 'true');
    const mask = `url("${WEAPON_ART[store.art].src}")`;
    gone.style.setProperty('-webkit-mask-image', mask);
    gone.style.setProperty('mask-image', mask);
    placeWeaponLamp(gone, store);
    pane.appendChild(gone);
    gones.push(gone);

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'weaponStore';
    hit.dataset.store = store.id;
    hit.setAttribute('aria-label', store.id.replace(/_/g, ' '));
    hit.style.left = `${store.x - pad}%`;
    hit.style.top = `${store.y - pad}%`;
    hit.style.width = `${store.w + pad * 2}%`;
    hit.style.height = `${store.h + pad * 2}%`;
    hit.addEventListener('click', (e) => { e.stopPropagation(); setWeaponPicked(pane, i); });
    pane.appendChild(hit);
  });
  weaponLive.set(pane, { lamps, gones, picked: -1 });
  // The one it opens on: counted from 1 in map.html, as the stores are listed
  // there; anything outside the eight simply leaves none of them blinking.
  setWeaponPicked(pane, Math.round(cssNumber('--weapon-start', 3)) - 1);
  // A screen built after a shot opens with the stores that are gone already
  // gone — the set outlives the pane.
  dressWeaponPane(pane);
}

/**
 * ══ THE FOUR SCREENS, AND CHOOSING WHAT IS ON THEM ══════════════════════════
 *
 * Each of the four small screens is a SLOT that can show any of five things —
 * EW, Weapon, Radar, Targets, Cam. In its top-left corner sits a button with
 * the name of what it is showing; pressing it drops a menu of all five, and
 * choosing one builds that screen in this pane. The same screen may be put in
 * two panes at once, and each keeps its own state.
 *
 * Every screen's artwork already has a name button drawn into it, but those
 * baked buttons differ a little from one file to the next, so the real button
 * — Radar_button.png and its fellows — is laid OVER them, in the same place
 * on every screen. The three --pane-button-* numbers in map.html are measured
 * to cover the largest of the baked ones.
 *
 * The menu's artwork is Drop-down.png, which is grey throughout. The row for
 * the screen this pane is ALREADY showing is tinted, and that is done here
 * rather than in the file: the picture is read once, the five rows are found
 * by the bands below, and a tinted copy is made for each row. So the colour
 * is a knob, --pane-menu-mark, and not something baked in.
 */
type PaneKind = 'ew' | 'weapon' | 'radar' | 'targets' | 'cam';

/** The five, in the order the menu lists them — top to bottom, as drawn. */
const PANE_ORDER: PaneKind[] = ['ew', 'weapon', 'radar', 'targets', 'cam'];

/** What each screen is called, which button it wears, and what it is made of.
 *  `open` is the button's other face, worn while its menu is down. */
const PANE_KINDS: Record<PaneKind, {
  button: string; open: string; body: string;
  /** The face for the TALL slot in the five-way arrangement. */
  tall?: string;
  /** The face for the BAR beside the map, whose screens are drawn at their
   *  own shapes — the 3_layout files. A screen with none of its own simply
   *  wears its usual face there. */
  bar?: string;
}> = {
  ew: {
    button: './icons/EW_button.png',
    open: './icons/EW_button_open.png',
    // Two layers, put together as they are drawn: what stays and what turns
    // with north — see drawEw.
    body: '<canvas class="ewView"></canvas>',
  },
  weapon: {
    button: './icons/Weapon_button.png',
    open: './icons/Weapon_button_open.png',
    body: '<img src="./icons/weapon_5_layout.png" alt="Weapons">',
  },
  radar: {
    button: './icons/Radar_button.png',
    open: './icons/Radar_button_open.png',
    body: '<img src="./icons/radar_5_layout.png" alt="Radar">'
      + '<canvas class="radarPlot"></canvas>',
  },
  targets: {
    button: './icons/Targets_button.png',
    // Her file is spelled "botton"; the other spelling is tried as well so
    // that renaming it later needs no change here.
    open: './icons/Targets_botton_open.png',
    // THE LIST IS ALWAYS THE WHOLE LIST. There is one file, the long one,
    // and whatever slot it is put in it is shown from the TOP down: what
    // fits is what shows, and the rest is scrolled to. That is why it is
    // wrapped — the wrapper is what scrolls, so the button in the corner
    // stays where it is while the list moves under it.
    body: '<div class="listScroll"><img src="./icons/list_5_layout_all.png" alt="Targets"></div>',
    tall: '<div class="listScroll"><img class="is-tallFace" src="./icons/list_5_layout_all.png" alt="Targets"></div>',
    bar: '<div class="listScroll"><img src="./icons/list_3_layout.png" alt="Targets"></div>',
  },
  cam: {
    button: './icons/Cam_button.png',
    open: './icons/Cam_button_open.png',
    body: '<canvas class="camView"></canvas>'
      + '<img class="camOverlay" src="./icons/cam_5_layout.png" alt="Camera">',
    bar: '<canvas class="camView"></canvas>'
      + '<img class="camOverlay" src="./icons/cam_3_layout.png" alt="Camera">',
  },
};

/**
 * THE MENU'S FIVE ROWS, measured off Drop-down.png (709 x 1103): the panel
 * itself, and the band each row owns, as shares of the picture. A row's band
 * runs half way to its neighbours, so pressing anywhere on a row works.
 */
const MENU_PANEL = { top: 22 / 1103, bottom: 934 / 1103 };
const MENU_BANDS = [
  { from: 22, to: 205 },    // EW
  { from: 205, to: 385 },   // Weapon
  { from: 385, to: 565 },   // Radar
  { from: 565, to: 746 },   // Targets
  { from: 746, to: 934 },   // Cam
].map((b) => ({ from: b.from / 1103, to: b.to / 1103 }));

/**
 * A copy of the menu with one row tinted, made in the browser from the grey
 * file. Within the row, every pixel lighter than the panel is carried towards
 * the chosen colour by however much lighter it is, which keeps the smooth
 * edges of the letters instead of cutting them into steps.
 */
const menuTinted = new Map<number, string>();
const menuArt = new Image();
let menuArtReady = false;
menuArt.src = './icons/Drop-down.png';
menuArt.addEventListener('load', () => { menuArtReady = true; refreshOpenMenus(); });

function menuWithRow(row: number): string | null {
  const had = menuTinted.get(row);
  if (had) return had;
  if (!menuArtReady || !menuArt.naturalWidth) return null;
  const w = menuArt.naturalWidth;
  const h = menuArt.naturalHeight;
  const cut = document.createElement('canvas');
  cut.width = w; cut.height = h;
  const g = cut.getContext('2d');
  if (!g) return null;
  g.drawImage(menuArt, 0, 0);
  const band = MENU_BANDS[row];
  const y0 = Math.round(band.from * h);
  const y1 = Math.round(band.to * h);
  const img = g.getImageData(0, y0, w, Math.max(1, y1 - y0));
  const d = img.data;
  const tint = colourBytes(cssText('--pane-menu-mark', '#1FC4B6'));
  // The two ends of the ramp, both found in the band itself: the panel is
  // whatever shade most of it is, and the letters are as light as it gets.
  // Only the solid part of the picture is touched, so the soft shadow that
  // falls outside the panel is left exactly as it was.
  const seen = new Uint32Array(256);
  let top = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const lum = Math.round((d[i] + d[i + 1] + d[i + 2]) / 3);
    seen[lum]++;
    if (lum > top) top = lum;
  }
  let panel = 0;
  for (let v = 0; v < 256; v++) if (seen[v] > seen[panel]) panel = v;
  if (top <= panel + 8) return null;                 // nothing to pick out
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (lum <= panel + 6) continue;                  // the panel itself
    const t = Math.min(1, (lum - panel) / (top - panel));
    d[i] = panel + (tint[0] - panel) * t;
    d[i + 1] = panel + (tint[1] - panel) * t;
    d[i + 2] = panel + (tint[2] - panel) * t;
  }
  g.putImageData(img, 0, y0);
  const url = cut.toDataURL('image/png');
  menuTinted.set(row, url);
  return url;
}

/** "#1FC4B6" to its three numbers. */
function colourBytes(text: string): [number, number, number] {
  const hex = text.trim().replace('#', '');
  if (hex.length !== 6) return [31, 196, 182];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Which screen each pane is showing. */
const paneKind = new WeakMap<HTMLElement, PaneKind>();
const panes = Array.from(document.querySelectorAll<HTMLElement>('.sidePane[data-pane]'));

/** Put the right tinted picture into every menu that is open — used when the
 *  artwork finishes loading after a menu has already been pulled down. */
function refreshOpenMenus(): void {
  for (const pane of panes) {
    const menu = pane.querySelector<HTMLElement>('.paneMenu');
    if (!menu || !menu.classList.contains('is-open')) continue;
    const kind = paneKind.get(pane);
    if (kind) dressMenu(menu, kind);
  }
}

function dressMenu(menu: HTMLElement, kind: PaneKind): void {
  const face = menu.querySelector('img');
  const url = menuWithRow(PANE_ORDER.indexOf(kind));
  if (face && url) face.src = url;
}

function setMenuOpen(pane: HTMLElement, open: boolean): void {
  const menu = pane.querySelector<HTMLElement>('.paneMenu');
  const face = pane.querySelector<HTMLImageElement>('.paneBtn img');
  const kind = paneKind.get(pane);
  if (!menu || !face || !kind) return;
  menu.classList.toggle('is-open', open);
  face.src = open ? PANE_KINDS[kind].open : PANE_KINDS[kind].button;
  if (open) dressMenu(menu, kind);
}

/** Shut every menu but the one named. */
function closeOtherMenus(except?: HTMLElement): void {
  for (const pane of panes) if (pane !== except) setMenuOpen(pane, false);
}

/**
 * THE TALL LIST.
 *
 * The right-hand column of the five-way arrangement holds the targets list on
 * its own, as tall as the two screens it stands in place of. That happens for
 * that column only, and for the list only: the list shown anywhere else is the
 * ordinary square one, and no other screen is ever drawn tall.
 *
 * Choosing something else on the tall list splits the column back into two,
 * and the screen that comes up underneath is --pane-right-spare the first
 * time; after that it is whatever was last shown there.
 */
const rightCol = document.getElementById('rightCol');
const tallPane = rightCol?.querySelector<HTMLElement>('.sidePane');
const sparePane = rightCol?.querySelector<HTMLElement>('.sidePane:last-child');
/** True once a second screen has been asked for in that column. */
let rightSplit = false;
function columnIsTall(): boolean {
  return !rightSplit && paneKind.get(tallPane as HTMLElement) === 'targets';
}
function isTallPane(pane: HTMLElement): boolean {
  return !!tallPane && pane === tallPane && columnIsTall();
}

/** The two screens of the BAR beside the map — the arrangement with one tall
 *  screen above a square one. They are slots like all the others: the button
 *  in the corner chooses what is on them. */
function isBarPane(pane: HTMLElement): boolean {
  return pane.parentElement?.id === 'sideCol';
}
function updateTallColumn(): void {
  if (!rightCol || !tallPane) return;
  rightCol.classList.toggle('is-tall', columnIsTall());
}

/** Build one pane: the screen itself, its button, and the menu under it. */
function setPaneKind(pane: HTMLElement, kind: PaneKind): void {
  paneKind.set(pane, kind);
  pane.className = 'sidePane';
  if (kind === 'radar') pane.classList.add('radarPane');
  if (kind === 'weapon') pane.classList.add('weaponPane');
  if (kind === 'cam') pane.classList.add('camPane');
  if (pane === tallPane) updateTallColumn();     // before the face is chosen
  const art = PANE_KINDS[kind];
  // Which of its faces: the taller one in the tall slot, the bar's own where
  // the screen has one drawn at that shape, and otherwise its usual face.
  pane.innerHTML = (isTallPane(pane) && art.tall) ? art.tall
    : (isBarPane(pane) && art.bar) ? art.bar
      : art.body;

  // The camera's markings may not be in the folder: without them the picture
  // simply shows on its own rather than leaving a broken image behind.
  for (const overlay of pane.querySelectorAll<HTMLImageElement>('.camOverlay')) {
    overlay.addEventListener('error', () => overlay.classList.add('is-missing'));
    if (overlay.complete && overlay.naturalWidth === 0) overlay.classList.add('is-missing');
  }
  // A camera screen built while the lens is already tight is given the quiet
  // markings at once, rather than waiting for the zoom to change again.
  if (kind === 'cam') dressCamOverlays();
  if (kind === 'weapon') buildWeaponPane(pane);
  if (kind === 'targets') { wireListPresses(); dressRowRings(); }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paneBtn';
  btn.setAttribute('aria-label', `Screen: ${kind}`);
  const face = document.createElement('img');
  face.src = PANE_KINDS[kind].button;
  face.alt = '';
  btn.appendChild(face);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !pane.querySelector('.paneMenu')?.classList.contains('is-open');
    closeOtherMenus(pane);
    setMenuOpen(pane, open);
  });
  pane.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'paneMenu';
  // Where it hangs is worked out in the stylesheet, from the button's own
  // size and the two pictures' shapes — see .paneMenu in map.html. Nothing
  // is measured here, so it stays right through any resize.
  const face2 = document.createElement('img');
  face2.src = './icons/Drop-down.png';
  face2.alt = '';
  menu.appendChild(face2);
  PANE_ORDER.forEach((other, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'paneMenuRow';
    row.dataset.kind = other;
    row.setAttribute('aria-label', other);
    row.style.top = `${MENU_BANDS[i].from * 100}%`;
    row.style.height = `${(MENU_BANDS[i].to - MENU_BANDS[i].from) * 100}%`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      // Choosing another screen on the TALL list does not take the list's
      // place: the list draws itself back up to the ordinary square, stays
      // where it is, and the screen chosen comes up underneath it. Choosing
      // the list again puts it back to its full height.
      if (pane === tallPane && sparePane && columnIsTall() && other !== 'targets') {
        rightSplit = true;
        updateTallColumn();
        setPaneKind(pane, 'targets');          // short now, same place
        setPaneKind(sparePane, other);
        setMenuOpen(pane, false);
        return;
      }
      if (pane === tallPane && other === 'targets') rightSplit = false;
      setPaneKind(pane, other);
    });
    menu.appendChild(row);
  });
  pane.appendChild(menu);
}

for (const pane of panes) {
  const want = (pane.dataset.pane ?? 'radar') as PaneKind;
  setPaneKind(pane, PANE_ORDER.includes(want) ? want : 'radar');
}
// The spare screen under the tall list — what it shows the first time the
// column splits in two.
if (sparePane && sparePane !== tallPane) {
  const spare = cssText('--pane-right-spare', 'radar').trim() as PaneKind;
  if (PANE_ORDER.includes(spare)) setPaneKind(sparePane, spare);
}
updateTallColumn();
// A press anywhere else puts the menus away, the way a menu should behave.
document.addEventListener('click', () => closeOtherMenus());
/**
 * ══ HOLD ════════════════════════════════════════════════════════════════════
 *
 * Press the clock on the top panel, or Esc, and everything stops where it
 * is: the simulator hangs the flight, and here the threats' clocks stop, so
 * one that is half way through its sequence stays half way through it. Press
 * again and both go on from exactly there.
 *
 * THE CLOCKS ARE SHIFTED, NOT STOPPED. Each threat remembers the moment it
 * began, against the clock on the wall; when the hold ends, however long it
 * lasted is added to that moment, so it carries on where it was instead of
 * jumping forward by the length of the hold.
 *
 * Esc has a job already — it puts away an open menu — and that comes first:
 * with a menu down, Esc closes it and nothing is held.
 */
function setPausedHere(on: boolean, tell = true): void {
  if (on === paused) return;
  paused = on;
  if (on) {
    heldAt = performance.now();
  } else {
    const held = performance.now() - heldAt;
    for (const cue of cues) if (cue.started) cue.started += held;
  }
  topPanelEl.classList.toggle('is-held', on);
  if (tell) channel.postMessage({ kind: 'pause', on } satisfies PauseOrder);
  dirty = true;
}

/**
 * ══ START AGAIN ═════════════════════════════════════════════════════════════
 *
 * The key at the right-hand end of the top panel. One press and both windows
 * go back to how they began, each putting its own house in order: the word is
 * sent to the simulator, which puts the aircraft on its start point and the
 * truck back on its wheels, whole and unburnt; and here —
 *
 *   · nothing is struck any more, so the marks come back with their own
 *     faces and the envelope with them;
 *   · nothing is chosen, nothing is slaved, the designation box goes;
 *   · every store is back on its pylon;
 *   · and the satellite picture is ASKED FOR AFRESH — every tile is dropped
 *     and fetched again, so a patch that came down wrong comes down again.
 *
 * The flight's own track and the threat cues need no word here: the simulator
 * counts a new run, and the map drops both the moment it sees the new number.
 */
function startAgain(): void {
  channel.postMessage({ kind: 'reset' } satisfies ResetOrder);
  destroyed.clear();
  picked.clear();
  spent.clear();
  setSlaved(null);
  clearTd();
  tiles.clear();                            // the satellite picture, afresh
  for (const pane of document.querySelectorAll<HTMLElement>('.weaponPane')) {
    setWeaponPicked(pane, -1);
    dressWeaponPane(pane);
  }
  dressRowRings();
  setPausedHere(false);                     // never start again held
  dirty = true;
}

document.getElementById('topReset')?.addEventListener('click', (e) => {
  e.stopPropagation();
  startAgain();
});

/** The clock on the top panel is the button. */
document.getElementById('topClock')?.addEventListener('click', (e) => {
  e.stopPropagation();
  setPausedHere(!paused);
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // A menu that is down is what Esc is for; only with none down does it hold.
  const open = document.querySelector('.paneMenu.is-open') || layoutMenu.classList.contains('is-open');
  if (open) { closeOtherMenus(); setLayoutMenuOpen(false); return; }
  setPausedHere(!paused);
});

/**
 * ══ THE DATA CONTROL, AND ITS THREE MODES ═══════════════════════════════════
 *
 * One picture with three faces — data_mode1, 2 and 3 — and the top cell of it,
 * the one with the two arrows, is the key: press it and the next face comes
 * up, press it on the last and the first is back.
 *
 * The three are the same size to the pixel and are drawn in the same box, so
 * nothing moves as they change: it reads as a button being pressed rather
 * than as one picture swapped for another. Only the TOP CELL answers — a
 * press lower down, on the readings themselves, does nothing — and how far
 * down it reaches is --btn-datamode-key.
 */
const DATA_MODES = [
  './icons/data_mode1.png',
  './icons/data_mode2.png',
  './icons/data_mode3.png',
];
let dataMode = 0;
const dataModeBtn = document.getElementById('btnDataMode') as HTMLImageElement | null;
for (const src of DATA_MODES) new Image().src = src;   // no blink on the first press

dataModeBtn?.addEventListener('click', (e) => {
  const box = dataModeBtn.getBoundingClientRect();
  if (!box.height) return;
  const share = (e.clientY - box.top) / box.height;
  const key = cssNumber('--btn-datamode-key', 25) / 100;
  if (share > key) return;                   // not on the key: nothing happens
  dataMode = (dataMode + 1) % DATA_MODES.length;
  dataModeBtn.src = DATA_MODES[dataMode]!;
});

friendsBtn.addEventListener('click', () => setFriendsOpen(!friendsOpen));
// A heading is a switch: it shuts its own list, and opens it again.
foesBar.addEventListener('click', () => { foesListOpen = !foesListOpen; dressLists(); });
friendsBar.addEventListener('click', () => { friendListOpen = !friendListOpen; dressLists(); });
// Every face the panel can wear is fetched up front, so a press swaps the
// picture without a blink.
for (const src of [
  FRIENDS_OPEN, LIST_BOTH.src, LIST_FRIENDS_FULL.src, LIST_FOES_FULL.src,
  FOES_BAR.open, FOES_BAR.shut, FRIENDS_BAR.open, FRIENDS_BAR.shut,
]) {
  new Image().src = src;
}

/**
 * Two things are done to every button as it loads.
 *
 * MISSING ARTWORK: a button whose PNG is not in public/icons yet hides itself
 * rather than leaving a broken image in the stack — drop the file in and it
 * appears, in its place in the order. The check is made twice over, because an
 * image that failed before this script ran has already fired (and lost) its
 * error event; `naturalWidth === 0` on a finished image is what catches it.
 *
 * THE GLOW: some of the artwork carries a soft shadow, which is transparent
 * pixels around the shape — 6.5% a side on some of these, none at all on
 * others. Those pixels are part of the image, so they push the next button
 * away and knock the right edges out of line. Measuring the opaque bounds and
 * pulling the image in by its own padding puts the SPACING BETWEEN WHAT IS
 * VISIBLE, which is the only thing the eye can see, and does it for whatever
 * artwork is added later without anyone having to measure anything.
 */
/** Scratch canvas for measuring artwork. Made on first use: this file's
 *  start-up runs before the module's later declarations exist, and a `const`
 *  further down would be unreachable from a function called up here. */
let _fitCanvas: HTMLCanvasElement | null = null;

/**
 * How much of a pixel a pixel is.
 *
 * The sizes in map.html are Figma's, measured against a frame of a certain
 * size (--ui-design-w x --ui-design-h). With --ui-fit: design they are scaled
 * so that the WHOLE frame fits the window — the smaller of the two ratios,
 * width and height. Taking the width alone, as this did at first, is what
 * broke the moment a window was not the frame's shape: a panel 567 frame-units
 * tall, worked out from the width of a short window, came out taller than the
 * space there was for it, while the map — which simply fills what is left —
 * went on looking right. One number for both axes keeps every part of the
 * design in proportion with every other on any screen.
 *
 * With --ui-fit: px the sizes are taken literally instead.
 */
function uiScale(): number {
  const css = getComputedStyle(document.documentElement);
  if (css.getPropertyValue('--ui-fit').trim() !== 'design') return 1;
  const designW = parseFloat(css.getPropertyValue('--ui-design-w'));
  const designH = parseFloat(css.getPropertyValue('--ui-design-h'));
  if (!Number.isFinite(designW) || designW <= 0) return 1;
  const byWidth = window.innerWidth / designW;
  if (!Number.isFinite(designH) || designH <= 0) return byWidth;
  // The frame, fitted whole: the window takes as much of the design as fits
  // both ways. The top panel is the one thing that bleeds wider than the
  // frame — it spans the window — but its HEIGHT is held to the design's
  // (--toppanel-h), so the height left under it is the design's too and this
  // one factor governs everything on the screen.
  return Math.min(byWidth, window.innerHeight / designH);
}


/** Publish the scaled gap and edge, which are plain CSS and not touched by JS
 *  anywhere else. The buttons themselves are scaled in {@link fitButton}. */
function applyScaleToCss(scale: number): void {
  const root = document.documentElement;
  // The factor itself, for anything drawn in CSS rather than from a PNG: a
  // rule can then write calc(14px * var(--ui-scale-num)) and scale with the
  // rest of the screen without another knob here.
  root.style.setProperty('--ui-scale-num', scale.toFixed(4));
  const css = getComputedStyle(root);
  const knobs = [
    '--toppanel-h', '--sidepane-gap',
    '--btn-gap', '--btn-edge', '--panel-gap',
    '--readout-fuel-size', '--readout-alt-size', '--bottompanel-bottom',
  ];
  for (const knob of knobs) {
    const base = parseFloat(css.getPropertyValue(knob));
    if (Number.isFinite(base)) root.style.setProperty(`${knob}-fitted`, `${(base * scale).toFixed(2)}px`);
  }
}

/** How wide the artwork inside an image is, in the IMAGE's own pixels. */
function artworkWidth(b: HTMLImageElement): number | null {
  const pad = glowPadding(b);
  if (!pad) return null;
  return b.naturalWidth * (1 - pad.l - pad.r);
}

/** How wide the artwork inside an image actually draws, in screen px. */
function visibleWidth(b: HTMLImageElement): number | null {
  const pad = glowPadding(b);
  if (!pad) return null;
  const box = b.getBoundingClientRect();
  if (!box.width) return null;
  return box.width * (1 - pad.l - pad.r);
}

/** The transparent margin around an image, as a fraction of its size. */
function glowPadding(img: HTMLImageElement): { t: number; r: number; b: number; l: number } | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  _fitCanvas ??= document.createElement('canvas');
  _fitCanvas.width = w;
  _fitCanvas.height = h;
  const c = _fitCanvas.getContext('2d', { willReadFrequently: true });
  if (!c) return null;
  c.clearRect(0, 0, w, h);
  c.drawImage(img, 0, 0);
  let data: Uint8ClampedArray;
  try {
    data = c.getImageData(0, 0, w, h).data;
  } catch {
    return null; // a cross-origin image would taint the canvas; ours never do
  }
  // WHAT COUNTS AS THE BUTTON, and what is only its shadow.
  //
  // Some of the artwork is exported with its drop shadow baked in and some
  // without — and a shadow is transparent, so measuring "anything not quite
  // transparent" puts the shadowed ones a good ten pixels further in than the
  // flat ones, however carefully the gaps are set. --btn-ink is the line
  // between the two: a pixel belongs to the button when it is at least that
  // share of the artwork's own strongest pixel, and anything fainter is
  // shadow. Measuring against the artwork's own peak rather than a fixed
  // number keeps a plate drawn at 70% opacity from being read as a shadow.
  let peak = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > peak) peak = data[i];
  const ink = Math.max(9, (peak * cssNumber('--btn-ink', 50)) / 100);

  let top = h, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < ink) continue; // shadow, not the button
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return null; // fully transparent
  return { t: top / h, r: (w - 1 - right) / w, b: (h - 1 - bottom) / h, l: left / w };
}

/**
 * Lay one button out at the size asked for in map.html.
 *
 * THE NUMBERS IN map.html ARE THE SIZE ON THE SCREEN — what a ruler, or
 * Figma's Layout panel, measures across the artwork itself. That is not the
 * image's size, because the glow is part of the image: an icon carrying 6.5%
 * of padding a side, given a plain `width: 64px`, would draw a 56 px button
 * inside a 64 px image. Each side is therefore enlarged by exactly the padding
 * it carries and pulled back in by the same amount, so what is left over the
 * map matches Figma to the pixel, whatever artwork is used.
 *
 * A button has a width knob and a height knob. Either may be `auto`, meaning
 * "follow the artwork's own proportions" — that side is then worked out from
 * the VISIBLE shape, not from the padded image, so one number is enough for
 * anything whose Figma size is its natural ratio. Give both and the button is
 * exactly that box, which is how a design that differs a little from the
 * export (the 2D / 3D switch, 64 x 86) still comes out at its stated size.
 */
function fitButton(b: HTMLImageElement): void {
  if (!b.complete) return;
  if (b.naturalWidth === 0) { b.classList.add('is-missing'); return; }
  b.classList.remove('is-missing');
  const pad = glowPadding(b);
  if (!pad) return;
  // Drop a width this function resolved earlier, so the knob in map.html — not
  // the last answer — is what is read below.
  b.style.removeProperty('--w');
  const style = getComputedStyle(b);
  // Two widths are not numbers but relationships to another element, named in
  // the markup (data-match / data-scale). Both are resolved into a plain width
  // here, in knob units, so everything downstream stays the same:
  //   match  exactly as wide as that element — a list under its own button.
  //   panel  the same SCALE as that element — the artwork keeps the size it
  //          has in the design relative to it, which is what makes a bar sit
  //          under a list as if the two had been exported as one picture.
  const knobW = style.getPropertyValue('--w').trim();
  if (knobW === 'match' || knobW === 'panel') {
    const refId = knobW === 'match' ? b.dataset.match : b.dataset.scale;
    const ref = refId ? (document.getElementById(refId) as HTMLImageElement | null) : null;
    const refWidth = ref ? visibleWidth(ref) : null;
    if (ref === null || refWidth === null) return;
    const mine = artworkWidth(b);
    const theirs = artworkWidth(ref);
    if (mine === null || theirs === null || theirs === 0) return;
    const want = knobW === 'match' ? refWidth : refWidth * (mine / theirs);
    b.style.setProperty('--w', `${(want / uiScale()).toFixed(2)}px`); // in knob units
  }
  // `auto`, anything non-numeric, or a missing knob all come back NaN.
  const askedW = parseFloat(style.getPropertyValue('--w'));
  const askedH = parseFloat(style.getPropertyValue('--h'));
  // What fraction of the image is artwork rather than glow, per axis.
  const keepW = 1 - pad.l - pad.r;
  const keepH = 1 - pad.t - pad.b;
  if (keepW <= 0 || keepH <= 0) return;
  // The VISIBLE artwork's own proportions, for whichever side says `auto`.
  const visAspect = (b.naturalHeight * keepH) / (b.naturalWidth * keepW);
  let visW = askedW;
  let visH = askedH;
  if (!Number.isFinite(visW) && !Number.isFinite(visH)) return; // nothing asked
  if (!Number.isFinite(visW)) visW = visH / visAspect;
  if (!Number.isFinite(visH)) visH = visW * visAspect;
  if (visW <= 0 || visH <= 0) return;
  const scale = uiScale(); // Figma's frame vs this window
  b.style.width = `${((visW * scale) / keepW).toFixed(2)}px`;
  b.style.height = `${((visH * scale) / keepH).toFixed(2)}px`;
  const box = b.getBoundingClientRect();
  if (!box.width || !box.height) return;
  b.style.margin = [
    `${-(pad.t * box.height).toFixed(2)}px`,
    `${-(pad.r * box.width).toFixed(2)}px`,
    `${-(pad.b * box.height).toFixed(2)}px`,
    `${-(pad.l * box.width).toFixed(2)}px`,
  ].join(' ');
}

/**
 * Work out how big the four screens beside the map should be.
 *
 * Their proportions are the artwork's (--sidepane-w : --sidepane-h) and are
 * never departed from. What changes with the window is their SIZE: with
 * --sidepane-grow they take the full height of their column, which is what
 * keeps a screen that is not the frame's shape from showing a band of dead
 * space above and below them; with it off they stay exactly the size the
 * design gives them. Either way the map takes whatever width is left.
 */
function sizeSidePanes(): void {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const designW = parseFloat(css.getPropertyValue('--sidepane-w'));
  const designH = parseFloat(css.getPropertyValue('--sidepane-h'));
  if (!Number.isFinite(designW) || !Number.isFinite(designH) || designH <= 0) return;
  const scale = uiScale();
  const grow = parseFloat(css.getPropertyValue('--sidepane-grow')) === 1;
  const gap = parseFloat(css.getPropertyValue('--sidepane-gap')) || 0;   // design px
  // Two screens and the gap between them share the height under the top panel.
  const available = screenEl.getBoundingClientRect().height;
  let h = designH * scale;
  if (grow && available > 0) h = Math.max(h, (available - gap * scale) / 2);
  let w = (h * designW) / designH;
  // …but never so wide that the map is squeezed out.
  const maxVw = parseFloat(css.getPropertyValue('--sidepane-max-vw'));
  if (Number.isFinite(maxVw) && maxVw > 0) {
    const maxW = (window.innerWidth * maxVw) / 100;
    if (w > maxW) { w = maxW; h = (w * designH) / designW; }
  }
  root.style.setProperty('--sidepane-w-px', `${w.toFixed(2)}px`);
  root.style.setProperty('--sidepane-h-px', `${h.toFixed(2)}px`);

  // The map's own box in the five-way arrangement: the square the design
  // gives it, --layout-five-centre across and --layout-five-height down.
  const centre = parseFloat(css.getPropertyValue('--layout-five-centre'));
  const centreH = parseFloat(css.getPropertyValue('--layout-five-height'));
  if (Number.isFinite(centre) && Number.isFinite(centreH)) {
    root.style.setProperty('--mapbox-w-px', `${(centre * scale).toFixed(2)}px`);
    root.style.setProperty('--mapbox-h-px', `${(centreH * scale).toFixed(2)}px`);
  }
  // …and the square each side gets in the half-and-half arrangement.
  const half = parseFloat(css.getPropertyValue('--layout-half-size'));
  if (Number.isFinite(half)) {
    root.style.setProperty('--halfbox-px', `${(half * scale).toFixed(2)}px`);
  }

  // …and the map with a bar beside it: the map takes --layout-side-map across
  // and all the height there is under the top panel; the bar is a column of
  // two, the lower one square and the upper one taking what is left, so the
  // three of them fill the height exactly.
  const frameH = parseFloat(css.getPropertyValue('--ui-design-h'));
  const panelH = parseFloat(css.getPropertyValue('--toppanel-h'));
  const sideMap = parseFloat(css.getPropertyValue('--layout-side-map'));
  const sidePane = parseFloat(css.getPropertyValue('--layout-side-pane'));
  if ([frameH, panelH, sideMap, sidePane].every(Number.isFinite)) {
    const under = frameH - panelH;                  // the height below the panel
    const top = Math.max(0, under - sidePane - gap);     // gap: design px too
    root.style.setProperty('--sidemap-w-px', `${(sideMap * scale).toFixed(2)}px`);
    root.style.setProperty('--sidemap-h-px', `${(under * scale).toFixed(2)}px`);
    root.style.setProperty('--sidebar-w-px', `${(sidePane * scale).toFixed(2)}px`);
    root.style.setProperty('--sidebar-bottom-px', `${(sidePane * scale).toFixed(2)}px`);
    root.style.setProperty('--sidebar-top-px', `${(top * scale).toFixed(2)}px`);
  }
}

/**
 * Re-measure every button: after a load, a resize, or a size change.
 *
 * Twice over, because some widths are relationships: a list is `match`ed to
 * the button it hangs from, and the targets bar is drawn at the friend list's
 * scale. A single pass resolves those against whatever the other element
 * happened to measure at the time — which, before its own artwork has been
 * sized, is the raw PNG. The second pass reads the settled sizes.
 */
/**
 * THE NORTH DOT on the aircraft-icon button.
 *
 * icon.png has a pale ring drawn into it, and the dot rides that ring at true
 * north. How far out that is depends on the size the button ends up, so the
 * radius is worked out here — a share of the button's own width — and handed
 * to the CSS, which turns the dot to the angle. The angle itself is set every
 * frame from the map's own heading, so the dot and the ring round the aircraft
 * always point the same way.
 */
function placeIconNorth(): void {
  const btn = document.getElementById('btnIcon') as HTMLImageElement | null;
  const dot = document.getElementById('iconNorth');
  if (!btn || !dot) return;
  const width = btn.getBoundingClientRect().width;
  if (width <= 0) return;
  const share = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--iconnorth-radius'));
  if (!Number.isFinite(share)) return;
  document.documentElement.style.setProperty(
    '--iconnorth-r', `${((width * share) / 100).toFixed(2)}px`,
  );
}

/**
 * THE CLOCK IN THE TOP PANEL.
 *
 * The panel is stretched to the width of the window, so a knob written in
 * design px means a different number of real pixels at each window size: the
 * sideways ones are worked against the PANEL'S OWN WIDTH, and the up-and-down
 * ones against the scale, since the panel's height is held to the design's.
 * The figures are then written over a patch of the box's own background.
 */
function placeClock(): void {
  const clock = document.getElementById('topClock');
  if (!clock) return;
  const off = cssNumber('--clock-show', 1) === 0;
  clock.classList.toggle('is-off', off);
  if (off) return;
  const panelW = topPanelEl.getBoundingClientRect().width;
  const designW = cssNumber('--ui-design-w', 2296);
  if (!panelW || !designW) return;
  const across = panelW / designW;          // design px → real px, sideways
  const scale = uiScale();                  // …and down the panel
  const root = document.documentElement;
  const put = (name: string, value: number) =>
    root.style.setProperty(`${name}-px`, `${value.toFixed(2)}px`);
  put('--clock-patch-x', cssNumber('--clock-patch-x', 10) * across);
  put('--clock-patch-w', cssNumber('--clock-patch-w', 92) * across);
  put('--clock-patch-y', cssNumber('--clock-patch-y', 19) * scale);
  put('--clock-patch-h', cssNumber('--clock-patch-h', 94) * scale);
  put('--clock-size', cssNumber('--clock-size', 22.6) * scale);
  put('--clock-line', cssNumber('--clock-line', 31.1) * scale);
  put('--clock-tracking', cssNumber('--clock-tracking', 0) * scale);

  // …and the start-again key at the other end of the same bar, measured the
  // same way: sideways against the panel's width, down against the scale.
  const key = document.getElementById('topReset');
  if (!key) return;
  const keyOff = cssNumber('--reset-key-show', 1) === 0;
  key.classList.toggle('is-off', keyOff);
  if (keyOff) return;
  put('--reset-key-x', cssNumber('--reset-key-x', 2213.4) * across);
  put('--reset-key-w', cssNumber('--reset-key-w', 80.6) * across);
  put('--reset-key-y', cssNumber('--reset-key-y', 2) * scale);
  put('--reset-key-h', cssNumber('--reset-key-h', 124) * scale);
}

/** The time itself, written into the three lines. */
function tickClock(): void {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const h = document.getElementById('clockH');
  const m = document.getElementById('clockM');
  const sec = document.getElementById('clockS');
  if (h) h.textContent = two(now.getHours());
  if (m) m.textContent = two(now.getMinutes());
  if (sec) sec.textContent = two(now.getSeconds());
}
tickClock();
setInterval(tickClock, 250);   // four times a second: the second never lags

function fitButtons(): void {
  applyScaleToCss(uiScale());
  sizeSidePanes();
  readRouteStyle();
  for (let pass = 0; pass < 2; pass++) {
    for (const b of mapButtons) fitButton(b);
  }
  placeIconNorth();
  placeClock();
  placeListBars();
  wireListPresses();
  dressRowRings();
}

applyScaleToCss(uiScale());
for (const overlay of document.querySelectorAll<HTMLImageElement>('.camOverlay')) {
  // The markings file may not be in the folder yet: without it the picture
  // simply shows on its own, rather than leaving a broken image behind.
  overlay.addEventListener('error', () => overlay.classList.add('is-missing'));
  if (overlay.complete && overlay.naturalWidth === 0) overlay.classList.add('is-missing');
}

for (const b of mapButtons) {
  b.addEventListener('error', () => b.classList.add('is-missing'));
  // The whole set, not just this one: artwork arriving changes what the
  // elements that are sized against it should be.
  b.addEventListener('load', fitButtons);
}
fitButtons();
// The glow compensation is in pixels, so it is recomputed whenever the buttons
// could have changed size.
window.addEventListener('resize', fitButtons);

/**
 * Try a control size without editing map.html: in this window's console,
 *
 *     __ui('--btn-zoom-w', 64)      // the zoom pill, 64 px wide
 *     __ui('--btn-23d-h', 86)       // and the 2D / 3D switch, 86 px tall
 *     __ui('--ui-fit', 'px')        // stop scaling: the numbers, literally
 *     __ui('--ui-design-w', 2560)   // the Figma frame these numbers came from
 *     __ui('--btn-gap', 8)          // more air between the buttons
 *     __ui()                        // list every knob and its current value
 *
 * A number is taken as pixels. Nothing is saved — reloading brings back the
 * values written in map.html, which is where a size you want to keep belongs.
 */
Object.defineProperty(window, '__ui', {
  configurable: true,
  value: (name?: string, value?: string | number) => {
    const root = document.documentElement;
    if (name === undefined) {
      // Every --btn-* knob declared in this page's :root, with its value.
      const names = Array.from(document.styleSheets)
        .flatMap((sheet) => {
          try { return Array.from(sheet.cssRules); } catch { return []; }
        })
        .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ':root')
        .flatMap((r) => Array.from(r.style).filter((p) => p.startsWith('--btn-')));
      const out: Record<string, string> = {};
      for (const n of names) out[n] = getComputedStyle(root).getPropertyValue(n).trim();
      console.table(out);
      return out;
    }
    const key = name.startsWith('--') ? name : `--${name}`;
    root.style.setProperty(key, typeof value === 'number' ? `${value}px` : String(value));
    fitButtons();
    return getComputedStyle(root).getPropertyValue(key).trim();
  },
});

// -- the bottom data panel ----------------------------------------------------
// The panel is artwork; the numbers on it are not. Fuel comes from the
// simulator, which owns the flight and so the fuel clock, and is written in
// the style of the design: a number with a comma every three digits, then its
// unit. The height is worked out just the same but is not shown — see
// --readout-alt-show in map.html.

/** 13594 → "13,594". */
const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Whether the height is shown at all; off, as the design now has it. */
const altShown = cssNumber('--readout-alt-show', 0) !== 0;
document.getElementById('altReadout')?.classList.toggle('is-off', !altShown);

/** Put the current fix's numbers on the panel. */
function drawReadouts(f: MapFix): void {
  fuelNumEl.textContent = thousands(f.fuelLb);
  // To the nearest ten feet: the altitude is live, and the last digit of a
  // 24,500 ft readout flickering on every frame would be noise, not data.
  if (altShown) altNumEl.textContent = thousands(Math.round(f.altFt / 10) * 10);
}

// The panel hides itself until its PNG is in public/icons, so the numbers never
// float over the map on their own.
function checkBottomPanel(): void {
  const missing = bottomPanelImg.complete && bottomPanelImg.naturalWidth === 0;
  // If it is the LIT panel that is not there, the plain one is put back
  // rather than the whole panel going dark: the camera is still held, it
  // simply does not show on the key.
  if (missing && bottomPanelImg.src.includes('_slave')) {
    bottomPanelImg.src = PANEL_PLAIN;
    return;
  }
  bottomPanelEl.classList.toggle('is-missing', missing);
}
bottomPanelImg.addEventListener('load', checkBottomPanel);
bottomPanelImg.addEventListener('error', checkBottomPanel);
checkBottomPanel();

// -- the link to the simulator -----------------------------------------------

const channel = new BroadcastChannel(MAP_CHANNEL);
channel.onmessage = (e: MessageEvent<MapMessage>) => {
  const message = e.data;
  if (!message) return;
  // A picture from the camera under the aircraft travels on the same channel.
  if ('kind' in message && message.kind === 'cam') {
    noteCamFov(message.fov);
    takeCamFrame(message.image);
    return;
  }
  // The trigger, pulled in the other window.
  if ('kind' in message && message.kind === 'fire') {
    fireWeapon();
    return;
  }
  // Held, or let go, from the other window.
  if ('kind' in message && message.kind === 'pause') {
    setPausedHere(message.on, false);
    return;
  }
  // A camera key on the throttle: b6 is the Slave key, b7 puts the camera
  // back to resting and lets any mark go.
  if ('kind' in message && message.kind === 'camkey') {
    if (message.what === 'slave') pressSlaveKey();
    else if (slavedId) setSlaved(null);
    return;
  }
  const next = message as MapFix;
  if (typeof next.lat !== 'number') return;
  if (!fix) waitEl.classList.add('is-hidden'); // the first fix: show the map
  fix = next;
  noteStruck(next.struck);
  rememberLead(next);
  updateCue(next);
  drawReadouts(next);
  dirty = true;
};

/** Shortest signed angle from `a` to `b` (rad). */
function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function frame(): void {
  if (fix) {
    const target = (fix.headingDeg * Math.PI) / 180;
    if (!haveMapHeading) { mapHeading = target; haveMapHeading = true; dirty = true; }
    const d = angleDelta(mapHeading, target);
    if (Math.abs(d) > 0.0005) { mapHeading += d * HEADING_EASE; dirty = true; }

    if (cueRunning()) dirty = true;           // the rings are on a clock

    // The north dot on the icon button, turned the way the map is turned.
    document.documentElement.style.setProperty(
      '--north-deg', `${((-mapHeading * 180) / Math.PI).toFixed(2)}deg`,
    );

    const dLat = fix.lat - mapLat;
    const dLon = fix.lon - mapLon;
    if (!haveMapPos || Math.abs(dLat) > JUMP_DEG || Math.abs(dLon) > JUMP_DEG) {
      mapLat = fix.lat; mapLon = fix.lon; haveMapPos = true; dirty = true;
    } else if (Math.abs(dLat) > 1e-9 || Math.abs(dLon) > 1e-9) {
      mapLat += dLat * POS_EASE;
      mapLon += dLon * POS_EASE;
      dirty = true;
    }
  }
  // EACH PIECE OF THE FRAME STANDS ON ITS OWN, and the next frame is asked
  // for whatever happens. One screen that cannot draw itself — a picture
  // that is not there yet, a window measured at nothing — used to throw out
  // of the middle of the frame and take everything after it with it: the
  // camera, the radar, and the request for the next frame, so the map simply
  // stopped. Now a bad frame costs that one screen, that once.
  try {
    if (dirty) { dirty = false;
      draw();
    }
  } catch (err) {
    console.error('map: draw failed this frame', err);
  }
  try { drawRadar(performance.now()); } catch (err) { console.error('map: radar', err); }
  try { drawEw(); } catch (err) { console.error('map: EW', err); }
  try { drawCam(); } catch (err) { console.error('map: camera', err); }
  requestAnimationFrame(frame);
}

applyLayout(layout); // the arrangement the map opens in
resize();
// The panel decides how much height is left for the map, so the canvas is
// measured again once the image has loaded and taken its place.
if (!topPanelEl.complete) topPanelEl.addEventListener('load', resize, { once: true });
requestAnimationFrame(frame);

// -- the radar screen --------------------------------------------------------
/**
 * THE TRACES ON THE RADAR SCREEN.
 *
 * radar_5_layout.png is the screen itself — the grid, the frame, the little
 * "Radar" tab — and nothing else. What sits on it, the cyan triangles and the
 * yellow squares, is drawn here, over the artwork, so that it can live: every
 * --radar-interval a few traces fade out and come back a short way off, and
 * one may leave or arrive altogether. Nothing ever jumps; each one crosses
 * over in --radar-fade, and the count is held between --radar-min and
 * --radar-max so the screen neither empties nor fills.
 *
 * Positions are SHARES of the screen, not pixels, so the same picture serves
 * the screen at 570 in the five-way arrangement and at 1140 in the
 * half-and-half one. Sizes are design px measured on the radar screen as it
 * is drawn in Figma — --radar-basis wide — and grow with the screen the same
 * way, so a trace always covers the same part of the grid.
 *
 * The list below is the screen as it was designed — every trace in its place.
 * It is where the radar starts each time the map is opened.
 */
interface RadarTrace {
  kind: 'tri' | 'sq';
  hollow: boolean;
  up: boolean;          // triangles only: which way it points
  x: number;            // share of the screen's width
  y: number;            // share of its height
  /** 0 → gone, 1 → fully there; anything between is a fade. */
  alpha: number;
  fading: -1 | 0 | 1;   // out, still, in
  /** Where it is coming back to, once it has faded out. */
  next?: { x: number; y: number };
  /** True once it has gone for good, so its slot can be reused. */
  spent?: boolean;
}

const RADAR_DESIGNED: Omit<RadarTrace, 'alpha' | 'fading'>[] = [
  { kind: 'tri', hollow: false, up: true,  x: 0.5705, y: 0.2925 },
  { kind: 'tri', hollow: false, up: false, x: 0.6695, y: 0.3934 },
  { kind: 'sq',  hollow: true,  up: true,  x: 0.2820, y: 0.4004 },
  { kind: 'sq',  hollow: false, up: true,  x: 0.5535, y: 0.4711 },
  { kind: 'tri', hollow: true,  up: false, x: 0.6955, y: 0.4829 },
  { kind: 'tri', hollow: false, up: false, x: 0.5938, y: 0.6167 },
  { kind: 'sq',  hollow: false, up: true,  x: 0.3420, y: 0.6182 },
  { kind: 'tri', hollow: false, up: false, x: 0.6275, y: 0.6564 },
];

let radarTraces: RadarTrace[] = RADAR_DESIGNED.map((t) => ({ ...t, alpha: 1, fading: 0 }));
let radarStirred = 0;        // when the picture was last stirred

/** The patch of screen the traces keep to — the area they occupy as designed,
 *  with a little room around it, so a drifting trace never wanders off. */
const radarField = {
  x0: Math.min(...RADAR_DESIGNED.map((t) => t.x)) - 0.04,
  x1: Math.max(...RADAR_DESIGNED.map((t) => t.x)) + 0.04,
  y0: Math.min(...RADAR_DESIGNED.map((t) => t.y)) - 0.04,
  y1: Math.max(...RADAR_DESIGNED.map((t) => t.y)) + 0.04,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Stir the picture: move a few, and let one leave or arrive. */
function stirRadar(): void {
  const move = Math.round(cssNumber('--radar-change', 3));
  const flux = Math.round(cssNumber('--radar-flux', 1));
  const drift = cssNumber('--radar-drift', 3.5) / 100;
  const min = Math.round(cssNumber('--radar-min', 10));
  const max = Math.round(cssNumber('--radar-max', 14));

  const here = radarTraces.filter((t) => !t.spent && t.alpha > 0);
  const pick = (): RadarTrace | undefined =>
    here.filter((t) => t.fading === 0)[Math.floor(Math.random() * here.length)];

  for (let i = 0; i < move; i++) {
    const t = pick();
    if (!t) break;
    t.fading = -1;                       // out, then back a little way off
    t.next = {
      x: clamp(t.x + (Math.random() - 0.5) * 2 * drift, radarField.x0, radarField.x1),
      y: clamp(t.y + (Math.random() - 0.5) * 2 * drift, radarField.y0, radarField.y1),
    };
  }

  for (let i = 0; i < flux; i++) {
    const leaving = here.length - i > min && (Math.random() < 0.5 || here.length - i >= max);
    if (leaving) {
      const t = pick();
      if (t) { t.fading = -1; t.spent = true; }
    } else if (here.length + i < max) {
      // one arrives: the same kinds, in the same patch of screen
      const like = RADAR_DESIGNED[Math.floor(Math.random() * RADAR_DESIGNED.length)];
      radarTraces.push({
        kind: like.kind, hollow: like.hollow, up: Math.random() < 0.5,
        x: radarField.x0 + Math.random() * (radarField.x1 - radarField.x0),
        y: radarField.y0 + Math.random() * (radarField.y1 - radarField.y0),
        alpha: 0, fading: 1,
      });
    }
  }
  radarTraces = radarTraces.filter((t) => !(t.spent && t.alpha <= 0));
}

/** One trace, at the size the screen it is drawn on gives it. */
function drawTrace(g: CanvasRenderingContext2D, t: RadarTrace, w: number, h: number, k: number): void {
  const x = t.x * w;
  const y = t.y * h;
  g.save();
  g.globalAlpha = t.alpha;
  if (t.kind === 'tri') {
    const tw = cssNumber('--radar-tri-w', 20.8) * k;
    const th = cssNumber('--radar-tri-h', 20.64) * k;
    const line = cssNumber('--radar-tri-stroke', 1.49) * k;
    const tip = t.up ? -th / 2 : th / 2;      // the point, up or down
    const base = -tip;
    g.beginPath();
    g.moveTo(x, y + tip);
    g.lineTo(x - tw / 2, y + base);
    g.lineTo(x + tw / 2, y + base);
    g.closePath();
    if (t.hollow) {
      g.lineWidth = line;
      g.lineJoin = 'miter';
      g.strokeStyle = cssText('--radar-tri-color', '#39DFEB');
      g.stroke();
    } else {
      g.fillStyle = cssText('--radar-tri-color', '#39DFEB');
      g.fill();
    }
  } else {
    const s = cssNumber('--radar-sq', 21.252) * k;
    const line = cssNumber('--radar-sq-stroke', 1.49) * k;
    const r = s * 0.18;                        // the corners the design rounds
    g.beginPath();
    g.roundRect(x - s / 2, y - s / 2, s, s, r);
    if (t.hollow) {
      g.lineWidth = line;
      g.strokeStyle = cssText('--radar-sq-color', '#FFCC00');
      g.stroke();
    } else {
      g.fillStyle = cssText('--radar-sq-color', '#FFCC00');
      g.fill();
    }
  }
  g.restore();
}

/** Called every frame: carries the fades along and paints every radar screen
 *  that is actually on show. */
function drawRadar(now: number): void {
  const plots = Array.from(document.querySelectorAll<HTMLCanvasElement>('.radarPlot'))
    .filter((c) => c.clientWidth > 0 && c.clientHeight > 0);
  if (!plots.length) return;                  // no radar in this arrangement

  const interval = cssNumber('--radar-interval', 20) * 1000;
  if (!radarStirred) radarStirred = now;
  if (now - radarStirred >= interval) { radarStirred = now; stirRadar(); }

  // the fades, a step per frame
  const fade = Math.max(0.05, cssNumber('--radar-fade', 0.6));
  const step = 1 / (fade * 60);
  for (const t of radarTraces) {
    if (t.fading === -1) {
      t.alpha -= step;
      if (t.alpha <= 0) {
        t.alpha = 0;
        if (t.next) { t.x = t.next.x; t.y = t.next.y; t.next = undefined; t.fading = 1; }
        else t.fading = 0;
      }
    } else if (t.fading === 1) {
      t.alpha += step;
      if (t.alpha >= 1) { t.alpha = 1; t.fading = 0; }
    }
  }
  radarTraces = radarTraces.filter((t) => !(t.spent && t.alpha <= 0));

  const basis = cssNumber('--radar-basis', 570);
  const dprNow = Math.min(window.devicePixelRatio || 1, 2);
  for (const plot of plots) {
    const w = plot.clientWidth;
    const h = plot.clientHeight;
    if (plot.width !== Math.round(w * dprNow) || plot.height !== Math.round(h * dprNow)) {
      plot.width = Math.round(w * dprNow);
      plot.height = Math.round(h * dprNow);
    }
    const g = plot.getContext('2d');
    if (!g) continue;
    g.setTransform(dprNow, 0, 0, dprNow, 0, 0);
    g.clearRect(0, 0, w, h);
    // Design px on a screen `basis` wide, scaled to the screen in front of us.
    const k = w / basis;
    for (const t of radarTraces) if (t.alpha > 0) drawTrace(g, t, w, h, k);
  }
}

// -- the EW screen -----------------------------------------------------------
/**
 * ══ THE EW SCREEN ═══════════════════════════════════════════════════════════
 *
 * Two pictures, drawn one over the other:
 *
 *   EW.png        everything that stays where it is — the panel, the two
 *                 range rings with their 5 and 10, and the aircraft.
 *   EW_move.png   everything that turns with north — the bearing marks
 *                 (N W S E and 03 06 12 15 21 24 30 33) and the white ring
 *                 round the aircraft with its own N on it.
 *
 * THE TURNING LAYER IS NOT CUT. It carries two roses, and they were drawn
 * facing different ways — the big one has its N out to the right, the little
 * one has its N up at EW_MARK_AT — so each is carried round by its own
 * amount and both come to rest with N on true north. The two are taken
 * through ring-shaped holes, and those holes fall in the EMPTY space between
 * them: there is nothing on that layer between the little ring and the
 * bearing marks, and nothing outside the marks but the panel's own edge. No
 * line of the artwork is crossed.
 *
 * AND ITS BACKGROUND IS LIFTED OFF. The layer was exported on the panel
 * rather than on nothing, so drawn as it is it would hide the range rings
 * underneath. It is read once into a picture of its own where each pixel is
 * made as see-through as it is dark: the flat panel disappears, the white
 * marks stay exactly as they were drawn, and what is under them shows.
 *
 * Everything below is in the FILE'S OWN PIXELS, measured off the artwork
 * (2284 square), and scaled to whatever size the screen is drawn at.
 */
const EW_FILE = 2284;          // both layers are this square
const EW_CX = 1144;            // the rings' own middle in them
const EW_CY = 1202;
/** The bearing marks: the band they live in, and which way they were drawn. */
const EW_RING_IN = 700;
const EW_RING_OUT = 1050;
const EW_RING_AT = 90;         // their N is drawn out to the RIGHT
/**
 * The little ring round the aircraft. IT HAS A MIDDLE OF ITS OWN: it is not
 * quite concentric with the bearing rings — the artwork puts it six pixels
 * lower — so it is turned about its own middle rather than theirs, and the
 * green marks are hung on it there. Measured off EW_move.png.
 */
const EW_SMALL_CX = 1144.4;
const EW_SMALL_CY = 1208;
const EW_SMALL_R = 165.5;      // where the ring's own line runs
/** The dark disc the aircraft stands on, in the still picture. */
const EW_DISC_R = 164;
const EW_MARK_IN = 100;
const EW_MARK_OUT = 260;
const EW_MARK_AT = 30.2;       // its N, measured round from that middle
/** The brightness a pixel of the turning layer needs before it counts as a
 *  mark rather than as the panel it was drawn on. */
const EW_KEY_LOW = 45;
const EW_KEY_HIGH = 110;

const ewBase = new Image();
ewBase.src = './icons/EW.png';
const ewMove = new Image();
ewMove.src = './icons/EW_move.png';
/** The turning layer with its background lifted off, made once. */
let ewMoveCut: HTMLCanvasElement | null = null;

function ewReady(): boolean {
  if (!ready(ewBase) || !ready(ewMove)) return false;
  if (ewMoveCut) return true;
  const cut = document.createElement('canvas');
  cut.width = ewMove.naturalWidth;
  cut.height = ewMove.naturalHeight;
  const g = cut.getContext('2d', { willReadFrequently: true });
  if (!g) return false;
  g.drawImage(ewMove, 0, 0);
  const pic = g.getImageData(0, 0, cut.width, cut.height);
  const d = pic.data;
  const span = Math.max(1, EW_KEY_HIGH - EW_KEY_LOW);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(d[i]!, d[i + 1]!, d[i + 2]!);
    const t = Math.max(0, Math.min(1, (v - EW_KEY_LOW) / span));
    d[i + 3] = Math.round(d[i + 3]! * t);
  }
  g.putImageData(pic, 0, 0);
  ewMoveCut = cut;
  return true;
}

/** One rose of the turning layer: taken through a ring-shaped hole in the
 *  empty space round it, and carried to where its N belongs. */
function ewRose(
  g: CanvasRenderingContext2D, k: number, r0: number, r1: number, turn: number,
  mx = EW_CX, my = EW_CY,
): void {
  if (!ewMoveCut) return;
  const cx = mx * k;
  const cy = my * k;
  g.save();
  g.beginPath();
  // Each circle is its own subpath: `arc` would otherwise draw a line from
  // wherever the pen is to where the arc begins, and cut a wedge out of the
  // hole. `moveTo` lifts the pen on to the circle first.
  g.moveTo(cx + r1 * k, cy);
  g.arc(cx, cy, r1 * k, 0, Math.PI * 2);
  g.moveTo(cx + r0 * k, cy);
  g.arc(cx, cy, r0 * k, 0, Math.PI * 2, true);
  g.clip('evenodd');
  g.translate(cx, cy);
  g.rotate(turn);
  g.translate(-cx, -cy);
  g.drawImage(ewMoveCut, 0, 0, EW_FILE * k, EW_FILE * k);
  g.restore();
}

/**
 * ══ THE THREATS ON THE EW SCREEN ════════════════════════════════════════════
 *
 * The same threat the map shows, shown here the way an EW screen shows one:
 * not on its spot of ground but at its BEARING AND RANGE from the aircraft.
 * The aircraft is the middle of this screen and its nose is always up, so a
 * threat dead ahead sits at the top and one off the left wing sits to the
 * left, however the aircraft is pointing.
 *
 * It wears whichever of the three faces the threat is wearing at that moment
 * — searching, tracking, launch — and it is the very same reckoning that
 * drives the map, so the two can never fall out of step.
 *
 * The two range rings are the scale: the outer one is --ew-range away and
 * the inner one half of that, which is what the artwork says (5 and 10).
 * Anything further off is held on the outer ring rather than drawn off the
 * screen, so a threat that is still a long way out is seen coming.
 */
const EW_RING_R = 824;         // the outer ring, in the artwork's own pixels
const EW_THREAT: Record<CuePhase, string> = {
  searching: './icons/SA_8%20searching.png',
  tracking: './icons/SA_8%20tracking.png',
  launch: './icons/SA_8_lanch.png',
};
const ewThreatArt = new Map<string, HTMLImageElement>();
function ewThreatImage(phase: CuePhase): HTMLImageElement {
  const src = EW_THREAT[phase];
  let img = ewThreatArt.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    ewThreatArt.set(src, img);
  }
  return img;
}

/** Where a threat lies from the aircraft: how far round from the nose, and
 *  how far off, in nautical miles. */
function ewBearing(cue: { lat: number; lon: number }): { turn: number; nm: number } | null {
  if (!fix) return null;
  const kx = Math.cos((fix.lat * Math.PI) / 180);     // lon degrees are shorter up here
  const dLat = cue.lat - fix.lat;
  const dLon = (cue.lon - fix.lon) * kx;
  const metres = Math.hypot(dLat, dLon) * 111_320;
  // From north, then taken round to the screen: the nose is up, so the whole
  // picture is turned by the heading the map is eased to.
  const fromNorth = Math.atan2(dLon, dLat);
  return { turn: fromNorth - mapHeading, nm: metres / 1852 };
}

/** The threats, laid on one EW screen. */
function drawEwThreats(g: CanvasRenderingContext2D, k: number): void {
  if (!cues.length) return;
  const outer = Math.max(0.1, cssNumber('--ew-range', 10));
  const size = cssNumber('--ew-threat-size', 300) * k;
  const cx = EW_CX * k;
  const cy = EW_CY * k;
  for (const cue of cues) {
    const now = cuePhase(cue);                 // the very same reckoning as the map
    if (!now) continue;
    const art = ewThreatImage(now.phase);
    if (!ready(art)) continue;
    const where = ewBearing(cue);
    if (!where) continue;
    // Held on the outer ring when it is further off than the screen reaches.
    const r = Math.min(1, where.nm / outer) * EW_RING_R * k;
    const x = cx + Math.sin(where.turn) * r;
    const y = cy - Math.cos(where.turn) * r;
    // Upright, always: the screen turns, a threat's own badge does not.
    g.drawImage(art, x - size / 2, y - size / 2, size, size);
  }
}

/**
 * THE GREEN MARKS, ON THE EW SCREEN TOO.
 *
 * The very same artwork the map wears round its own compass ring —
 * green_icon.png and the eight lit files — hung here on the EW screen's
 * little white ring instead. It lights the same way for the same reason: a
 * threat that is up anywhere in its sequence burns the slice of the circle
 * it lies in, measured from the nose, so the two screens always say the same
 * thing about where it is.
 *
 * It is sized to the RING rather than to the aircraft: the circle drawn
 * inside green_icon.png is laid on the ring's own circle, which is what
 * makes the green read as a frame round the ring.
 */
function drawEwGreen(g: CanvasRenderingContext2D, k: number): void {
  if (cssNumber('--ew-green-show', 1) === 0 || !ready(greenIcon)) return;
  const alpha = Math.max(0, Math.min(1, cssNumber('--green-opacity', 100) / 100));
  if (alpha <= 0) return;
  const w = greenIcon.naturalWidth;
  const h = greenIcon.naturalHeight;
  // The circle inside the file: where its middle is and how far out it runs,
  // in the picture's own pixels — the same three numbers the map uses.
  const cxArt = (cssNumber('--green-anchor-x', 49.96) / 100) * w;
  const cyArt = (cssNumber('--green-anchor-y', 49.98) / 100) * h;
  const ownR = (cssNumber('--green-radius', 7.49) / 100) * w;
  if (ownR <= 0 || !h) return;
  // Big enough for that circle to lie on the EW screen's own ring.
  const want = EW_SMALL_R * k * (cssNumber('--ew-green-fit', 100) / 100);
  const kk = want / ownR;

  // Which of the lit files belong on top: one for every threat that is up.
  const lit: HTMLImageElement[] = [];
  if (cssNumber('--green-glow-show', 1) !== 0) {
    for (const cue of cues) {
      if (!cuePhase(cue)) continue;
      const img = greenGlow(greenSector(cue.lat, cue.lon));
      if (ready(img) && !lit.includes(img)) lit.push(img);
    }
  }

  g.save();
  // On the ring's OWN middle, and nudged from there by the two knobs — the
  // artwork can always want a hair one way or the other.
  g.translate(
    (EW_SMALL_CX + cssNumber('--ew-green-shift-x', 0)) * k,
    (EW_SMALL_CY + cssNumber('--ew-green-shift-y', 0)) * k,
  );
  // Upright, as it is on the map: the marks belong to the aircraft's own
  // nose, not to the compass, and the nose is up on both screens.
  g.rotate((cssNumber('--green-turn', 0) * Math.PI) / 180);
  const stamp = (img: HTMLImageElement): void => {
    g.drawImage(img, -cxArt * kk, -cyArt * kk, img.naturalWidth * kk, img.naturalHeight * kk);
  };
  g.globalAlpha = alpha;
  stamp(greenIcon);
  g.globalAlpha = Math.max(0, Math.min(1, cssNumber('--green-glow-opacity', 100) / 100));
  for (const img of lit) stamp(img);
  g.restore();
}

/**
 * THE AIRCRAFT'S OWN DISC, LAID BACK OVER THE GREEN.
 *
 * On the map the symbol is built in pieces and the green is simply laid down
 * before them. Here the aircraft and its disc arrived inside the still
 * picture, which has to go down first because the panel is in it too — so
 * the disc is drawn again, through a round hole over the aircraft, after the
 * green. The order the eye ends up with is the map's: green, disc, ring,
 * aircraft.
 *
 * It costs nothing to draw twice: that part of the picture is solid.
 */
function ewDisc(g: CanvasRenderingContext2D, k: number, w: number): void {
  const r = cssNumber('--ew-disc', EW_DISC_R) * k;
  if (r <= 0 || !ready(ewBase)) return;
  g.save();
  g.beginPath();
  g.arc(EW_SMALL_CX * k, EW_SMALL_CY * k, r, 0, Math.PI * 2);
  g.clip();
  g.drawImage(ewBase, 0, 0, w, w);
  g.restore();
}

/**
 * THE AIRCRAFT ITSELF, LAST OF ALL — as it is on the map.
 *
 * Its nose reaches further out than the ring does, so the ring would cross
 * it. The map draws its jet after its ring for exactly this reason; here the
 * jet arrived inside the still picture, so a picture of JUST THE JET is made
 * once — every solid, light pixel of the still layer within reach of the
 * aircraft, which is the jet and nothing else — and that is laid on last.
 */
let ewJetCut: HTMLCanvasElement | null = null;
function ewJet(): HTMLCanvasElement | null {
  if (ewJetCut) return ewJetCut;
  if (!ready(ewBase)) return null;
  const w = ewBase.naturalWidth;
  const h = ewBase.naturalHeight;
  const cut = document.createElement('canvas');
  cut.width = w;
  cut.height = h;
  const g = cut.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(ewBase, 0, 0);
  const pic = g.getImageData(0, 0, w, h);
  const d = pic.data;
  const reach = cssNumber('--ew-jet', 230);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const near = Math.hypot(x - EW_SMALL_CX, y - EW_SMALL_CY) <= reach;
      const light = Math.max(d[i]!, d[i + 1]!, d[i + 2]!) > 150;
      if (!near || !light) d[i + 3] = 0;
    }
  }
  g.putImageData(pic, 0, 0);
  ewJetCut = cut;
  return cut;
}

/** Every EW screen on show, repainted. */
function drawEw(): void {
  const views = Array.from(document.querySelectorAll<HTMLCanvasElement>('.ewView'))
    .filter((c) => c.clientWidth > 0 && c.clientHeight > 0);
  if (!views.length || !ewReady()) return;
  const dprNow = Math.min(window.devicePixelRatio || 1, 2);
  // True north lies at -mapHeading on a track-up screen, and each rose was
  // drawn with its own N somewhere else already.
  const ring = -mapHeading - (EW_RING_AT * Math.PI) / 180;
  const mark = -mapHeading - (EW_MARK_AT * Math.PI) / 180;
  for (const view of views) {
    const w = view.clientWidth;
    const h = view.clientHeight;
    if (view.width !== Math.round(w * dprNow) || view.height !== Math.round(h * dprNow)) {
      view.width = Math.round(w * dprNow);
      view.height = Math.round(h * dprNow);
    }
    const g = view.getContext('2d');
    if (!g) continue;
    g.setTransform(dprNow, 0, 0, dprNow, 0, 0);
    g.clearRect(0, 0, w, h);
    const k = w / EW_FILE;                 // drawn pixels per file pixel
    g.drawImage(ewBase, 0, 0, w, w);       // everything that stays
    ewRose(g, k, EW_RING_IN, EW_RING_OUT, ring);
    // THE SAME ORDER THE MAP KEEPS for its own symbol: the green goes down
    // first and the aircraft is built over it — its dark disc, then its
    // ring, then the aircraft itself. So the green runs behind the whole
    // symbol and is seen round it and between its ticks, exactly as it is
    // on the map.
    drawEwGreen(g, k);
    ewDisc(g, k, w);
    ewRose(g, k, EW_MARK_IN, EW_MARK_OUT, mark, EW_SMALL_CX, EW_SMALL_CY);
    const jet = ewJet();                   // …and the aircraft last of all
    if (jet) g.drawImage(jet, 0, 0, w, w);
    drawEwThreats(g, k);                   // and the threat, over the lot
  }
}

// -- the camera screen -------------------------------------------------------
/**
 * THE PICTURE FROM UNDER THE AIRCRAFT.
 *
 * The simulator renders a camera bolted to the aircraft's belly, looking 45°
 * below the nose, and sends the finished frames here (see CAM_* in
 * demo/main.ts). This end only shows them: the picture is drawn into the
 * camera pane, drained of colour, and a little grain is laid over it, so it
 * reads as a camera feed rather than as a window onto the game.
 *
 * Until the first frame arrives the pane keeps its still artwork, and the
 * camera's own markings — the corners, the cross, the chip — are a
 * transparent PNG laid over the top, so the picture needs no drawing of its
 * own to look like the design.
 */
let camFrame: ImageBitmap | HTMLImageElement | null = null;
let camFrameDirty = false;

/** Grain, made once and slid about, rather than drawn pixel by pixel. */
let camGrain: HTMLCanvasElement | null = null;
function grainTile(): HTMLCanvasElement {
  if (camGrain) return camGrain;
  const side = 128;
  const tile = document.createElement('canvas');
  tile.width = side; tile.height = side;
  const g = tile.getContext('2d')!;
  const data = g.createImageData(side, side);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = 110 + Math.random() * 90;
    data.data[i] = v; data.data[i + 1] = v; data.data[i + 2] = v; data.data[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  camGrain = tile;
  return tile;
}

/**
 * ── THE MARKINGS, AND THE ZOOM ─────────────────────────────────────────────
 *
 * The camera's markings are an overlay drawn over its picture, and some of
 * them are only meant for the wide view: once the lens is tight, the screen
 * puts on a quieter set — cam_5_layout_zoomin.png in place of
 * cam_5_layout.png. Which it wears follows the lens itself, which the
 * simulator sends with every frame, so it changes whether the zoom came from
 * the throttle or from slaving the camera to a mark.
 *
 * --cam-zoom-fov in map.html is where the line falls, in degrees.
 */
// CAM_OVERLAY_ZOOM and camZoomed are declared at the top of the file: the
// panes are dressed while the page is still setting itself up, which is
// before this point in the file is reached.

function dressCamOverlays(): void {
  for (const o of document.querySelectorAll<HTMLImageElement>('.camOverlay')) {
    const plain = o.dataset.plain ?? (o.dataset.plain = o.getAttribute('src') ?? '');
    const zoomed = CAM_OVERLAY_ZOOM[plain];
    if (!zoomed) continue;                       // no quiet set for this one
    const want = camZoomed ? zoomed : plain;
    if (o.getAttribute('src') !== want) o.setAttribute('src', want);
  }
}

/** Called with every frame: the lens the picture was taken through. */
function noteCamFov(fov: number | undefined): void {
  if (typeof fov !== 'number') return;
  const tight = fov <= cssNumber('--cam-zoom-fov', 4);
  if (tight === camZoomed) return;
  camZoomed = tight;
  dressCamOverlays();
}

/** A frame off the channel, whichever way it travelled. */
function takeCamFrame(image: ImageBitmap | string): void {
  if (typeof image === 'string') {
    const img = new Image();
    img.onload = () => { camFrame = img; camFrameDirty = true; };
    img.src = image;
    return;
  }
  if (camFrame && 'close' in camFrame) (camFrame as ImageBitmap).close();
  camFrame = image;
  camFrameDirty = true;
}

/**
 * WHERE THE GROUND IS, as far as the grain is concerned.
 *
 * A camera's grain is not even: the sky comes out smooth, the ground rough.
 * Rather than guess where the horizon is — it swings with every turn — the
 * picture is asked: bright is sky, dark is ground. The answer is worked out
 * small, 64 across, and stretched back over the frame, which is what makes
 * the change from one grain to the other a slide rather than a seam.
 */
let camMask: HTMLCanvasElement | null = null;
function groundMask(frame: CanvasImageSource): HTMLCanvasElement {
  const side = 64;
  camMask ??= document.createElement('canvas');
  camMask.width = side; camMask.height = side;
  const g = camMask.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, side, side);
  g.drawImage(frame, 0, 0, side, side);
  const data = g.getImageData(0, 0, side, side);
  const d = data.data;
  const split = cssNumber('--cam-noise-split', 45) / 100;
  const soften = Math.max(0.01, cssNumber('--cam-noise-soften', 45) / 100);
  for (let i = 0; i < d.length; i += 4) {
    const dark = 1 - (d[i] + d[i + 1] + d[i + 2]) / 765;   // 1 = pitch dark
    // a slide from one to the other, rather than a step
    const t = Math.max(0, Math.min(1, (dark - (1 - split) + soften / 2) / soften));
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
    d[i + 3] = Math.round(t * 255);
  }
  g.putImageData(data, 0, 0);
  return camMask;
}

/** One coat of grain, kept to the part of the picture the mask allows. */
let camScratch: HTMLCanvasElement | null = null;
function grainCoat(
  g: CanvasRenderingContext2D, w: number, h: number, dprNow: number,
  coarse: number, strength: number, mask: HTMLCanvasElement, overGround: boolean,
): void {
  // HOW THE GRAIN IS LAID ON. Over the bright sky it is woven into the
  // picture, which keeps the sky's own brightness; over dark ground that same
  // weave is swallowed — a dark pixel has nothing to weave with — so there it
  // is laid on top instead, the way a sensor's noise floor shows in shadow.
  const blend: GlobalCompositeOperation = overGround ? 'screen' : 'overlay';
  if (strength <= 0) return;
  camScratch ??= document.createElement('canvas');
  const pxW = Math.round(w * dprNow);
  const pxH = Math.round(h * dprNow);
  if (camScratch.width !== pxW || camScratch.height !== pxH) {
    camScratch.width = pxW; camScratch.height = pxH;
  }
  const sg = camScratch.getContext('2d')!;
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.clearRect(0, 0, pxW, pxH);
  const tile = grainTile();
  const pattern = sg.createPattern(tile, 'repeat');
  if (!pattern) return;
  sg.save();
  // moved somewhere new each frame, so the speckle crawls rather than sits
  sg.translate(-Math.random() * tile.width * coarse, -Math.random() * tile.height * coarse);
  sg.scale(coarse, coarse);
  sg.fillStyle = pattern;
  sg.fillRect(0, 0, pxW / coarse + tile.width, pxH / coarse + tile.height);
  sg.restore();
  // keep it to the sky, or to the ground
  sg.globalCompositeOperation = overGround ? 'destination-in' : 'destination-out';
  sg.drawImage(mask, 0, 0, pxW, pxH);
  sg.globalCompositeOperation = 'source-over';

  g.save();
  g.globalAlpha = Math.max(0, Math.min(1, strength));
  g.globalCompositeOperation = blend;
  g.drawImage(camScratch, 0, 0, w, h);
  g.restore();
}

/**
 * THE MARK THAT STAYS RED.
 *
 * The camera's picture is a black-and-white one, and that is how it should
 * read — except for the mark standing over the truck, which the design keeps
 * in its own red. Rather than drawing the mark a second time from the map's
 * side, which would mean working out where on the picture it fell, the red is
 * simply kept: the frame is read once, everything that is not strongly red is
 * made clear, and what is left is laid back over the grey picture.
 *
 * "Strongly red" is red at --cam-red-ratio times both of the others and at
 * least --cam-red-min bright, which the ground, being as drab as it is, never
 * reaches. --cam-keep-red 0 turns the whole thing off.
 */
let redCut: HTMLCanvasElement | null = null;
function redLayer(frame: CanvasImageSource): HTMLCanvasElement | null {
  if (cssNumber('--cam-keep-red', 1) === 0) return null;
  const w = (frame as ImageBitmap).width;
  const h = (frame as ImageBitmap).height;
  if (!w || !h) return null;
  if (!redCut) redCut = document.createElement('canvas');
  if (redCut.width !== w || redCut.height !== h) { redCut.width = w; redCut.height = h; }
  const g = redCut.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  g.drawImage(frame, 0, 0);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const ratio = cssNumber('--cam-red-ratio', 1.8);
  const least = cssNumber('--cam-red-min', 80);
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    if (r >= least && r >= d[i + 1] * ratio && r >= d[i + 2] * ratio) { any = true; continue; }
    d[i + 3] = 0;
  }
  if (!any) return null;
  g.putImageData(img, 0, 0);
  return redCut;
}

function drawCam(): void {
  if (!camFrameDirty || !camFrame) return;
  camFrameDirty = false;
  const panes = Array.from(document.querySelectorAll<HTMLCanvasElement>('.camView'))
    .filter((c) => c.clientWidth > 0 && c.clientHeight > 0);
  if (!panes.length) return;

  const grey = cssNumber('--cam-grey', 100);
  const contrast = cssNumber('--cam-contrast', 118);
  const bright = cssNumber('--cam-brightness', 104);
  const master = cssNumber('--cam-noise', 100) / 100;
  const sky = (cssNumber('--cam-noise-sky', 7) / 100) * master;
  const ground = (cssNumber('--cam-noise-ground', 20) / 100) * master;
  const coarseSky = Math.max(1, cssNumber('--cam-noise-scale-sky', 1));
  const coarseGround = Math.max(1, cssNumber('--cam-noise-scale-ground', 3));
  const dprNow = Math.min(window.devicePixelRatio || 1, 2);
  const mask = (sky > 0 || ground > 0) ? groundMask(camFrame) : null;
  const redOnly = redLayer(camFrame);

  for (const pane of panes) {
    const w = pane.clientWidth;
    const h = pane.clientHeight;
    if (pane.width !== Math.round(w * dprNow) || pane.height !== Math.round(h * dprNow)) {
      pane.width = Math.round(w * dprNow);
      pane.height = Math.round(h * dprNow);
    }
    const g = pane.getContext('2d');
    if (!g) continue;
    g.setTransform(dprNow, 0, 0, dprNow, 0, 0);
    g.filter = `grayscale(${grey}%) contrast(${contrast}%) brightness(${bright}%)`;
    g.drawImage(camFrame, 0, 0, w, h);
    g.filter = 'none';
    // The one thing that keeps its colour: the mark over the truck. It is
    // drawn again from the picture as it came, with everything that is not
    // that red taken out of it.
    if (redOnly) g.drawImage(redOnly, 0, 0, w, h);
    if (mask) {
      grainCoat(g, w, h, dprNow, coarseSky, sky, mask, false);
      grainCoat(g, w, h, dprNow, coarseGround, ground, mask, true);
    }
  }
}

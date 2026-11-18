// Twenty Boats — sound. Short, quiet, and only when something happens: no
// beds, no loops, nothing under the reading. (An earlier pass ran a hum and
// noise beds all night and read as a white-noise machine.) Each world cue
// belongs to a cited beat in data/beats.json (its `sound` key) or to a boat
// you see lowered, and a scene plays at most one of them. Every cue is under
// three seconds, most under one.
//
// Web Audio, no files. The context is only created from a click or key
// press, so autoplay rules never block it.

// Beat sounds data/beats.json may name.
export const CUES = ['grind', 'rocket', 'band', 'funnel', 'parting'];

// When two things happen at once, the louder fact wins.
const PRIORITY = ['parting', 'funnel', 'lowered', 'rocket', 'band'];
// Rockets went up every few minutes: one heard per this many.
export const ROCKET_GAP = 5;

// Pure: the one world cue a new scene should play, or null. `prev` and
// `next` are sceneOf results ({ minute, place, sounds, lowered }); `lastRocket`
// is the minute a rocket was last heard.
export function cueFor(prev, next, lastRocket = -Infinity) {
  const had = new Set(prev?.sounds ?? []);
  const options = new Set();
  for (const s of next.sounds) {
    if (s === 'rocket') {
      if (next.minute - lastRocket >= ROCKET_GAP) options.add(s);
    } else if (s === 'band') {
      if (!had.has(s) || prev.place !== next.place) options.add(s);
    } else if (!had.has(s)) options.add(s);
  }
  const before = new Set(prev?.lowered ?? []);
  if (next.lowered.some((id) => !before.has(id))) options.add('lowered');
  return PRIORITY.find((c) => options.has(c)) ?? null;
}

// An original two-bar phrase in 3/4, G major: [bass, melody as [note, beats]].
// MIDI note numbers. Never film music.
const WALTZ = [
  [43, [[71, 2], [69, 1]]],
  [38, [[66, 3]]],
];
const BEAT = 0.42;
const MASTER = 0.8;
const ASLEEP_CUTOFF = 380;

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function createSound({ muted = false } = {}) {
  let ctx = null;
  let master = null;
  let noise = null;

  function live() {
    if (!ctx) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER;
      master.connect(ctx.destination);
      noise = noiseBuffer(ctx);
    }
    ctx.resume?.();
    return ctx;
  }

  function env(t, peak, attack, decay, dest) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest);
    return g;
  }

  function tone(t, { type = 'triangle', from, to = from, peak = 0.03, attack = 0.004, decay = 0.08, cutoff = 2400, dest = master }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    o.connect(f).connect(env(t, peak, attack, decay, dest));
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  function hiss(t, { type = 'bandpass', freq = 1200, to = freq, q = 1, peak = 0.03, attack = 0.005, decay = 0.1, dest = master }) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (to !== freq) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    f.Q.value = q;
    s.connect(f).connect(env(t, peak, attack, decay, dest));
    s.start(t, Math.random() * 1.5);
    s.stop(t + attack + decay + 0.05);
  }

  // A filter in front of master: asleep, the world comes through the wall.
  function through(asleep) {
    if (!asleep) return master;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = ASLEEP_CUTOFF;
    f.connect(master);
    setTimeout(() => f.disconnect(), 3000);
    return f;
  }

  const WORLD = {
    // The iceberg along the side: a short low scrape.
    grind(t, dest) {
      hiss(t, { type: 'lowpass', freq: 240, to: 150, peak: 0.14, attack: 0.12, decay: 1.1, dest });
      tone(t, { type: 'sawtooth', from: 46, to: 38, peak: 0.05, attack: 0.15, decay: 1, cutoff: 160, dest });
    },
    // A rocket bursting high and far off: a pop, a soft thud.
    rocket(t, dest) {
      hiss(t, { type: 'highpass', freq: 2400, peak: 0.02, attack: 0.002, decay: 0.08, dest });
      hiss(t + 0.06, { type: 'lowpass', freq: 420, peak: 0.03, attack: 0.01, decay: 0.45, dest });
    },
    // Two bars of a waltz from the top of the stairs, faint.
    band(t, dest) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.linearRampToValueAtTime(0.0001, t + WALTZ.length * 3 * BEAT);
      f.connect(g).connect(dest);
      WALTZ.forEach(([bass, melody], bar) => {
        const at0 = t + bar * 3 * BEAT;
        tone(at0, { from: hz(bass), peak: 0.05, attack: 0.01, decay: BEAT * 0.9, cutoff: 800, dest: f });
        let at = at0;
        for (const [n, beats] of melody) {
          tone(at, { from: hz(n), peak: 0.035, attack: 0.03, decay: beats * BEAT * 0.9, cutoff: 800, dest: f });
          at += beats * BEAT;
        }
      });
    },
    // The falls running out through the blocks, then the boat meets the sea.
    lowered(t, dest) {
      for (let i = 0; i < 3; i++) tone(t + i * 0.16, { type: 'sawtooth', from: 200 - i * 12, to: 150, peak: 0.012, attack: 0.02, decay: 0.12, cutoff: 700, dest });
      hiss(t + 0.55, { type: 'lowpass', freq: 1000, to: 400, peak: 0.04, attack: 0.02, decay: 0.4, dest });
    },
    // A funnel into the sea: one low crash.
    funnel(t, dest) {
      hiss(t, { type: 'lowpass', freq: 600, to: 180, peak: 0.12, attack: 0.01, decay: 0.9, dest });
      tone(t, { type: 'sawtooth', from: 70, to: 40, peak: 0.05, attack: 0.005, decay: 0.8, cutoff: 200, dest });
    },
    // Iron parting deep in the ship: a short groan.
    parting(t, dest) {
      tone(t, { type: 'square', from: 80, to: 32, peak: 0.1, attack: 0.08, decay: 1.3, cutoff: 220, dest });
      hiss(t, { type: 'lowpass', freq: 200, to: 90, peak: 0.08, attack: 0.15, decay: 1.2, dest });
    },
  };

  function world(name, { asleep = false } = {}) {
    const c = live();
    if (c && WORLD[name]) WORLD[name](c.currentTime + 0.05, through(asleep));
  }

  const play = (fn) => (...args) => {
    const c = live();
    if (c) fn(c.currentTime, ...args);
  };

  // A choice made: one soft click.
  const click = play((t) => {
    hiss(t, { type: 'highpass', freq: 3000, peak: 0.02, attack: 0.001, decay: 0.02 });
  });

  // The Draw card laid down.
  const deal = play((t) => {
    hiss(t, { freq: 2600, q: 0.7, peak: 0.025, attack: 0.02, decay: 0.12 });
    hiss(t + 0.12, { type: 'lowpass', freq: 900, peak: 0.02, attack: 0.003, decay: 0.05 });
  });

  // Turned away, or too late: one low note.
  const refused = play((t) => {
    tone(t, { from: 130, to: 98, peak: 0.05, attack: 0.01, decay: 0.3, cutoff: 500 });
  });

  // How the night closes.
  const ending = play((t, id) => {
    if (id.startsWith('boat-')) {
      // One oar.
      hiss(t + 0.2, { freq: 900, q: 0.8, peak: 0.04, attack: 0.04, decay: 0.45 });
    } else if (id === 'went-down') {
      hiss(t, { type: 'lowpass', freq: 300, to: 120, peak: 0.12, attack: 0.2, decay: 1 });
    } else {
      // The cold: a rush of water, cut short.
      hiss(t, { type: 'lowpass', freq: 1600, to: 700, peak: 0.08, attack: 0.03, decay: 0.7 });
    }
  });

  function setMuted(on) {
    muted = on;
    if (!ctx) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(on ? 0 : MASTER, ctx.currentTime, 0.03);
  }

  function close() {
    const c = ctx;
    ctx = null;
    master = null;
    if (c) setTimeout(() => c.close?.(), 200);
  }

  return {
    world, click, deal, refused, ending, setMuted, close,
    get muted() { return muted; },
  };
}

function noiseBuffer(c) {
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

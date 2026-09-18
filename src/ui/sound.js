/**
 * sound.js — synthesised cues via WebAudio.
 *
 * Sound carries more of the immersion here than the visuals do, because the
 * visuals are deliberately sparse. Everything is synthesised rather than
 * sampled: no asset pipeline, no download, and a per-speaker chime pitch
 * comes free.
 *
 * The choice-timer tick is the highest-value cue in the list. It converts the
 * timer bar from a UI element into felt pressure.
 *
 * No voice acting: it would make new mission content expensive to author,
 * which contradicts the whole data-driven premise.
 */

export function createSound() {
  let actx = null;
  let master = null;
  let hum = null;
  let enabled = true;
  let started = false;

  function ensure() {
    if (actx) return actx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { enabled = false; return null; }
    actx = new Ctx();
    master = actx.createGain();
    master.gain.value = 0.35;
    master.connect(actx.destination);
    return actx;
  }

  function tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.3, sweep = null, delay = 0 }) {
    if (!enabled) return;
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.3, gain = 0.25, filter = 900, delay = 0 }) {
    if (!enabled) return;
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = filter;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(lp); lp.connect(g); g.connect(master);
    src.start(t0);
  }

  const CUES = {
    // A new detection: one soft ping.
    contactAcquired: () => tone({ freq: 880, dur: 0.09, type: 'sine', gain: 0.16 }),
    // Confidence crossed 75: two-tone confirm.
    trackResolved: () => { tone({ freq: 660, dur: 0.08, gain: 0.18 }); tone({ freq: 990, dur: 0.11, gain: 0.18, delay: 0.09 }); },
    // Classification hostile: harsh triple tone. Amber, in sound.
    hostileDeclared: () => [0, 0.11, 0.22].forEach((d) =>
      tone({ freq: 320, dur: 0.09, type: 'square', gain: 0.2, delay: d })),
    // Launch: muffled thump plus a rising whoosh.
    missileAway: () => { noise({ dur: 0.5, gain: 0.3, filter: 420 }); tone({ freq: 140, dur: 0.6, sweep: 720, type: 'sawtooth', gain: 0.14 }); },
    // Hostile weapon detected: repeating, urgent, unignorable.
    inbound: () => [0, 0.3, 0.6].forEach((d) =>
      tone({ freq: 1180, dur: 0.16, type: 'square', gain: 0.26, delay: d })),
    damage: () => { noise({ dur: 0.8, gain: 0.45, filter: 260 }); tone({ freq: 90, dur: 0.7, type: 'sawtooth', gain: 0.22 }); },
    weaponAborted: () => tone({ freq: 520, dur: 0.22, sweep: 180, type: 'triangle', gain: 0.18 }),
    missionEnded: () => [523, 392, 330].forEach((f, i) =>
      tone({ freq: f, dur: 0.4, gain: 0.16, delay: i * 0.22 })),
    // Per-speaker chime pitch is the whole of the characterisation budget.
    dialogue: (speakerIndex = 0) =>
      tone({ freq: 500 + speakerIndex * 90, dur: 0.045, type: 'triangle', gain: 0.1 }),
    // The highest-value cue: accelerating tick in the last five seconds.
    timerTick: (urgent) => tone({ freq: urgent ? 1400 : 900, dur: 0.03, type: 'square', gain: urgent ? 0.16 : 0.07 }),
  };

  return {
    play(cue, arg) { CUES[cue]?.(arg); },
    /** A low bed, barely audible. Must be started from a user gesture. */
    startHum() {
      if (!enabled || started) return;
      const ctx = ensure();
      if (!ctx) return;
      started = true;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      osc.type = 'sawtooth';
      osc.frequency.value = 58;
      lp.type = 'lowpass'; lp.frequency.value = 140;
      g.gain.value = 0.022;
      osc.connect(lp); lp.connect(g); g.connect(master);
      osc.start();
      hum = { osc, g };
    },
    stopHum() { if (hum) { try { hum.osc.stop(); } catch {} hum = null; started = false; } },
    setEnabled(on) {
      enabled = on;
      if (master) master.gain.value = on ? 0.35 : 0;
      if (!on) this.stopHum();
    },
    get enabled() { return enabled; },
    resume() { if (actx?.state === 'suspended') actx.resume(); },
  };
}

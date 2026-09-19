// ─────────────────────────────────────────────────────────────
// Procedural Overcooked-style audio. Zero assets — everything is
// synthesized with the Web Audio API: a jaunty swing loop (tempo
// bumps during rush hour), stove sizzle, knife chops, serve bells,
// fire alarm + crackle, sad-trombone fails, shift-end whistle.
// Create on a user gesture (autoplay policy); feed it SimState
// snapshots + events via observe().
// ─────────────────────────────────────────────────────────────
import type { SimState, SimEvent } from './types';

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// C-major pentatonic pluck line, 4 bars of swung 8ths (0 = rest).
const MELODY = [
  84, 0, 79, 81, 0, 76, 79, 0,
  72, 0, 76, 0, 74, 76, 0, 0,
  81, 0, 79, 76, 0, 79, 81, 84,
  0, 81, 79, 74, 76, 0, 72, 0,
];
// Chord roots per bar: C - G - Am - F
const BASS_ROOTS = [36, 43, 45, 41];

export class KitchenAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private musicBus: GainNode;
  private sfxBus: GainNode;
  private muted = false;
  private running = false;

  // music scheduler
  private tempo = 104;
  private slot = 0; // current 8th-note slot (0..31)
  private nextNoteAt = 0;
  private schedTimer: ReturnType<typeof setInterval> | null = null;

  // continuous beds
  private sizzleGain: GainNode | null = null;
  private crackleGain: GainNode | null = null;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;

  // state tracking
  private seenEvents = 0;
  private chopTimer: ReturnType<typeof setInterval> | null = null;
  private shiftOverPlayed = false;

  constructor() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.13;
    const warm = this.ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 3200;
    this.musicBus.connect(warm);
    warm.connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.42;
    this.sfxBus.connect(this.master);
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.ctx.resume();
    this.startBeds();
    this.nextNoteAt = this.ctx.currentTime + 0.1;
    this.slot = 0;
    this.schedTimer = setInterval(() => this.scheduleMusic(), 90);
    this.chopTimer = setInterval(() => this.chopTick(), 200);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  dispose() {
    if (this.schedTimer) clearInterval(this.schedTimer);
    if (this.chopTimer) clearInterval(this.chopTimer);
    if (this.alarmTimer) clearInterval(this.alarmTimer);
    void this.ctx.close();
  }

  // ── per-snapshot observation (call ~10Hz with the HUD snapshot) ──
  private lastState: SimState | null = null;
  observe(state: SimState) {
    this.lastState = state;
    if (!this.running) return;

    // new events → one-shot sfx (dedupe by t|text; events are capped ~30)
    for (const e of state.events) {
      const key = `${e.t}|${e.text}`;
      if (this.seenTexts.has(key)) continue;
      this.seenTexts.add(key);
      // skip anything that predates audio start (e.g. joined mid-shift)
      if (e.t < this.seenEventT) continue;
      this.handleEvent(e);
    }
    if (this.seenTexts.size > 120) {
      // prune old keys
      const keep = new Set<string>();
      for (const k of Array.from(this.seenTexts).slice(-60)) keep.add(k);
      this.seenTexts = keep;
    }

    // sizzle bed follows how many stoves are actively cooking
    const cooking = state.stations.filter(
      (s) => s.kind === 2 && s.item && s.item.stage !== 'burnt' && !s.onFire,
    ).length;
    if (this.sizzleGain) {
      this.sizzleGain.gain.setTargetAtTime(Math.min(0.055, cooking * 0.02), this.ctx.currentTime, 0.4);
    }

    // fire: crackle bed + alarm
    const fires = state.stations.filter((s) => s.onFire).length;
    if (this.crackleGain) {
      this.crackleGain.gain.setTargetAtTime(Math.min(0.09, fires * 0.05), this.ctx.currentTime, 0.25);
    }
    if (fires > 0 && !this.alarmTimer) {
      this.alarmTimer = setInterval(() => this.alarmBeep(), 900);
    } else if (fires === 0 && this.alarmTimer) {
      clearInterval(this.alarmTimer);
      this.alarmTimer = null;
    }

    // rush hour: faster tune
    this.tempo = state.t < state.rushUntil ? 122 : 104;

    // shift over: stop music, one-time whistle + tada
    if (!state.running && state.t >= state.shiftEndsAt && !this.shiftOverPlayed) {
      this.shiftOverPlayed = true;
      if (this.schedTimer) clearInterval(this.schedTimer);
      this.schedTimer = null;
      if (this.alarmTimer) clearInterval(this.alarmTimer);
      this.alarmTimer = null;
      if (this.sizzleGain) this.sizzleGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      if (this.crackleGain) this.crackleGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      this.whistle();
      setTimeout(() => this.tada(), 900);
    }
  }
  private seenEventT = 0;
  private seenTexts = new Set<string>();

  private handleEvent(e: SimEvent) {
    switch (e.kind) {
      case 'serve':
        this.serveBell();
        break;
      case 'fail':
        this.sadTrombone();
        break;
      case 'fire':
        this.fireWhoosh();
        break;
      case 'burn':
        this.burnBuzz();
        break;
      case 'rush':
        this.rushRing();
        break;
      case 'info':
        if (/put out/i.test(e.text)) this.extinguishPsh();
        else if (/ready/i.test(e.text)) this.readyPop();
        break;
    }
  }

  // ── continuous beds ─────────────────────────────────────────
  private startBeds() {
    const noiseBuf = this.makeNoise(2);
    // sizzle: bandpassed white noise
    const sizzleSrc = this.ctx.createBufferSource();
    sizzleSrc.buffer = noiseBuf;
    sizzleSrc.loop = true;
    const sizzleBp = this.ctx.createBiquadFilter();
    sizzleBp.type = 'bandpass';
    sizzleBp.frequency.value = 4800;
    sizzleBp.Q.value = 0.7;
    this.sizzleGain = this.ctx.createGain();
    this.sizzleGain.gain.value = 0;
    sizzleSrc.connect(sizzleBp).connect(this.sizzleGain).connect(this.sfxBus);
    sizzleSrc.start();

    // fire crackle: lower rumble noise with wobble
    const crackleSrc = this.ctx.createBufferSource();
    crackleSrc.buffer = noiseBuf;
    crackleSrc.loop = true;
    crackleSrc.playbackRate.value = 0.35;
    const crackleBp = this.ctx.createBiquadFilter();
    crackleBp.type = 'bandpass';
    crackleBp.frequency.value = 900;
    crackleBp.Q.value = 0.6;
    this.crackleGain = this.ctx.createGain();
    this.crackleGain.gain.value = 0;
    const wobble = this.ctx.createOscillator();
    wobble.frequency.value = 7;
    const wobbleAmt = this.ctx.createGain();
    wobbleAmt.gain.value = 0.35;
    wobble.connect(wobbleAmt).connect(crackleSrc.playbackRate);
    wobble.start();
    crackleSrc.connect(crackleBp).connect(this.crackleGain).connect(this.sfxBus);
    crackleSrc.start();
  }

  // ── music loop (lookahead scheduler) ────────────────────────
  private scheduleMusic() {
    if (!this.schedTimer) return;
    const eighth = 60 / this.tempo / 2;
    while (this.nextNoteAt < this.ctx.currentTime + 0.25) {
      const t = this.nextNoteAt;
      const s = this.slot;
      const bar = Math.floor(s / 8) % 4;
      const beatInBar = s % 8;

      // swing: long-short eighth pairs
      const dur = beatInBar % 2 === 0 ? eighth * 1.16 : eighth * 0.84;

      // bass: root on 1&5, fifth on 3&7
      if (beatInBar % 2 === 0) {
        const root = BASS_ROOTS[bar];
        const note = beatInBar % 4 === 0 ? root : root + 7;
        this.pluck(midi(note), t, 0.32, 'triangle', 0.5, this.musicBus);
      }
      // hats on the offbeats
      if (beatInBar % 2 === 1) this.hat(t, 0.05);
      // soft kick on 1 and 5
      if (beatInBar === 0 || beatInBar === 4) this.kick(t);
      // melody
      const m = MELODY[s % 32];
      if (m) this.pluck(midi(m), t, 0.22, 'square', 0.28, this.musicBus);

      this.nextNoteAt += dur;
      this.slot = (this.slot + 1) % 32;
    }
  }

  // ── chop repeater: tok-tok while any chef is chopping ───────
  private chopTick() {
    if (!this.lastState || this.muted) return;
    const chopping = this.lastState.chefs.filter((c) => c.action === 'chopping');
    for (const c of chopping) {
      this.tok(180 + c.id * 22);
    }
  }

  // ── one-shot instruments ────────────────────────────────────
  private env(peak: number, t: number, a: number, d: number, bus: AudioNode) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(bus);
    return g;
  }

  private pluck(freq: number, t: number, decay: number, type: OscillatorType, vol: number, bus: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.env(vol, t, 0.004, decay, bus);
    o.connect(g);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private hat(t: number, vol: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoise(0.06);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = this.env(vol, t, 0.002, 0.05, this.musicBus);
    src.connect(hp).connect(g);
    src.start(t);
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const g = this.env(0.5, t, 0.002, 0.1, this.musicBus);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.15);
  }

  private tok(freq: number) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 2.2, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.03);
    const g = this.env(0.35, t, 0.002, 0.06, this.sfxBus);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.09);
  }

  private serveBell() {
    const t = this.ctx.currentTime;
    // ding! bell partials
    for (const [ratio, vol, dec] of [[1, 0.5, 0.7], [2.76, 0.2, 0.4], [5.4, 0.08, 0.25]] as const) {
      const o = this.ctx.createOscillator();
      o.frequency.value = 1244 * ratio;
      const g = this.env(vol, t, 0.003, dec, this.sfxBus);
      o.connect(g);
      o.start(t);
      o.stop(t + dec + 0.1);
    }
    // happy little arpeggio
    [76, 79, 84].forEach((n, i) => this.pluck(midi(n), t + 0.09 + i * 0.07, 0.18, 'triangle', 0.3, this.sfxBus));
  }

  private sadTrombone() {
    const t = this.ctx.currentTime;
    [62, 60].forEach((n, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      const start = t + i * 0.28;
      o.frequency.setValueAtTime(midi(n), start);
      o.frequency.linearRampToValueAtTime(midi(n) * 0.94, start + 0.26);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const g = this.env(0.28, start, 0.02, 0.3, this.sfxBus);
      o.connect(lp).connect(g);
      o.start(start);
      o.stop(start + 0.4);
    });
  }

  private fireWhoosh() {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoise(0.6);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
    const g = this.env(0.5, t, 0.02, 0.5, this.sfxBus);
    src.connect(bp).connect(g);
    src.start(t);
  }

  private extinguishPsh() {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoise(0.5);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(5000, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.4);
    const g = this.env(0.4, t, 0.01, 0.45, this.sfxBus);
    src.connect(bp).connect(g);
    src.start(t);
  }

  private burnBuzz() {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(150, t);
    o.frequency.linearRampToValueAtTime(110, t + 0.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = this.env(0.22, t, 0.01, 0.32, this.sfxBus);
    o.connect(lp).connect(g);
    o.start(t);
    o.stop(t + 0.4);
  }

  private alarmBeep() {
    if (this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1180;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const g = this.env(0.07, t, 0.005, 0.16, this.sfxBus);
    o.connect(lp).connect(g);
    o.start(t);
    o.stop(t + 0.2);
  }

  private rushRing() {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      const o = this.ctx.createOscillator();
      o.frequency.value = i % 2 ? 1975 : 1568;
      const g = this.env(0.12, t + i * 0.09, 0.004, 0.09, this.sfxBus);
      o.connect(g);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.13);
    }
  }

  private readyPop() {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(780, t + 0.07);
    const g = this.env(0.16, t, 0.004, 0.1, this.sfxBus);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.15);
  }

  private whistle() {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.linearRampToValueAtTime(1500, t + 0.18);
    o.frequency.setValueAtTime(1500, t + 0.3);
    o.frequency.linearRampToValueAtTime(900, t + 0.75);
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 22;
    const vibAmt = this.ctx.createGain();
    vibAmt.gain.value = 28;
    vib.connect(vibAmt).connect(o.frequency);
    const g = this.env(0.3, t, 0.02, 0.85, this.sfxBus);
    o.connect(g);
    o.start(t);
    vib.start(t);
    o.stop(t + 1);
    vib.stop(t + 1);
  }

  private tada() {
    const t = this.ctx.currentTime;
    [60, 64, 67, 72].forEach((n, i) =>
      this.pluck(midi(n), t + i * 0.09, 0.5, 'triangle', 0.35, this.sfxBus),
    );
    [64, 67, 72, 76].forEach((n, i) =>
      this.pluck(midi(n), t + 0.4 + i * 0.001, 0.9, 'triangle', 0.22, this.sfxBus),
    );
  }

  private noiseCache: AudioBuffer | null = null;
  private makeNoise(seconds: number): AudioBuffer {
    if (this.noiseCache && this.noiseCache.duration >= seconds) return this.noiseCache;
    const len = Math.ceil(this.ctx.sampleRate * Math.max(seconds, 2));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseCache = buf;
    return buf;
  }
}

import { api } from "./api";

/** Notification sounds. The built-in ones are synthesized (tiny, crisp, never
 *  missing a file); custom ones are files the user added. */

export interface SoundDef {
  id: string;
  name: string;
}

export const BUILTIN: SoundDef[] = [
  { id: "chime", name: "Chime" },
  { id: "glass", name: "Glass" },
  { id: "marimba", name: "Marimba" },
  { id: "pluck", name: "Pluck" },
  { id: "bell", name: "Bell" },
  { id: "bubble", name: "Bubble" },
  { id: "droplet", name: "Droplet" },
  { id: "rise", name: "Rise" },
];

export const DEFAULT_SOUND = "chime";

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function output(volume: number): GainNode {
  const a = audio();
  const comp = a.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.connect(a.destination);
  const g = a.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume));
  g.connect(comp);
  return g;
}

function tone(
  dest: AudioNode,
  freq: number,
  t: number,
  { type = "sine", attack = 0.004, decay = 0.8, peak = 0.4, to }: { type?: OscillatorType; attack?: number; decay?: number; peak?: number; to?: number } = {},
) {
  const a = audio();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay * 0.6);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

const SYNTH: Record<string, (out: AudioNode, t: number) => void> = {
  chime: (out, t) => {
    tone(out, 1046.5, t, { decay: 1.3, peak: 0.42 });
    tone(out, 1568, t + 0.09, { decay: 1.1, peak: 0.3 });
  },
  glass: (out, t) => {
    tone(out, 1760, t, { decay: 0.9, peak: 0.3 });
    tone(out, 2637, t, { decay: 0.55, peak: 0.14 });
    tone(out, 3520, t + 0.002, { decay: 0.3, peak: 0.06 });
  },
  marimba: (out, t) => {
    tone(out, 784, t, { decay: 0.45, peak: 0.45 });
    tone(out, 3136, t, { decay: 0.06, peak: 0.16 });
    tone(out, 1046.5, t + 0.13, { decay: 0.55, peak: 0.42 });
    tone(out, 4186, t + 0.13, { decay: 0.06, peak: 0.12 });
  },
  pluck: (out, t) => {
    const a = audio();
    const f = a.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(5000, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.3);
    f.connect(out);
    tone(f, 659.3, t, { type: "triangle", decay: 0.42, peak: 0.55 });
    tone(f, 987.8, t + 0.07, { type: "triangle", decay: 0.38, peak: 0.36 });
  },
  bell: (out, t) => {
    const base = 523.25;
    [
      [1, 0.36, 1.6],
      [2.76, 0.16, 1.0],
      [5.4, 0.08, 0.6],
      [8.93, 0.04, 0.3],
    ].forEach(([m, p, d]) => tone(out, base * m, t, { decay: d, peak: p }));
  },
  bubble: (out, t) => {
    tone(out, 300, t, { decay: 0.18, peak: 0.42, to: 920 });
    tone(out, 420, t + 0.11, { decay: 0.16, peak: 0.3, to: 1250 });
  },
  droplet: (out, t) => {
    tone(out, 1500, t, { decay: 0.26, peak: 0.42, to: 480 });
  },
  rise: (out, t) => {
    tone(out, 784, t, { attack: 0.012, decay: 0.32, peak: 0.34 });
    tone(out, 1174.7, t + 0.12, { attack: 0.012, decay: 0.7, peak: 0.36 });
  },
};

function customBuffer(id: string): Promise<AudioBuffer | null> {
  let p = buffers.get(id);
  if (!p) {
    p = api
      .soundRead(id)
      .then((bytes) => audio().decodeAudioData(bytes.slice(0)))
      .catch(() => null);
    buffers.set(id, p);
  }
  return p;
}

export function forgetCustom(id: string) {
  buffers.delete(id);
}

/** Plays `sound` ("chime", "custom:<id>", or "none") at `volume` (0-1). */
export async function playSound(sound: string, volume: number) {
  if (!sound || sound === "none" || volume <= 0) return;
  const out = output(volume);
  const t = audio().currentTime + 0.01;
  if (sound.startsWith("custom:")) {
    const buf = await customBuffer(sound.slice(7));
    if (!buf) return;
    const src = audio().createBufferSource();
    src.buffer = buf;
    src.connect(out);
    src.start();
    return;
  }
  (SYNTH[sound] ?? SYNTH[DEFAULT_SOUND])(out, t);
}

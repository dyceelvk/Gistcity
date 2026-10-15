/**
 * Face-scan-lite: look at the player through their camera once, estimate their
 * skin tone, and match it to the game's palette so the character starts from a
 * real likeness. Everything stays on the device — the snapshot is sampled and
 * discarded, never uploaded (the brief's face scan, done small and safely).
 */
import { SKIN_TONES, type Appearance } from './appearance';

export interface ScanResult { skin: string; index: number; note: string }

/** Capture one frame from the selfie camera and match the closest skin tone. */
export async function scanFace(): Promise<ScanResult> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device has no camera available.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 320 }, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    await video.play();
    // give the camera a moment to adjust exposure
    await new Promise((r) => setTimeout(r, 700));
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read the camera image.');
    ctx.drawImage(video, video.videoWidth / 2 - 18, video.videoHeight / 2 - 22, 36, 44, 0, 0, 64, 64);
    const data = ctx.getImageData(8, 8, 48, 40).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // skip very dark / very bright pixels (hair, glare, background)
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum < 30 || lum > 235) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (n < 30) throw new Error('Could not see a face clearly — try better light.');
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    let best = 0, bestD = Infinity;
    SKIN_TONES.forEach((hex, i) => {
      const pr = parseInt(hex.slice(1, 3), 16), pg = parseInt(hex.slice(3, 5), 16), pb = parseInt(hex.slice(5, 7), 16);
      const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return {
      skin: SKIN_TONES[best], index: best,
      note: best <= 2 ? 'rich deep tone matched' : best <= 5 ? 'warm mid tone matched' : 'light tone matched',
    };
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/** Apply a scan to an appearance. */
export function applyScan(ap: Appearance, scan: ScanResult): Appearance {
  return { ...ap, skin: scan.skin };
}

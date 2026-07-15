// Record the pitch demo to an mp4: loads ?demo=1, captures the full run
// with Playwright's recorder, converts with ffmpeg. Output lands next to
// this script as garda-demo.mp4 (and the raw .webm).
//   URL=http://localhost:5173/ node record-demo.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const S = path.dirname(new URL(import.meta.url).pathname);
const URL_ = process.env.URL ?? 'http://localhost:5173/';
const SIZE = { width: 1920, height: 1080 };

const browser = await chromium.launch({ args: ['--use-angle=metal'] });
const ctx = await browser.newContext({
  viewport: SIZE,
  recordVideo: { dir: path.join(S, 'rec'), size: SIZE },
});
const page = await ctx.newPage();
await page.goto(URL_ + '?demo=1', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__map, null, { timeout: 420000 });
console.log('map loaded, demo running…');
await page.waitForFunction(() => window.__demoDone === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
const video = page.video();
await ctx.close();
const webm = await video.path();
await browser.close();

const out = path.join(S, 'garda-demo.mp4');
execFileSync('ffmpeg', ['-y', '-i', webm,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
  { stdio: 'ignore' });
fs.copyFileSync(webm, path.join(S, 'garda-demo.webm'));
console.log('wrote', out, `${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);

/**
 * test/contrast.test.mjs — text contrast measured the way the screen draws it.
 *
 * axe sums contrast against the element's own background and stops there, so
 * it never sees the ambient glow (`body::before` in ui/app.css) that lights the
 * black ground from behind. Under that glow the old dim ink measured 4.14:1
 * on screen while axe passed it (TT-3509).
 *
 * This suite reads the tokens, the glow and the accent presets straight from
 * the shipped source, composites the surfaces text actually sits on over the
 * glow at its brightest, and asserts WCAG 1.4.3's 4.5:1 for every text ink.
 * Nothing here is a pinned colour: change a token and the sums follow it.
 *
 * The maths is WCAG 2.x relative luminance, with translucent layers composited
 * in sRGB the way browsers paint them. The glow's peak is not a single layer's
 * centre: on small screens the middle layer overlaps a corner one, so the
 * gradient field is evaluated across a set of real viewport sizes.
 *
 * Out of scope: a custom accent from the colour input (`<input type=color>` in
 * Settings > Colour). A user can pick a near-white accent whose glow no dim
 * grey can clear; the guarantee here covers the default and the presets.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Comments are dropped first, so a token or gradient quoted in prose is never read.
const CSS = fs.readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const SETTINGS = fs.readFileSync(new URL('../ui/views/settings.js', import.meta.url), 'utf8');

const AA = 4.5;

/* ------------------------------------------------------------ colour maths */

/** '#rgb' | '#rrggbb' | 'rgb(...)' | 'rgba(...)' -> { rgb: [0..1]x3, a } */
function parseColour(text) {
  const s = text.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return { rgb: [m[1], m[2], m[3]].map((v) => Number(v) / 255), a: m[4] === undefined ? 1 : Number(m[4]) };
  throw new Error(`contrast test cannot read the colour ${JSON.stringify(text)}`);
}

/** Paint `top` (with its alpha) over an opaque `under`. */
const over = (top, under) => top.rgb.map((c, i) => c * top.a + under[i] * (1 - top.a));

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------- the source */

/** Every custom property set in a `:root` rule, later rules winning. */
function rootTokens(css) {
  const tokens = {};
  for (const [, body] of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[name] = value.trim();
  }
  return tokens;
}

const TOKENS = rootTokens(CSS);

function token(name) {
  const value = TOKENS[name];
  assert.ok(value, `ui/app.css :root no longer defines ${name}`);
  return value;
}

/**
 * The alpha of the accent in a glow colour stop. The glow is written as
 * `var(--accent-wash)` or `color-mix(in srgb, var(--accent) N%, transparent)`,
 * and --accent-wash is itself the second form.
 */
function accentAlpha(stop) {
  const s = stop.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(s);
  if (ref) return accentAlpha(token(ref[1]));
  const mix = /^color-mix\(\s*in srgb\s*,\s*var\(--accent\)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(s);
  if (mix) return Number(mix[1]) / 100;
  throw new Error(`contrast test cannot read the glow stop ${JSON.stringify(stop)}`);
}

/**
 * The glow's layers, read from body::before. Each is
 * `radial-gradient(RXrem RYrem at CX% CY%, <accent stop>, transparent END%)`:
 * the accent at `alpha` in the centre, fading linearly to nothing at END% of
 * the ellipse. A layer written any other way fails the count check below
 * rather than being skipped.
 */
function glowLayers(css) {
  const rule = /body::before\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'ui/app.css no longer has a body::before glow rule');
  const body = rule[1];
  const gradients = [...body.matchAll(/[\w-]*gradient\(/g)].map((m) => m[0]);
  assert.ok(gradients.length > 0, 'the glow on body::before has no gradients');
  assert.deepEqual(gradients.filter((g) => g !== 'radial-gradient('), [],
    'the glow uses a gradient form this test does not model');
  const STOP = String.raw`(var\(--[\w-]+\)|color-mix\([^()]*\([^()]*\)[^()]*\))`;
  const LAYER = new RegExp(String.raw`radial-gradient\(\s*([\d.]+)rem\s+([\d.]+)rem\s+at\s+([\d.]+)%\s+([\d.]+)%\s*,\s*` +
    STOP + String.raw`\s*,\s*transparent\s+([\d.]+)%\s*\)`, 'g');
  const layers = [...body.matchAll(LAYER)].map((m) => ({
    rx: Number(m[1]), ry: Number(m[2]), cx: Number(m[3]) / 100, cy: Number(m[4]) / 100,
    alpha: accentAlpha(m[5]), end: Number(m[6]) / 100,
  }));
  assert.equal(layers.length, gradients.length,
    'every radial-gradient in the glow must be one this test can read');
  return layers;
}

/*
 * Viewports in CSS px, phones to a large desktop, both orientations. The layers
 * are sized in rem but placed in %, so they crowd together on small screens.
 */
const VIEWPORTS = [[320, 568], [375, 667], [390, 844], [844, 390], [600, 400], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]];
const REM = 16;
const STEPS = 200;

/** The most accent the glow puts on any pixel of a viewport, layers combined as 1 - Π(1 - a). */
function peakGlow(layers, [w, h]) {
  const W = w / REM;
  const H = h / REM;
  let peak = 0;
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const x = (W * i) / STEPS;
      const y = (H * j) / STEPS;
      let clear = 1;
      for (const g of layers) {
        const t = Math.hypot((x - g.cx * W) / g.rx, (y - g.cy * H) / g.ry);
        clear *= 1 - (t < g.end ? g.alpha * (1 - t / g.end) : 0);
      }
      peak = Math.max(peak, 1 - clear);
    }
  }
  return peak;
}

function accentPresets(source) {
  const block = /const ACCENT_PRESETS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(block, 'ui/views/settings.js no longer has ACCENT_PRESETS');
  const hexes = [...block[1].matchAll(/hex:\s*'(#[0-9a-f]{6})'/gi)].map((m) => m[1].toLowerCase());
  assert.ok(hexes.length > 0, 'ACCENT_PRESETS has no hex values this test can read');
  return hexes;
}

/* ------------------------------------------------------------- the sums */

const LAYERS = glowLayers(CSS);
const PEAK_GLOW = Math.max(...VIEWPORTS.map((v) => peakGlow(LAYERS, v)));
const ACCENTS = [...new Set([token('--accent').toLowerCase(), ...accentPresets(SETTINGS)])];

/*
 * What text sits on, painted bottom-up over the glowing ground. Each entry is a
 * list of translucent fills: a glass pane is --paper, a box inside a pane (a
 * field, an outside-the-month cell) adds --ground-2, and an event (an agenda
 * item, a calendar chip) adds the accent wash.
 */
const SURFACES = {
  'the bare ground': [],
  'a glass pane': ['--paper'],
  'a --ground-2 box in a glass pane': ['--paper', '--ground-2'],
  'an event wash in a glass pane': ['--paper', '--lapis-wash'],
};
const PLAIN = ['the bare ground', 'a glass pane', 'a --ground-2 box in a glass pane'];
const ALL = Object.keys(SURFACES);

/** A fill token as a colour; the accent wash resolves to the accent at its alpha. */
function fillColour(name, accent) {
  const value = token(name);
  if (/^(var|color-mix)\(/.test(value)) return { rgb: parseColour(accent).rgb, a: accentAlpha(value) };
  return parseColour(value);
}

function background(accent, fills, glowAlpha) {
  const ground = parseColour(token('--ground'));
  assert.equal(ground.a, 1, '--ground is expected to be opaque');
  let under = over({ rgb: parseColour(accent).rgb, a: glowAlpha }, ground.rgb);
  for (const fill of fills) under = over(fillColour(fill, accent), under);
  return under;
}

/* Each text ink and the surfaces it is drawn on. */
const INKS = {
  '--ink': ALL,
  '--ink-2': PLAIN,
  '--ink-3': PLAIN,
  '--ink-on-wash': ALL,
};

test('the glow and the accent presets are readable from the source', () => {
  assert.ok(PEAK_GLOW > 0 && PEAK_GLOW < 1, `peak glow alpha ${PEAK_GLOW}`);
  assert.ok(ACCENTS.length >= 2, 'expected the default accent plus presets');
  // The overlap is real: on a small phone the field outshines any single layer.
  assert.ok(PEAK_GLOW > Math.max(...LAYERS.map((l) => l.alpha)), `peak glow ${PEAK_GLOW}`);
});

test('dim text on an event wash uses --ink-on-wash, not a plain dim ink', () => {
  for (const selector of ['.agenda-where', '.chip-where', '.scope-state', '.account.is-connection-target .account-host']) {
    const rule = new RegExp(selector.replace(/\./g, '\\.') + String.raw`\s*\{([^}]*)\}`).exec(CSS);
    assert.ok(rule, `ui/app.css no longer styles ${selector}`);
    assert.match(rule[1], /(^|;)\s*color:\s*var\(--ink-on-wash\)/, `${selector} sits on the accent wash`);
  }
});

for (const [ink, surfaces] of Object.entries(INKS)) {
  test(`${ink} stays at or above ${AA}:1 under the ambient glow, for every preset accent`, () => {
    const fg = parseColour(token(ink));
    assert.equal(fg.a, 1, `${ink} is expected to be opaque`);
    const failures = [];
    for (const accent of ACCENTS) {
      for (const name of surfaces) {
        const r = ratio(fg.rgb, background(accent, SURFACES[name], PEAK_GLOW));
        if (r < AA) failures.push(`${name}, accent ${accent}: ${r.toFixed(2)}:1`);
      }
    }
    assert.deepEqual(failures, [], `${ink} (${token(ink)}) under the glow at its peak (${(PEAK_GLOW * 100).toFixed(1)}% accent)`);
  });
}

test('the glow is actually composited: it lowers the dim ink ratio', () => {
  // Guard against the compositing silently doing nothing: the glow must lower
  // the dim ink's ratio on a pane, or the suite above is not measuring it.
  const fg = parseColour(token('--ink-3')).rgb;
  const accent = token('--accent');
  const lit = ratio(fg, background(accent, SURFACES['a glass pane'], PEAK_GLOW));
  const dark = ratio(fg, background(accent, SURFACES['a glass pane'], 0));
  assert.ok(lit < dark, `glow should lower contrast (${lit.toFixed(2)} vs ${dark.toFixed(2)})`);
});

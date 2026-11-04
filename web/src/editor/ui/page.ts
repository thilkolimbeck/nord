/**
 * The page around the panel (docs/web-design.md, "Editor" → layout): no chrome. The page holds
 * the skip links (visually hidden until focused) and the panel; the only texts and links are the
 * colophon, one small legend line at the foot of the panel, whose "about" opens in place.
 */
import { h } from './dom.ts';

const REPO = 'https://github.com/thilkolimbeck/nord';

export interface PageApi {
  /** Where the panel goes. */
  readonly instrument: HTMLElement;
}

function link(href: string, text: string, cls?: string): HTMLAnchorElement {
  return h('a', { href, class: cls }, text);
}

export function renderPage(root: HTMLElement): PageApi {
  const skip = h('nav', { class: 'skip-links', 'aria-label': 'Skip links' },
    link('#program', 'skip to program'), link('#synth', 'skip to synth'), link('#keyboard', 'skip to keyboard'));

  const instrument = h('div', { class: 'instrument' });
  const main = h('main', { id: 'editor' }, h('h1', { class: 'visually-hidden' }, 'Stage 4 editor'), instrument);

  root.replaceChildren(skip, main);
  return { instrument };
}

function paragraphs(...texts: (string | Node)[][]): HTMLElement[] {
  return texts.map((parts) => h('p', null, ...parts));
}

/** The colophon line: approximation · not affiliated · about (opens in place) · source · agpl-3.0. */
export function mountColophon(root: HTMLElement): void {
  const sep = (): HTMLElement => h('span', { class: 'sep', 'aria-hidden': 'true' }, '·');
  const about = h('details', { class: 'about' },
    h('summary', null, 'about'),
    h('div', { class: 'about-copy' },
      h('h2', { class: 'about-heading' }, 'how it works'),
      ...paragraphs(
        ['The editor runs in your browser. Nothing is uploaded. Nothing is sent to an instrument unless you switch MIDI '
          + 'out on yourself.'],
        ['Every control edits one Stage 4 field, with the Stage 4\'s own value labels, ranges and units where its '
          + 'tables have them. The organ, piano and synth panels edit their focused layer: the layer keys switch the '
          + 'focus, on/off switches a layer. The program region switches the layer scene, the sections, split and '
          + 'transpose; the panels edit the active scene. The layer effects region edits the block in effects focus, '
          + 'which follows the layer keys.'],
        ['The sound comes from the browser\'s Web Audio engine, with an AudioWorklet for band-limited oscillators, the '
          + 'ladder filter and drive where the browser supports it. It approximates the Stage 4; it is not the Stage 4 '
          + 'engine.']),
      h('h2', { class: 'about-heading' }, 'limits'),
      ...paragraphs(
        ['The sound is an approximation. Controls marked nv are not verified: their curve or unit is a guess. Coarse '
          + 'means the browser engine only roughly follows the setting (until the AudioWorklet engine has loaded, or '
          + 'where the browser has none).'],
        ['Organ and piano are approximations, marked ≈: an additive organ model with an approximated rotary speaker, '
          + 'and pianos synthesized per piano type. No Nord samples are used; the piano names only pick a sound family.'],
        ['The layer effects (Mod 1, Mod 2, delay, amp and EQ, compressor, reverb) are modelled in the browser, marked ≈; '
          + 'the reverbs use generated impulse responses, no Nord ones. Morphs play from the wheel, aftertouch and '
          + 'control pedal strip next to the keys or from MIDI; how the Stage 4 scales a morph amount is a guess (nv).'],
        ['Samples mode plays your own audio files, imported with files › samples. They are kept only in this browser '
          + 'and never uploaded; an app preset carries them only if you switch embed own samples on. Nord samples, the '
          + 'wave oscillators and the real pianos are Nord content and are not available.'],
        ['MIDI control in moves the controls from the CC and NRPN list of the manual\'s Appendix II, scaling assumed. '
          + 'MIDI out sends to a connected Stage 4 or other device only while you switch send to stage 4, send notes or '
          + 'extern out on; SysEx is never used. Extern layers play their MIDI channel instead of sounding.'],
        ['Still not playing: the arpeggiator patterns (their accents, step lengths and pans are not decoded), the '
          + 'arpeggiator driving an extern layer, the aux keyboard and the output buses (stored settings), the pedal '
          + 'assignments and the rotary angles. Preset references are read-only.'],
        ['Split crossfades and whether the split note belongs to the upper zone are guesses, like the organ and '
          + 'piano layer bits.'],
        ['The Stage 4 program export is experimental and untested on hardware. Load it into a free slot. Own samples '
          + 'are never part of it.'],
        ['MIDI needs Web MIDI, which Safari does not have. Chrome, Edge and Firefox support it.']),
      h('h2', { class: 'about-heading' }, 'source'),
      ...paragraphs(
        ['AGPL-3.0. The source is on ', link(REPO, 'GitHub'), '.'],
        ['Built on the work of opennord and ns4decode (MIT).'])));

  root.classList.add('colophon', 'legend');
  root.replaceChildren(
    h('span', null, 'approximation of the nord stage 4'), sep(),
    h('span', null, 'not affiliated with clavia or nord'), sep(),
    about, sep(),
    link(REPO, 'source'), sep(),
    h('span', null, 'agpl-3.0'));
}

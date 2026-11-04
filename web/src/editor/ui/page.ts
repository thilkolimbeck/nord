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
        ['The editor runs in your browser. Nothing is uploaded and nothing is sent to an instrument.'],
        ['Every control edits one Stage 4 field, with the Stage 4\'s own value labels, ranges and units where its '
          + 'tables have them. The organ, piano and synth panels edit their focused layer: the layer keys switch the '
          + 'focus, on/off switches a layer. The program region switches the layer scene, the sections, split and '
          + 'transpose; the panels edit the active scene.'],
        ['The sound comes from the browser\'s Web Audio engine. It approximates the Stage 4; it is not the Stage 4 '
          + 'engine.']),
      h('h2', { class: 'about-heading' }, 'limits'),
      ...paragraphs(
        ['The sound is an approximation. Controls marked nv are not verified: their curve or unit is a guess. Coarse '
          + 'means the browser engine only roughly follows the setting.'],
        ['Organ and piano are approximations, marked ≈: an additive organ model with an approximated rotary speaker, '
          + 'and pianos synthesized per piano type. No Nord samples are used; the piano names only pick a sound family.'],
        ['Extern, the layer effects, the master clock and morphs are not implemented: their values are shown, stored '
          + 'and exported, but do not sound. The same holds for the arpeggiator, samples mode and the wave oscillator '
          + 'type, marked no sound in MVP or not implemented. Preset references, the aux keyboard and output routing '
          + 'are read-only.'],
        ['Split crossfades and whether the split note belongs to the upper zone are guesses, like the organ and '
          + 'piano layer bits.'],
        ['The Stage 4 program export is experimental and untested on hardware. Load it into a free slot.'],
        ['MIDI input needs Web MIDI, which Safari does not have. Chrome, Edge and Firefox support it.']),
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

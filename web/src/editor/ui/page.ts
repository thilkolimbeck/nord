/**
 * The page around the panel (docs/web-design.md, "Editor" layout 1, 4, 5): skip links, header
 * with wordmark and nav, the sections how, limits and source, and the footer legend line.
 */
import { h } from './dom.ts';

/** Back to the converter: absolute, because a relative link would resolve against /nordconvert/editor. */
export const CONVERTER_URL = '/nordconvert/';
const REPO = 'https://github.com/thilkolimbeck/nord-convert';

export interface PageApi {
  /** Where the panel and its print-out go. */
  readonly instrument: HTMLElement;
}

function link(href: string, text: string): HTMLAnchorElement {
  return h('a', { href }, text);
}

function info(id: string, title: string, ...paragraphs: (string | Node)[][]): HTMLElement {
  return h('section', { class: 'info', id, 'aria-labelledby': `${id}-heading` },
    h('h2', { class: 'info-heading', id: `${id}-heading` }, title),
    h('div', { class: 'info-copy' }, ...paragraphs.map((parts) => h('p', null, ...parts))));
}

export function renderPage(root: HTMLElement): PageApi {
  const skip = h('nav', { class: 'skip-links', 'aria-label': 'Skip links' },
    link('#program', 'skip to program'), link('#synth', 'skip to synth'), link('#keyboard', 'skip to keyboard'));

  const nav = h('nav', { 'aria-label': 'Pages and sections' }, h('ul', { class: 'nav' },
    h('li', null, link(CONVERTER_URL, 'converter')), h('li', null, link('#how', 'how')),
    h('li', null, link('#limits', 'limits')), h('li', null, link('#source', 'source'))));
  const header = h('header', { class: 'site-header' },
    h('p', { class: 'wordmark' }, 'st-4 → editor ', h('span', { class: 'muted' }, 'sound programming')), nav);

  const instrument = h('div', { class: 'instrument' });
  const main = h('main', { id: 'editor' },
    h('h1', { class: 'visually-hidden' }, 'Stage 4 editor'),
    instrument,
    info('how', 'how it works',
      ['The editor runs in your browser. Nothing is uploaded and nothing is sent to an instrument.'],
      ['Every control edits one Stage 4 field, with the Stage 4\'s own value labels, ranges and units where its '
        + 'tables have them. The organ, piano and synth panels edit their focused layer: the layer keys switch the '
        + 'focus, on/off switches a layer. The program region switches the layer scene, the sections, split and '
        + 'transpose; the panels edit the active scene.'],
      ['The sound comes from the browser\'s Web Audio engine. It approximates the Stage 4; it is not the Stage 4 '
        + 'engine.']),
    info('limits', 'limits',
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
    info('source', 'source',
      ['AGPL-3.0. The source is on ', link(REPO, 'GitHub'), '.'],
      ['Built on the work of opennord, ns4decode (MIT) and ns3-program-viewer.']),
  );

  const footer = h('footer', { class: 'site-footer' }, h('p', { class: 'legend' },
    'agpl-3.0 · ', link(REPO, 'source on github'), ' · not affiliated with clavia or nord'));

  root.replaceChildren(skip, header, main, footer);
  return { instrument };
}

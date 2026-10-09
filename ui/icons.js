// BlockNSFW — the icon set, for UI that script builds.
//
// The same drawings as monolab Threshold's icon set: stroke 1.25, round caps
// and joins, a 16-unit grid (24 for mail and GitHub), in currentColor. Static
// markup carries inline copies of these paths; this file serves the pages
// that build their rows in script. Nodes are made with createElementNS, never
// innerHTML.
//
// Two icons are new to the set and drawn by the same rules: "expand" and
// "collapse", for the Settings page's full-width toggle.

(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Each entry: viewBox size, then a list of [tag, attributes].
  const ICONS = {
    'arrow-right': [16, [['path', { d: 'M2.5 8h11M9.5 4l4 4-4 4' }]]],
    'arrow-left': [16, [['path', { d: 'M13.5 8h-11M6.5 4l-4 4 4 4' }]]],
    'arrow-down': [16, [['path', { d: 'M8 2.5v11M4 9.5l4 4 4-4' }]]],
    'arrow-up-right': [16, [['path', { d: 'M4.5 11.5l7-7M6 4.5h5.5V10' }]]],
    check: [16, [['path', { d: 'M3 8.5l3.5 3.5L13 4.5' }]]],
    close: [16, [['path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' }]]],
    held: [16, [
      ['path', { d: 'M2 10.5h12', 'stroke-width': '1.5' }],
      ['path', { d: 'M8 2v5.5' }],
      ['path', { d: 'M5.5 5.5L8 7.75 10.5 5.5' }]
    ]],
    mail: [24, [
      ['rect', { x: '2.75', y: '5', width: '18.5', height: '14', rx: '1' }],
      ['path', { d: 'M3.5 6.5l8.5 6.5 8.5-6.5' }]
    ]],
    expand: [16, [['path', { d: 'M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9' }]]],
    collapse: [16, [['path', { d: 'M9 3v4h4M9 7l4.5-4.5M7 13V9H3M7 9l-4.5 4.5' }]]]
  };

  // GitHub is the one filled icon in the set.
  const FILLED = {
    github: [24, 'M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11.02 11.02 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.04.77 2.1 0 1.52-.01 2.74-.01 3.11 0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z']
  };

  // Directional classes let CSS step an arrow its own way on hover.
  const DIRECTION_CLASS = {
    'arrow-right': 'icon-right',
    'arrow-left': 'icon-left',
    'arrow-up-right': 'icon-up-right',
    'arrow-down': 'icon-down'
  };

  function create(name, options) {
    const opts = options || {};
    const doc = opts.document || root.document;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const classes = ['icon'];
    if (opts.size && opts.size !== 16) classes.push('icon-' + opts.size);
    if (DIRECTION_CLASS[name]) classes.push(DIRECTION_CLASS[name]);
    if (opts.className) classes.push(opts.className);

    if (FILLED[name]) {
      const [box, d] = FILLED[name];
      svg.setAttribute('viewBox', '0 0 ' + box + ' ' + box);
      classes.push('icon-fill');
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    } else {
      const spec = ICONS[name];
      if (!spec) throw new Error('Unknown icon: ' + name);
      const [box, parts] = spec;
      svg.setAttribute('viewBox', '0 0 ' + box + ' ' + box);
      for (const [tag, attrs] of parts) {
        const el = doc.createElementNS(SVG_NS, tag);
        for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key]);
        svg.appendChild(el);
      }
    }
    svg.setAttribute('class', classes.join(' '));
    return svg;
  }

  root.UiIcons = Object.freeze({
    create,
    names: Object.freeze(Object.keys(ICONS).concat(Object.keys(FILLED)))
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

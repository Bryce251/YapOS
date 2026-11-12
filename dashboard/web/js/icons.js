const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  menu: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
  x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  overview: [
    ['rect', { x: 3.5, y: 3.5, width: 7, height: 9, rx: 1.5 }],
    ['rect', { x: 13.5, y: 3.5, width: 7, height: 5, rx: 1.5 }],
    ['rect', { x: 13.5, y: 11.5, width: 7, height: 9, rx: 1.5 }],
    ['rect', { x: 3.5, y: 15.5, width: 7, height: 5, rx: 1.5 }],
  ],
  apps: [
    ['rect', { x: 4, y: 4, width: 6.5, height: 6.5, rx: 2 }],
    ['rect', { x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 2 }],
    ['rect', { x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 2 }],
    ['rect', { x: 13.5, y: 13.5, width: 6.5, height: 6.5, rx: 2 }],
  ],
  shield: [['path', { d: 'M12 3l7 3v5.2c0 4.4-2.9 8.1-7 9.3-4.1-1.2-7-4.9-7-9.3V6z' }], ['path', { d: 'M9 12l2 2 4-4' }]],
  globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.6-3.7-9S9.6 5.6 12 3z' }]],
  server: [
    ['rect', { x: 3.5, y: 4, width: 17, height: 7, rx: 2 }],
    ['rect', { x: 3.5, y: 13, width: 17, height: 7, rx: 2 }],
    ['path', { d: 'M7.5 7.5h.01M7.5 16.5h.01' }],
  ],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4' }]],
  moon: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z' }]],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M20 20l-4.2-4.2' }]],
  'chevron-down': [['path', { d: 'M6 9l6 6 6-6' }]],
  'chevron-up': [['path', { d: 'M6 15l6-6 6 6' }]],
  'chevron-right': [['path', { d: 'M9 6l6 6-6 6' }]],
  'chevron-left': [['path', { d: 'M15 6l-6 6 6 6' }]],
  'chevrons-up-down': [['path', { d: 'M8 9l4-4 4 4M8 15l4 4 4-4' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M15 5.5V5a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 5v8.5A1.5 1.5 0 0 0 5.5 15H6' }]],
  link: [['path', { d: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1' }]],
  external: [['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
  logout: [['path', { d: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4' }]],
  refresh: [['path', { d: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4' }]],
  alert: [['path', { d: 'M10.3 4.3L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4M12 17h.01' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5M12 8h.01' }]],
  users: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', { d: 'M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8' }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
  activity: [['path', { d: 'M3 12h4l3-8 4 16 3-8h4' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  trophy: [['path', { d: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5v1A3.5 3.5 0 0 0 8 10.5M16 6h3.5v1a3.5 3.5 0 0 1-3.5 3.5M12 13v4M8 20h8M9.5 17h5' }]],
  coins: [['ellipse', { cx: 9, cy: 7, rx: 6, ry: 3 }], ['path', { d: 'M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7M9 14v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-4c0-1.5-2.2-2.8-5.2-3' }]],
  gift: [['rect', { x: 3.5, y: 8, width: 17, height: 4, rx: 1 }], ['path', { d: 'M5 12v8h14v-8M12 8v12M12 8S10.5 4 8.2 4a2 2 0 0 0 0 4M12 8s1.5-4 3.8-4a2 2 0 0 1 0 4' }]],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
  sort: [['path', { d: 'M8 5v14M5 8l3-3 3 3M16 19V5M13 16l3 3 3-3' }]],
  'arrow-up': [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  'arrow-down': [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
  'arrow-right': [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  signal: [['path', { d: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M1.5 9a15 15 0 0 1 21 0' }]],
  'signal-off': [['path', { d: 'M3 3l18 18M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M5 12.5a10 10 0 0 1 4-2.3M19 12.5a10 10 0 0 0-2.4-1.7M1.5 9a15 15 0 0 1 4.6-3M10.7 4.6A15 15 0 0 1 22.5 9' }]],
  message: [['path', { d: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z' }]],
  ticket: [['path', { d: 'M4 6.5h16V10a2 2 0 0 0 0 4v3.5H4V14a2 2 0 0 0 0-4zM14 6.5v11' }]],
  star: [['path', { d: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z' }]],
  sparkles: [['path', { d: 'M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8zM18.5 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z' }]],
  cpu: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['rect', { x: 9.5, y: 9.5, width: 5, height: 5, rx: 0.5 }], ['path', { d: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3' }]],
  power: [['path', { d: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0' }]],
  hash: [['path', { d: 'M5 9h15M4 15h15M10 3.5L8 20.5M16 3.5l-2 17' }]],
  volume: [['path', { d: 'M4 9.5v5h3.5L12 18V6L7.5 9.5zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11' }]],
  folder: [['path', { d: 'M3.5 7a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }]],
  at: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8' }]],
  tag: [['path', { d: 'M3.5 12V5a1.5 1.5 0 0 1 1.5-1.5h7l8.5 8.5-8.5 8.5z' }], ['circle', { cx: 8, cy: 8, r: 1.5 }]],
  share: [['circle', { cx: 18, cy: 5.5, r: 2.5 }], ['circle', { cx: 6, cy: 12, r: 2.5 }], ['circle', { cx: 18, cy: 18.5, r: 2.5 }], ['path', { d: 'M8.3 13.2l7.4 4.1M15.7 6.7l-7.4 4.1' }]],
  sliders: [['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }], ['circle', { cx: 15, cy: 6, r: 2 }], ['circle', { cx: 9, cy: 12, r: 2 }], ['circle', { cx: 17, cy: 18, r: 2 }]],
  inbox: [['path', { d: 'M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1.5 2.5h5L16 13h5' }]],
  smile: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01' }]],
  palette: [['path', { d: 'M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.5-4-8.2-9-8.2z' }], ['path', { d: 'M7.5 11h.01M10 7.5h.01M14.5 7.5h.01' }]],
  'eye-off': [['path', { d: 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.6 3.2M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2' }]],
};

function make(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function icon(name, { size = 16, label = '', className = '' } = {}) {
  const shapes = ICONS[name] || ICONS.info;
  const svg = make('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: `icon${className ? ` ${className}` : ''}`,
    focusable: 'false',
  });
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of shapes) svg.appendChild(make(tag, attrs));
  return svg;
}

export function logoMark({ size = 28, label = 'YapOS' } = {}) {
  const svg = make('svg', { viewBox: '0 0 32 32', width: size, height: size, class: 'logo-mark', focusable: 'false' });
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(make('rect', { x: 0, y: 0, width: 32, height: 32, rx: 8, fill: '#f2613f' }));
  svg.appendChild(make('path', { d: 'M10 9l6 7.5L22 9M16 16.5V23.5', fill: 'none', stroke: '#ffffff', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS);

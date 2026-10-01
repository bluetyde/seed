// Small inline icons, shared by the top bar and the welcome page (both load this script first). Plain script: no imports.

const ICON_PATHS: Record<string, string> = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  atom: '<circle cx="12" cy="12" r="2.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>',
  pipe: '<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M7 8v8M17 8v8"/>',
  reactor: '<rect x="5" y="3" width="14" height="18" rx="4"/><path d="M9 8h6M9 12h6M9 16h6"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
};

function iconSvg(name: string, size = 16): string {
  const body = ICON_PATHS[name] ?? ICON_PATHS["app"]!;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

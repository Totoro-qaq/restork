/** Inline nav sprite. Stroke 1.5 / 16px / currentColor; no icon-pack dependency. */
export function navSpriteMarkup(): string {
  const icons: Array<[string, string]> = [
    ["nav-start", '<path d="M3 8h10M10 4.5 13.5 8 10 11.5"/>'],
    ["nav-overview", '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx=".8"/>'
      + '<rect x="9" y="2.5" width="4.5" height="4.5" rx=".8"/>'
      + '<rect x="2.5" y="9" width="4.5" height="4.5" rx=".8"/>'
      + '<rect x="9" y="9" width="4.5" height="4.5" rx=".8"/>'],
    ["nav-runs", '<path d="M3 4.5h10M3 8h10M3 11.5h7"/>'],
    ["nav-tasks", '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5"/><path d="m5 8 2 2 4-4.5"/>'],
    ["nav-conversation", '<path d="M3.5 4.2h9A1.3 1.3 0 0 1 13.8 5.5v4.2A1.3 1.3 0 0 1 12.5 11H7.5L4 13.2V5.5A1.3 1.3 0 0 1 5.3 4.2Z"/>'],
    ["nav-vault", '<path d="M4 3.5h6.5L12.5 5.5V12.5H4Z"/><path d="M10.5 3.5V5.5H12.5"/>'],
    ["nav-radar", '<circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="8" r="4.4"/>'
      + '<path d="M8 8 12 4M8 1.8V3M14.2 8H13M8 13v1.2M3 8H1.8"/>'],
    ["nav-deliverables", '<path d="M5 2.75h4.5L12.25 5.5V13.25H5Z"/><path d="M9.5 2.75V5.5h2.75"/>'],
    ["nav-automation", '<path d="M4.2 6.2A4.3 4.3 0 0 1 11.5 5.2"/><path d="M11.8 9.8A4.3 4.3 0 0 1 4.5 10.8"/><path d="M10.2 3.2 11.5 5.2 9.4 6"/><path d="M5.8 12.8 4.5 10.8 6.6 10"/>'],
    ["nav-settings", '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.6v1.6M8 11.8v1.6M2.6 8h1.6M11.8 8h1.6"/>'
      + '<path d="M4.05 4.05l1.15 1.15M10.8 10.8l1.15 1.15M4.05 11.95l1.15-1.15M10.8 5.2l1.15-1.15"/>'],
  ];
  const symbols = icons.map(([id, inner]) => (
    `<symbol id="${id}" viewBox="0 0 16 16" fill="none" stroke="currentColor" `
    + `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`
  )).join("");
  return `<svg class="icon-sprite" aria-hidden="true" focusable="false">${symbols}</svg>`;
}

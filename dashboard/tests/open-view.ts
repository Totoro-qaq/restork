/** Open a dashboard view after D2 aliases removed some rail items. */
export function openDashboardView(root: HTMLElement, view: string): void {
  const nav = root.querySelector<HTMLButtonElement>(`.sidebar nav [data-view="${view}"]`);
  if (nav) {
    nav.click();
    return;
  }
  const sub = root.querySelector<HTMLButtonElement>(`[data-subview="${view}"]`);
  if (sub) {
    sub.click();
    return;
  }
  const tab = root.querySelector<HTMLButtonElement>(`[data-settings-tab="${view}"]`);
  if (tab) {
    tab.click();
    return;
  }
  root.querySelector<HTMLButtonElement>(`[data-open-view="${view}"]`)?.click();
}

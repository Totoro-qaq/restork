/**
 * The single owner of the global live regions. Feature modules announce
 * through these helpers instead of reaching into `main.ts`.
 */
// A message the user cannot see is not a message. Both live regions stay in the
// DOM so assistive technology keeps its subscription; only visibility changes.
function paintGlobalNotice(root: HTMLElement, message: string, severity: "status" | "error"): void {
  const region = root.querySelector<HTMLElement>("#global-status-region");
  const status = root.querySelector<HTMLElement>("#global-status");
  const alert = root.querySelector<HTMLElement>("#global-alert");
  const dismiss = root.querySelector<HTMLButtonElement>("#global-status-dismiss");
  if (!region || !status || !alert) return;

  const active = severity === "error" ? alert : status;
  const idle = severity === "error" ? status : alert;
  idle.textContent = "";
  idle.hidden = true;
  active.textContent = message;
  active.hidden = message === "";
  region.dataset.visible = message === "" ? "false" : "true";
  if (dismiss) dismiss.hidden = message === "";
}

export function announceStatus(root: HTMLElement, message: string): void {
  paintGlobalNotice(root, message, "status");
}

export function announceError(root: HTMLElement, message: string): void {
  paintGlobalNotice(root, message, "error");
}

export function clearAnnouncement(root: HTMLElement): void {
  paintGlobalNotice(root, "", "status");
}

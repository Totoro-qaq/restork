/** Generate a Core-safe profile_id from a display name. */
export function slugProfileId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "provider";
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  }
  return `${slug}-${(hash >>> 0).toString(16).padStart(4, "0").slice(0, 4)}`;
}

/** Keep profile_id filled unless the user typed their own value. */
export function bindProviderProfileId(form: HTMLFormElement): void {
  const id = form.elements.namedItem("profile_id") as HTMLInputElement | null;
  const name = form.elements.namedItem("display_name") as HTMLInputElement | null;
  if (!id || !name) return;
  const sync = (): void => {
    if (id.readOnly) return;
    if (id.dataset.manual === "true" && id.value.trim()) return;
    id.value = slugProfileId(name.value);
  };
  name.addEventListener("input", sync);
  id.addEventListener("input", () => {
    id.dataset.manual = id.value.trim() ? "true" : "";
  });
  form.addEventListener("submit", sync, true);
}

import "./styles.css";

type Mode = {
  readonly name: "Research" | "Study" | "Work";
  readonly description: string;
};

const modes: readonly Mode[] = [
  {
    name: "Research",
    description: "Investigate sources and turn findings into reviewable notes.",
  },
  {
    name: "Study",
    description: "Connect concepts, practice retrieval, and build durable understanding.",
  },
  {
    name: "Work",
    description: "Shape tasks and handoffs while keeping every external action explicit.",
  },
];

function modeCard(mode: Mode): HTMLElement {
  const card = document.createElement("article");
  card.className = "mode-card";

  const heading = document.createElement("h2");
  heading.textContent = mode.name;

  const description = document.createElement("p");
  description.textContent = mode.description;

  card.append(heading, description);
  return card;
}

export function mountDashboard(root: HTMLElement): void {
  const shell = document.createElement("section");
  shell.className = "dashboard-shell";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "LOCAL-FIRST AGENT WORKSPACE";

  const title = document.createElement("h1");
  title.textContent = "Restork";

  const summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent = "One Core for research, study, and work. Your private Vault stays local.";

  const modeGrid = document.createElement("div");
  modeGrid.className = "mode-grid";
  modeGrid.setAttribute("aria-label", "Restork modes");
  modes.forEach((mode) => modeGrid.append(modeCard(mode)));

  const status = document.createElement("p");
  status.className = "status";
  status.textContent = "Foundation mode: no Vault, model, or network connection is active.";

  shell.append(eyebrow, title, summary, modeGrid, status);
  root.replaceChildren(shell);
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  mountDashboard(app);
}

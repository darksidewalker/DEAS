import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NeuralGraph, neuralRoad, neuralSnakeRows, type NeuralNode } from "./NeuralGraph";
import { NeuralPath } from "./NeuralPath";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n/I18nProvider";

const nodes: NeuralNode[] = [
  { id: "root", label: "Start", column: 0, order: 0, parentId: null },
  { id: "later", label: "Later", column: 1, order: 2, parentId: "root", disabled: true },
  { id: "next", label: "Next", column: 1, order: 1, parentId: "root" },
];
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("choices stack in column order with stable identifiers and meaningful selection", () => {
  const onSelect = vi.fn();
  const view = render(<I18nProvider><NeuralGraph nodes={nodes} selectedId="next" onSelect={onSelect} /></I18nProvider>);
  expect([...view.container.querySelectorAll("[data-node]")].map((node) => node.getAttribute("data-node"))).toEqual(["root", "next", "later"]);
  expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(onSelect.mock.calls).toEqual([["root"]]);
});

test("measured roads use real button bounds and refresh on resize", () => {
  let offset = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.node;
    const x = id === "root" ? 40 : id ? 300 + offset : 0;
    const y = id === "later" ? 220 : 20;
    return { x, y, left: x, top: y, right: x + 160, bottom: y + 140, width: id ? 160 : 520, height: id ? 140 : 400, toJSON: () => ({}) };
  });
  const view = render(<I18nProvider><NeuralGraph nodes={nodes} onSelect={() => {}} /></I18nProvider>);
  const paths = view.container.querySelectorAll(".neural-road-line");
  expect(paths).toHaveLength(2);
  expect(view.container.querySelector('[data-edge="root->next"]')?.getAttribute("data-from")).toBe("root");
  expect(view.container.querySelector('[data-edge="root->next"]')?.getAttribute("data-to")).toBe("next");
  const previous = paths[0].getAttribute("d");
  offset = 30;
  fireEvent(window, new Event("resize"));
  expect(paths[0].getAttribute("d")).not.toBe(previous);
  expect(paths[0].getAttribute("d")).toContain("410"); // bottom/top ports use the moved shell's centre
});

test("suggestions show only a badge without roads, legend or automatic selection", () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const isNode = Boolean(this.dataset.node);
    const x = this.dataset.node === "root" ? 40 : 300;
    return { x, y: 20, left: x, top: 20, right: x + 160, bottom: 160, width: isNode ? 160 : 520, height: isNode ? 140 : 400, toJSON: () => ({}) };
  });
  const select = vi.fn();
  const view = render(<I18nProvider><NeuralGraph nodes={nodes} onSelect={select} edges={[{id:"companion",fromId:"root",toId:"next",kind:"suggested"}]} /></I18nProvider>);
  const road = view.container.querySelector('.neural-road.suggested[data-edge="root->next"]');
  expect(road).toBeNull();
  expect(view.container.querySelector(".neural-legend, .neural-road-label")).toBeNull();
  expect(screen.getByRole("button", {name:"Next"}).querySelector('[data-flag="suggested"]')?.textContent).toBe("Suggested");
  expect(screen.getByRole("button",{name:"Next"}).getAttribute("aria-pressed")).toBe("false");
  expect(select).not.toHaveBeenCalled();
});

test("same-column roads use an outside gutter instead of crossing intervening blobs", () => {
  const road = neuralRoad({ x: 40, y: 0, width: 180, height: 140 }, { x: 40, y: 340, width: 180, height: 140 });
  expect(road).toBe("M 40 70 C 16 70, 16 70, 16 240 S 16 410, 40 410");
});

test("paw references are sanitized and unique across independent graphs", () => {
  const view = render(<svg><NeuralPath d="M 0 0 L 80 0" motion="paws" /><NeuralPath d="M 0 10 L 80 10" motion="paws" /></svg>);
  const ids = [...view.container.querySelectorAll("path[id]")].map((p) => p.id);
  expect(new Set(ids).size).toBe(2);
  ids.forEach((id) => expect(id).toMatch(/^road-[a-zA-Z0-9_-]+$/));
  [...view.container.querySelectorAll("mpath")].forEach((path) => expect(ids).toContain(path.getAttribute("href")?.slice(1)));
  // Start every paw on its road immediately; positive delays flash glyphs at SVG origin.
  [...view.container.querySelectorAll("animateMotion")].forEach((animation) => expect(parseFloat(animation.getAttribute("begin") ?? "1")).toBeLessThanOrEqual(0));
});

test("reduced motion removes both lighting and SMIL paw animation", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const view = render(<svg><NeuralPath d="M 0 0 L 80 0" motion="paws" /><NeuralPath d="M 0 10 L 80 10" motion="light" /></svg>);
  expect(view.container.querySelector("animateMotion")).toBeNull();
  expect(view.container.querySelector(".neural-road-light")).toBeNull();
  expect(view.container.querySelectorAll('[data-motion="off"]')).toHaveLength(2);
});

const grouped: NeuralNode = {
  id: "setup:features", label: "Features", description: "Choose optional capabilities", parentId: null, column: 0, order: 0, selectionMode: "multi",
  choices: [
    { id: "setup:features:director", label: "Director", description: "Plan a film", selected: true, suggests: ["setup:features:forge"] },
    { id: "setup:features:forge", label: "Forge", description: "Build prompts" },
    { id: "setup:features:locked", label: "Locked", disabled: true },
  ],
};

test("a grouped decision has one measured shell, separate staircase options and no nested buttons", () => {
  const select = vi.fn();
  const view = render(<I18nProvider><NeuralGraph nodes={[grouped]} onSelect={select} /></I18nProvider>);
  expect(view.container.querySelectorAll("[data-node]")).toHaveLength(1);
  expect(view.container.querySelector('[data-node="setup:features"]')?.tagName).toBe("DIV");
  expect(view.container.querySelector("button button")).toBeNull();
  expect([...view.container.querySelectorAll("[data-choice]")].map(element => element.getAttribute("data-choice"))).toEqual(grouped.choices!.map(choice => choice.id));
  fireEvent.click(screen.getByRole("button", { name: "Features" }));
  fireEvent.click(screen.getByRole("button", { name: "Forge" }));
  fireEvent.click(screen.getByRole("button", { name: "Locked" }));
  expect(select.mock.calls).toEqual([["setup:features"], ["setup:features:forge"]]);
  expect(screen.getByRole("button", { name: "Director" }).getAttribute("aria-pressed")).toBe("true");
});

test("description reserves its natural footprint inside the existing button and never consumes the selection click", async () => {
  const select = vi.fn();
  const view = render(<I18nProvider><NeuralGraph nodes={[grouped]} onSelect={select} /></I18nProvider>);
  const button = screen.getByRole("button", { name: "Forge" });
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Build prompts");
  expect(button.querySelector(".neural-help.neural-help-reserved")?.textContent).toBe("Build prompts");
  expect(view.container.querySelectorAll(".neural-blob")).toHaveLength(1);
  const help = document.getElementById(button.getAttribute("aria-describedby")!);
  const helpCount = view.container.querySelectorAll(".neural-help").length;
  const bodyChildren = document.body.children.length;
  fireEvent.mouseEnter(view.container.querySelector('[data-choice="setup:features:forge"]')!);
  await waitFor(() => expect(button.querySelector(".neural-help:not(.neural-help-reserved)")?.textContent).toBe("Build prompts"));
  expect(document.body.children.length).toBe(bodyChildren);
  expect(button.querySelector(".neural-help")).toBe(help);
  expect(view.container.querySelectorAll(".neural-help")).toHaveLength(helpCount);
  expect(document.querySelectorAll(".neural-blob")).toHaveLength(1);
  fireEvent.mouseLeave(view.container.querySelector('[data-choice="setup:features:forge"]')!);
  fireEvent.focus(button);
  await waitFor(() => expect(button.querySelector(".neural-help:not(.neural-help-reserved)")?.textContent).toBe("Build prompts"));
  fireEvent.click(button);
  expect(select).toHaveBeenCalledWith("setup:features:forge");
  expect(button.querySelector(".neural-help.neural-help-reserved")?.textContent).toBe("Build prompts"); // selecting dismisses help even while focused
  fireEvent.blur(button);
  expect(button.querySelector(".neural-help.neural-help-reserved")?.textContent).toBe("Build prompts");
  fireEvent.keyDown(window, {key:"Tab"}); // a deliberate new interaction re-enables help
  fireEvent.mouseEnter(view.container.querySelector('[data-choice="setup:features:forge"]')!);
  await waitFor(() => expect(document.querySelector(".neural-help:not(.neural-help-reserved)")?.textContent).toBe("Build prompts"));
});

test("long descriptions stay complete and accessible in the same reserved spans on every atom", () => {
  const description = "A complete long explanation ".repeat(30);
  const view = render(<I18nProvider><NeuralGraph nodes={[
    {...nodes[0], description},
    {...grouped, description, choices:[{id:"long:choice", label:"Long choice", description}]},
  ]} onSelect={() => {}} /></I18nProvider>);
  for (const label of ["Start", "Features", "Long choice"]) {
    const button = screen.getByRole("button", {name:label, description:description.trim()});
    const help = button.querySelector(".neural-help.neural-help-reserved")!;
    expect(help.textContent).toBe(description);
    expect(help.id).toBe(button.getAttribute("aria-describedby"));
    expect(help.hasAttribute("aria-hidden")).toBe(false);
    fireEvent.focus(button);
    expect(button.querySelector(".neural-help:not(.neural-help-reserved)")).toBe(help);
    fireEvent.click(button);
    expect(button.querySelector(".neural-help.neural-help-reserved")).toBe(help);
    fireEvent.blur(button);
    fireEvent.keyDown(window, {key:"Tab"});
  }
  expect(view.container.querySelector(".neural-help.neural-sr-only")).toBeNull();
  expect(view.container.querySelectorAll(".neural-help")).toHaveLength(3);
});

test("group heading reveals description in its existing button, never a separate bubble", async () => {
  const view = render(<I18nProvider><NeuralGraph nodes={[grouped]} onSelect={() => {}} /></I18nProvider>);
  const button=screen.getByRole("button", {name:"Features"});
  fireEvent.mouseEnter(button);
  await waitFor(() => expect(button.querySelector(".neural-help:not(.neural-help-reserved)")?.textContent).toBe("Choose optional capabilities"));
  expect(view.container.querySelectorAll(".neural-blob")).toHaveLength(1);
  expect([...document.querySelectorAll(".neural-help:not(.neural-help-reserved)")].every(help => button.contains(help))).toBe(true);
});

test("touch discloses help on the first pointer interaction without delaying selection", async () => {
  const select = vi.fn();
  render(<I18nProvider><NeuralGraph nodes={[grouped]} onSelect={select} /></I18nProvider>);
  const button = screen.getByRole("button", { name: "Forge" });
  const touch = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(touch, "pointerType", { value: "touch" });
  fireEvent(button, touch);
  await waitFor(() => expect(document.querySelector(".neural-help:not(.neural-help-reserved)")?.textContent).toBe("Build prompts"));
  fireEvent.click(button);
  expect(select.mock.calls).toEqual([["setup:features:forge"]]);
});

test("detected flags and suggested companion labels are translated without selecting suggestions", () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  const select=vi.fn();
  const view=render(<I18nProvider><NeuralGraph nodes={[{...grouped,choices:grouped.choices!.map(choice=>({...choice,detected:choice.id.endsWith('director')}))}]} onSelect={select} /></I18nProvider>);
  expect(screen.getByRole('button',{name:'Director'}).querySelector('[data-flag="detected"]')?.textContent).toBe('Detected');
  expect(screen.getByRole('button',{name:'Forge'}).querySelector('[data-flag="suggested"]')?.textContent).toBe('Suggested');
  expect(screen.getByRole('button',{name:'Forge'}).getAttribute('aria-pressed')).toBe('false');
  expect(select).not.toHaveBeenCalled();
  expect(view.container.querySelector(".neural-road-label, .neural-legend")).toBeNull();
});

test("metadata slots remain in flow when selection removes a suggestion badge", () => {
  const view = render(<I18nProvider><NeuralGraph nodes={[grouped]} onSelect={() => {}} /></I18nProvider>);
  const button = screen.getByRole("button", {name:"Forge"});
  const flags = button.querySelector(".neural-flags")!;
  const slots = [...flags.children];
  expect(slots).toHaveLength(2);
  view.rerender(<I18nProvider><NeuralGraph nodes={[{...grouped, choices:grouped.choices!.map(choice => ({...choice, selected:true}))}]} onSelect={() => {}} /></I18nProvider>);
  expect(button.querySelector(".neural-flags")).toBe(flags);
  expect([...flags.children]).toEqual(slots);
  expect(flags.querySelector('[data-flag="suggested"]')).toBeNull();
  expect(slots.every(slot => slot.classList.contains("neural-flag-reserved") && slot.getAttribute("aria-hidden") === "true")).toBe(true);
});

test("internal suggestions measure option bounds, preserve selection and disappear when target selected", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const y = this.dataset.choice?.endsWith("forge") ? 110 : 60;
    return { x: 20, y, left: 20, top: y, right: 300, bottom: y + 40, width: 280, height: this.dataset.node ? 240 : 40, toJSON: () => ({}) };
  });
  const select = vi.fn();
  const view = render(<I18nProvider><NeuralGraph nodes={[grouped]} onSelect={select} motion="paws" /></I18nProvider>);
  const road = view.container.querySelector('[data-edge="setup:features:director->setup:features:forge"]');
  expect(road).toBeNull();
  expect(view.container.querySelector("animateMotion, .neural-road-light, .neural-legend")).toBeNull();
  expect(screen.getByRole("button", { name: "Forge" }).getAttribute("aria-pressed")).toBe("false");
  expect(select).not.toHaveBeenCalled();
  view.rerender(<I18nProvider><NeuralGraph nodes={[{ ...grouped, choices: grouped.choices!.map(choice => ({ ...choice, selected: true })) }]} onSelect={select} /></I18nProvider>);
  expect(view.container.querySelector(".neural-road.suggested")).toBeNull();
});

test("included features are reusable passive microbubbles on blobs and choices, never extra selections", () => {
  const included = [{id:"part:a", label:"Part A"}, {id:"part:b", label:"Part B"}];
  const select = vi.fn();
  const view = render(<I18nProvider><NeuralGraph nodes={[
    {...nodes[0], included},
    {...grouped, included, choices:[{id:"custom:choice", label:"Custom choice", included}]},
  ]} onSelect={select} /></I18nProvider>);
  const clusters = view.container.querySelectorAll(".neural-included-features");
  expect(clusters).toHaveLength(3);
  expect(view.container.querySelectorAll("[data-node]")).toHaveLength(2);
  expect(view.container.querySelectorAll("[data-choice]")).toHaveLength(1);
  for (const cluster of clusters) {
    expect(cluster.querySelectorAll("[data-included]")).toHaveLength(2);
    expect([...cluster.querySelectorAll("[data-included-feature]")].map(part=>part.getAttribute("data-included-feature"))).toEqual(["part:a", "part:b"]);
    expect(cluster.closest("button")).toBeNull();
    expect(cluster.querySelector("button, [tabindex], [role=button]")).toBeNull();
    fireEvent.click(cluster.querySelector('[data-included="part:a"]')!);
    fireEvent.pointerDown(cluster.querySelector('[data-included="part:b"]')!);
  }
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name:"Custom choice"}));
  expect(select.mock.calls).toEqual([["custom:choice"]]);
});

test("all archived decisions remain returnable under original IDs and outside active roads", () => {
  const select = vi.fn();
  const history = Array.from({ length: 6 }, (_, index) => ({ ...nodes[0], id: `previous:${index}`, label: `Previous ${index}` }));
  const view = render(<I18nProvider><NeuralGraph nodes={[nodes[0]]} history={history} onSelect={select} /></I18nProvider>);
  expect(view.container.querySelectorAll(".neural-history [data-node]")).toHaveLength(6);
  expect(view.container.querySelectorAll(".neural-graph [data-node]")).toHaveLength(1);
  for (const previous of history) fireEvent.click(screen.getByRole("button", { name: previous.label }));
  expect(select.mock.calls).toEqual(history.map(previous => [previous.id]));
});

test("snake packing starts with logical order, keeps seven small nodes in two desktop rows and adapts to mobile", () => {
  const features = Array.from({ length: 7 }, (_, index) => ({ ...nodes[0], id: `feature:${index}`, column: index }));
  expect(neuralSnakeRows(features, 1000).map(row => row.length)).toEqual([4, 3]);
  expect(neuralSnakeRows(features, 280).map(row => row.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  expect(neuralSnakeRows([grouped], 280)[0][0].id).toBe("setup:features");
  const view = render(<I18nProvider><NeuralGraph nodes={features} onSelect={() => {}} /></I18nProvider>);
  expect(view.container.querySelector(".neural-row.is-reversed")).toBeTruthy();
  expect(view.container.querySelector(".is-long-path")).toBeNull();
});

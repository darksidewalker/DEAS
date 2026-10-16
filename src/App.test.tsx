import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "./App";
import { I18nProvider, LOCALE_STORAGE_KEY } from "./i18n/I18nProvider";
import { inspectBackend } from "./lib/comfy";
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { NativeInstallRequest } from './lib/setup';
vi.mock("./lib/comfy", () => ({ inspectBackend: vi.fn() }));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>false)}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));

function renderStudio() {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  const view = render(<I18nProvider><App /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: /Explore studio without installing/i }));
  fireEvent.click(screen.getByRole("tab", { name: "Workspace map" }));
  return view;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.resetAllMocks();
});

test("language selection updates app, setup, studio metadata and aria without losing local state", () => {
  renderStudio();
  fireEvent.click(screen.getByRole("button", { name: /^Director$/i }));
  fireEvent.change(screen.getByLabelText("Shot direction"), { target: { value: "Preserve my draft" } });
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "de" } });
  expect(document.documentElement.lang).toBe("de");
  expect(screen.getByRole("tab", { name: /AiO-Installer/ })).toBeTruthy();
  expect(screen.getByLabelText("Aufnahmeregie")).toHaveProperty("value", "Preserve my draft");
  expect(screen.getByRole("button", { name: "Director schließen" })).toBeTruthy();
  expect(document.querySelector(".neural-legend")).toBeNull();
  expect([...document.querySelectorAll('[data-node="director"] [data-included]')].map(part=>part.textContent)).toEqual(["Prompt Forge", "RefMods", "Kontinuität", "Ausgabe"]);
  expect(screen.getByLabelText("Bildausschnitt").textContent).toContain("Totale");
  fireEvent.change(screen.getByLabelText("Sprache"), { target: { value: "en" } });
  expect(screen.getByLabelText("Shot direction")).toHaveProperty("value", "Preserve my draft");
  expect(screen.getByLabelText("Framing")).toHaveProperty("value", "wide");
});

test("first entry shows only AiO and keeps the studio behind an honest preview control", () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  const view = render(<I18nProvider><App /></I18nProvider>);
  expect([...view.container.querySelectorAll("[data-node]")].map(n=>n.getAttribute("data-node"))).toEqual(["setup:aio","provider-auth","optional-downloads"]);
  expect(screen.queryByRole("group", { name: "Connected studio features" })).toBeNull();
  expect(inspectBackend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Explore studio without installing/ }));
  expect(screen.getByRole("tab", { name: "Video", selected: true })).toBeTruthy();
  expect(screen.getByRole("complementary", { name: "Media" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Connected studio features" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Workspace map" }));
  expect(screen.getByRole("group", { name: "Connected studio features" })).toBeTruthy();
  expect(inspectBackend).not.toHaveBeenCalled();
});

test.each([false,true])("successful native install reveals studio without an extra enable action (Director: %s)", async (director) => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='native_install_defaults')return {storagePath:'/app/new',backend:'cpu',warnings:[]};
    if(command==='native_media_list')return {path:'/home/fixture',parent:null,entries:[],truncated:false};
    if(command==='native_install_plan')return {id:'installed-plan',request:(args as {request:NativeInstallRequest}).request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
    return {state:'succeeded',stepId:null,logs:[],error:null};
  });
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  render(<I18nProvider><App /></I18nProvider>);
  fireEvent.click(screen.getByRole('tab',{name:'AiO installer'}));
  if(!director)fireEvent.click(screen.getByLabelText('Director'));
  await waitFor(()=>expect(screen.getByLabelText('Storage directory')).toHaveProperty('value','/app/new'));
  const start=await screen.findByRole('button',{name:'Start install'});
  expect(screen.queryByRole('tablist',{name:'Studio areas'})).toBeNull();
  fireEvent.click(start);
  expect(await screen.findByRole('complementary',{name:'Media'})).toBeTruthy();
  fireEvent.click(screen.getByRole('tab',{name:'Workspace map'}));
  expect(screen.getByRole('group',{name:'Connected studio features'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Director'}));
  expect(screen.getByLabelText('Shot direction')).toBeTruthy();
  expect(inspectBackend).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:/generate/i})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['native_install_defaults','native_install_plan','native_install_start','native_media_list']);
});

test("existing setup handoff reveals Engine and prefills its endpoint without inspection", () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  render(<I18nProvider><App /></I18nProvider>);
  fireEvent.click(screen.getByRole("tab", { name: /AiO installer/ }));
  fireEvent.change(screen.getByLabelText("Existing backend address"), { target: { value: "http://127.0.0.1:8188" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect existing backend" }));
  expect(screen.getByRole("button", { name: /^Engine$/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText("Backend URL")).toHaveProperty("value", "http://127.0.0.1:8188");
  expect(document.activeElement).toBe(screen.getByLabelText("Backend URL"));
  expect(inspectBackend).not.toHaveBeenCalled();
});

test("a setup handoff discards an in-flight snapshot from the previous address", async () => {
  let complete!: (result: Awaited<ReturnType<typeof inspectBackend>>) => void;
  vi.mocked(inspectBackend).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  renderStudio();
  fireEvent.click(screen.getByRole("button", { name: /^Engine$/ }));
  fireEvent.click(screen.getByRole("button", { name: /Inspect connection/ }));
  const setup = within(screen.getByRole("region", { name: "AiO setup planner" }));
  fireEvent.click(setup.getByRole("tab", { name: /AiO installer/ }));
  fireEvent.change(setup.getByLabelText("Existing backend address"), { target: { value: "http://127.0.0.1:8188" } });
  fireEvent.click(setup.getByRole("button", { name: "Inspect existing backend" }));
  await act(async () => complete({ baseUrl: "http://127.0.0.1:7801", nodeCount: 1, devices: ["Stale GPU"], missingRequiredNodes: [], capabilities: [] }));
  expect(screen.getByLabelText("Backend URL")).toHaveProperty("value", "http://127.0.0.1:8188");
  expect(screen.queryByText("Stale GPU")).toBeNull();
  expect(inspectBackend).toHaveBeenCalledTimes(1);
});

test("Director owns passive included parts instead of duplicate interactive studio nodes", () => {
  const view = renderStudio();
  const studio = view.container.querySelector(".neural-field")!;
  expect([...studio.querySelectorAll("[data-node]")].map(node=>node.getAttribute("data-node"))).toEqual(["engine", "director", "plugins"]);
  const director=studio.querySelector('[data-node="director"]')!;
  expect([...director.querySelectorAll("[data-included]")].map(part=>part.getAttribute("data-included"))).toEqual(["forge", "refmods", "continuity", "output"]);
  expect(studio.querySelectorAll("button")).toHaveLength(3);
  expect(studio.querySelector("[data-choice], .neural-legend, [data-kind=suggested]")).toBeNull();
  for(const part of director.querySelectorAll("[data-included]")) fireEvent.click(part);
  expect(view.container.querySelector("[id^='panel-']")).toBeNull();
  const trigger=screen.getByRole("button",{name:"Director"});
  fireEvent.click(trigger);
  fireEvent.change(screen.getByLabelText("Shot direction"),{target:{value:"Keep included direction"}});
  fireEvent.keyDown(view.container.querySelector(".panel-director")!, {key:"Escape"});
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(screen.getByLabelText("Shot direction")).toHaveProperty("value", "Keep included direction");
  expect(inspectBackend).not.toHaveBeenCalled();
});

test("feature nodes expand inline without making automatic backend requests", () => {
  renderStudio();
  const engine = screen.getByRole("button", {
    name: /^Engine$/i,
  });
  expect(engine.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(engine);
  expect(engine.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText("Backend URL")).toHaveProperty(
    "value",
    "http://127.0.0.1:7801",
  );
  expect(inspectBackend).not.toHaveBeenCalled();
});

test("explicit inspection displays real snapshot details and capability gaps", async () => {
  vi.mocked(inspectBackend).mockResolvedValue({
    baseUrl: "http://127.0.0.1:7801",
    nodeCount: 127,
    devices: ["Test GPU"],
    missingRequiredNodes: ["MiniMaxH3Director"],
    capabilities: ["supports_preview_metadata"],
  });
  renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Engine$/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Inspect connection/ }));
  await waitFor(() =>
    expect(inspectBackend).toHaveBeenCalledWith("http://127.0.0.1:7801"),
  );
  expect(await screen.findByText("Test GPU")).toBeTruthy();
  expect(screen.getByText("MiniMaxH3Director")).toBeTruthy();
  expect(screen.getByText("127")).toBeTruthy();
  expect(screen.getByText("supports_preview_metadata")).toBeTruthy();
});

test("Director saves only a local draft and restores it on reload", () => {
  const view = renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Director$/i }),
  );
  fireEvent.change(screen.getByLabelText("Shot direction"), {
    target: { value: "Slow tracking shot through a copper-lit forest." },
  });
  fireEvent.click(within(document.querySelector(".panel-director") as HTMLElement).getByRole("button", { name: "Save local draft" }));
  expect(screen.getByText(/Draft saved on this device/)).toBeTruthy();
  expect(inspectBackend).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  view.unmount();
  renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Director$/i }),
  );
  expect(screen.getByLabelText("Shot direction")).toHaveProperty(
    "value",
    "Slow tracking shot through a copper-lit forest.",
  );
});

test("Plugins describes trusted bundled metadata without pretending to install extensions", () => {
  renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Plugins$/i }),
  );
  expect(screen.getByText("Trusted, bundled metadata")).toBeTruthy();
  expect(
    screen.getByText("MiniMax H3 direction and guide capabilities."),
  ).toBeTruthy();
  expect(document.querySelector(".panel-plugins")?.querySelector(".action-button")).toBeNull();
});

test("closing an inline panel returns keyboard focus to its node", () => {
  renderStudio();
  const engine = screen.getByRole("button", {
    name: /^Engine$/i,
  });
  fireEvent.click(engine);
  const close = screen.getByRole("button", { name: "Close Engine" });
  close.focus();
  fireEvent.click(close);
  expect(document.activeElement).toBe(engine);
  expect(engine.getAttribute("aria-expanded")).toBe("false");
});

test("failed inspection shows actionable error instead of a connected state", async () => {
  vi.mocked(inspectBackend).mockRejectedValue(
    new Error("Backend unavailable. Check your URL and CORS settings."),
  );
  renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Engine$/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Inspect connection/ }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Check your URL and CORS settings",
  );
  expect(screen.queryByText(/Inspection complete/)).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Inspect connection/ })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("editing the URL clears snapshot data from the previous backend", async () => {
  vi.mocked(inspectBackend).mockResolvedValue({
    baseUrl: "http://127.0.0.1:7801",
    nodeCount: 12,
    devices: ["Previous GPU"],
    missingRequiredNodes: [],
    capabilities: [],
  });
  renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Engine$/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Inspect connection/ }));
  expect(await screen.findByText("Previous GPU")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Backend URL"), {
    target: { value: "http://127.0.0.1:8188" },
  });
  expect(screen.queryByText("Previous GPU")).toBeNull();
  expect(inspectBackend).toHaveBeenCalledTimes(1);
});

test("invalid local draft data does not break the workspace", () => {
  window.localStorage.setItem("deas.director-draft.v1", "{bad-json");
  renderStudio();
  fireEvent.click(
    screen.getByRole("button", { name: /^Director$/i }),
  );
  expect(screen.getByLabelText("Shot direction")).toHaveProperty("value", "");
});

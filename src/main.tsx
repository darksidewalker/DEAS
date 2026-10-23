import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n/I18nProvider";
import App from "./App";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-800.css";
import "./styles.css";
import "./themes.css";
import { applySavedScheme } from "./lib/theme";

applySavedScheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider><App /></I18nProvider>
  </React.StrictMode>,
);

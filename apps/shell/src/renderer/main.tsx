import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { FilmstripWindow } from "./components/FilmstripWindow";
import { initFilmstripClient, isFilmstripWindow } from "./filmstripSync";
import "./styles.css";

// The same bundle serves the main window and the torn-off filmstrip window
// (loaded with #filmstrip by main.ts); the latter renders only the grid.
const filmstripOnly = isFilmstripWindow();
if (filmstripOnly) initFilmstripClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{filmstripOnly ? <FilmstripWindow /> : <App />}</React.StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SidebarApp } from "./ui/SidebarApp";
import "./ui/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidebarApp />
  </StrictMode>,
);

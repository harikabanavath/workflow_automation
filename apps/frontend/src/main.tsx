import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">WORKFLOW AUTOMATION</p>
        <h1>Build calm, auditable workflows.</h1>
        <p className="lede">Design approval flows, launch submissions, and keep every decision traceable.</p>
        <div className="actions">
          <button>Create workflow</button>
          <a href="http://localhost:8000/docs">Open API docs ↗</a>
        </div>
      </section>
      <section className="cards">
        <article><span>01</span><h2>Templates</h2><p>Versioned JSON definitions keep published workflows reproducible.</p></article>
        <article><span>02</span><h2>Runs</h2><p>Track each submission and its step-by-step execution state.</p></article>
        <article><span>03</span><h2>Audit</h2><p>Capture decisions and changes in one append-only event stream.</p></article>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

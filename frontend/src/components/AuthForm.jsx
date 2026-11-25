import { useState } from "react";
import { login, register } from "../api/client.js";

export default function AuthForm({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const signingUp = mode === "register";
  const canSubmit = email.trim() !== "" && password.length >= 8 && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const data = await (signingUp ? register : login)(email.trim(), password);
      onAuthenticated(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>SysDesign AI</h1>
        <p>Log in to generate architectures and save your projects.</p>
      </header>
      <section className="panel" style={{ maxWidth: 420, margin: "0 auto" }} aria-labelledby="auth-title">
        <h2 id="auth-title">{signingUp ? "Create an account" : "Log in"}</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              value={password}
              autoComplete={signingUp ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
            />
            {signingUp && <span className="hint">At least 8 characters.</span>}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="perf-actions">
            <button type="submit" disabled={!canSubmit}>
              {busy ? "Please wait…" : signingUp ? "Create account" : "Log in"}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode(signingUp ? "login" : "register");
                setError("");
              }}
            >
              {signingUp ? "I already have an account" : "Create an account"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

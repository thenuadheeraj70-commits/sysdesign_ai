import { useRef, useState } from "react";
import { importDocument, sendFeedback } from "../../api/client.js";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ".txt,.md,.markdown,.pdf,.png,.jpg,.jpeg,.webp,.gif,text/plain,application/pdf,image/*";

/** The file's bytes as base64, without loading it as one giant string of characters. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Fill the requirements box from a text file, a PDF, or a picture of a diagram. */
export function ImportDocument({ onText, disabled }) {
  const input = useRef(null);
  const [state, setState] = useState({ loading: false, message: "", error: "" });

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allows choosing the same file again
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setState({ loading: false, message: "", error: "That file is larger than 5 MB." });
      return;
    }
    setState({ loading: true, message: "", error: "" });
    try {
      const result = await importDocument(
        file.name,
        file.type || "application/octet-stream",
        toBase64(await file.arrayBuffer())
      );
      onText(result.text);
      const where = {
        file: "Text read from the file.",
        ai: "Written by AI from your file.",
        demo: "Sample text (demo mode).",
      }[result.source];
      setState({ loading: false, message: [where, result.note].filter(Boolean).join(" "), error: "" });
    } catch (err) {
      setState({ loading: false, message: "", error: err.message });
    }
  }

  return (
    <div className="import-doc">
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        onChange={onFile}
        hidden
        aria-label="Choose a file to import"
      />
      <button
        type="button"
        className="secondary"
        onClick={() => input.current?.click()}
        disabled={disabled || state.loading}
      >
        {state.loading ? "Reading…" : "Import a file"}
      </button>
      <span className="hint"> Text, PDF, or a picture of a diagram.</span>
      <span className="hint" role="status" aria-live="polite">
        {" "}
        {state.message}
      </span>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

/** Thumbs up or down, with an optional comment, on the design the last prompt produced. */
export function GenerationFeedback({ prompt, projectName, cached }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState("");

  async function send(value) {
    setRating(value);
    setStatus("Sending…");
    try {
      await sendFeedback(prompt, projectName, value, comment);
      setStatus("Thanks, saved.");
    } catch (err) {
      setStatus(err.message);
    }
  }

  return (
    <div className="feedback" role="group" aria-label="Was this design helpful?">
      <span>Was this design helpful?</span>
      <button
        type="button"
        className={`secondary${rating === 1 ? " active" : ""}`}
        aria-pressed={rating === 1}
        onClick={() => send(1)}
        aria-label="Helpful"
      >
        👍
      </button>
      <button
        type="button"
        className={`secondary${rating === -1 ? " active" : ""}`}
        aria-pressed={rating === -1}
        onClick={() => send(-1)}
        aria-label="Not helpful"
      >
        👎
      </button>
      <input
        aria-label="Comment (optional)"
        placeholder="Comment (optional)"
        maxLength={1000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onBlur={() => rating && send(rating)}
      />
      {cached && <span className="badge">cached result</span>}
      <span className="hint" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

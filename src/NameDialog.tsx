import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { composing } from "./keys";

type Props = {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  submit: string;
  /** Offered while typing, e.g. existing folders. */
  suggestions?: string[];
  /** Whether an empty value can be submitted (e.g. the vault root as a folder). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
};

/** A one-field dialog. The webview has no `window.prompt`, so marq asks for names with this. */
export function NameDialog({ title, label, initial = "", placeholder, hint, submit, suggestions, allowEmpty, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Leave a folder prefix such as `notes/` in place and put the cursor after it.
    el.setSelectionRange(initial.length, initial.length);
  }, [initial]);

  const ok = async () => {
    if ((!value.trim() && !allowEmpty) || busy) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <label className="field-label">{label}</label>
        <input
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          list={suggestions ? "name-dialog-suggestions" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !composing(e)) ok();
            if (e.key === "Escape") onClose();
          }}
        />
        {suggestions && <datalist id="name-dialog-suggestions">{suggestions.map((x) => <option key={x} value={x} />)}</datalist>}
        {hint && <p className="muted small">{hint}</p>}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="primary" onClick={ok} disabled={(!value.trim() && !allowEmpty) || busy}>{submit}</button>
        </div>
      </div>
    </div>
  );
}

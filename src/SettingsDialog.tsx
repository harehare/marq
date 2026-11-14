import { useEffect, useState } from "react";
import { Bell, Bot, Cpu, FileCog, Plus, Trash2, Palette, PanelTop, PenLine, RotateCcw, Settings as SettingsIcon, SquareTerminal, X } from "lucide-react";
import type { ComponentType } from "react";
import { api, type AgentInfo } from "./api";
import { composing } from "./keys";

type Field = {
  /** `section.key` in config.toml. */
  key: string;
  label: string;
  kind: "text" | "number" | "select" | "bool" | "list";
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** One line under the label saying what the setting does. */
  desc?: string;
};

type Section = {
  id: string;
  title: string;
  icon: ComponentType<{ size?: number }>;
  /** When changes take effect, if not right away. */
  note?: string;
  fields: Field[];
  /** The pane is the agents editor rather than a list of fields. */
  agents?: boolean;
};

const SECTIONS: Section[] = [
  {
    id: "appearance", title: "Appearance", icon: Palette,
    note: "Palette and light/dark are picked in the 🎨 menu.",
    fields: [
      { key: "appearance.font", label: "UI font", kind: "text", placeholder: "System", desc: "Menus, sidebar and notes" },
      { key: "appearance.mono_font", label: "Monospace font", kind: "text", placeholder: "ui-monospace", desc: "Editor and code. Also the terminal unless it has its own font" },
      { key: "appearance.font_size", label: "UI font size", kind: "number", placeholder: "13", desc: "In px" },
      { key: "appearance.editor_font_size", label: "Editor font size", kind: "number", placeholder: "14", desc: "In px" },
      {
        key: "appearance.content_width", label: "Content width", kind: "select", desc: "How wide notes and conversations are",
        options: [{ value: "", label: "Wide (default)" }, { value: "normal", label: "Normal" }, { value: "full", label: "Full width" }],
      },
    ],
  },
  {
    id: "editor", title: "Editor", icon: PenLine,
    fields: [
      {
        key: "editor.default_mode", label: "Open notes in", kind: "select", desc: "New notes always open in edit",
        options: [{ value: "", label: "Preview (default)" }, { value: "edit", label: "Edit" }, { value: "split", label: "Split" }],
      },
      { key: "editor.autosave", label: "Auto-save", kind: "bool", desc: "Save notes automatically while you type" },
      { key: "editor.vim", label: "Vim keys", kind: "bool", desc: "Modal editing in notes, with :w to save" },
    ],
  },
  {
    id: "tabs", title: "Tabs", icon: PanelTop,
    fields: [
      {
        key: "tabs.pinned_layout", label: "Pinned tabs", kind: "select", desc: "Pin a tab from its right-click menu",
        options: [{ value: "", label: "First in the tab bar (default)" }, { value: "row", label: "In a row above the others" }],
      },
      {
        key: "tabs.overflow", label: "When tabs do not fit", kind: "select",
        options: [{ value: "", label: "Scroll, with a count of tabs out of sight (default)" }, { value: "wrap", label: "Wrap onto more rows" }],
      },
    ],
  },
  {
    id: "terminal", title: "Terminal", icon: SquareTerminal,
    note: "Applies to terminals opened after saving.",
    fields: [
      { key: "terminal.shell", label: "Shell", kind: "text", placeholder: "$SHELL", desc: "Program to run. Defaults to your login shell" },
      { key: "terminal.args", label: "Arguments", kind: "list", placeholder: "-l", desc: "Separated by spaces" },
      { key: "terminal.font", label: "Font", kind: "text", placeholder: "Monospace font", desc: "Defaults to the monospace font" },
      { key: "terminal.font_size", label: "Font size", kind: "number", placeholder: "13", desc: "In px" },
      { key: "terminal.ligatures", label: "Ligatures", kind: "bool", desc: "Draw -> != |> … as ligatures, with fonts that have them. Off draws with the GPU, which is much faster on heavy output" },
      {
        key: "terminal.cursor", label: "Cursor", kind: "select",
        options: [{ value: "", label: "Block (default)" }, { value: "bar", label: "Bar" }, { value: "underline", label: "Underline" }],
      },
    ],
  },
  {
    id: "notifications", title: "Notifications", icon: Bell,
    fields: [
      { key: "notifications.enabled", label: "Session notifications", kind: "bool", desc: "Notify when a session finishes, fails or needs an approval" },
    ],
  },
  {
    id: "agents", title: "Agents", icon: Bot, agents: true, fields: [],
    note: "Agents other than Claude talk ACP. Changes apply the next time you start a task.",
  },
  {
    id: "ollama", title: "Ollama", icon: Cpu,
    note: "Applies after restarting Marq.",
    fields: [{ key: "ollama.url", label: "URL", kind: "text", placeholder: "http://127.0.0.1:11434", desc: "Defaults to $OLLAMA_HOST, then this address" }],
  },
];

const FIELDS = SECTIONS.flatMap((s) => s.fields);

type Values = Record<string, string | boolean>;

/** An agent in the Agents pane. Built-in agents can change their command; others are added here. */
type AgentRow = {
  id: string; label: string; command: string; args: string;
  builtin: boolean; defCommand: string; defArgs: string; installed: boolean;
  /** Added in this dialog and not saved yet: its id can still be typed. */
  fresh?: boolean;
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const rowOf = (a: AgentInfo): AgentRow => ({
  id: a.id, label: a.label, command: a.command, args: a.args.join(" "),
  builtin: a.builtin, defCommand: a.default_command, defArgs: a.default_args.join(" "), installed: a.installed,
});

const sameRow = (a: AgentRow | undefined, b: AgentRow) =>
  !!a && a.label === b.label && a.command === b.command && a.args === b.args;

const isDefaultRow = (r: AgentRow) => r.builtin && r.command === r.defCommand && r.args === r.defArgs;

/** A row added with Add agent and left empty is ignored. */
const blank = (r: AgentRow) => !!r.fresh && !r.id && !r.command.trim() && !r.args.trim() && !r.label.trim();

/** Why a row cannot be saved, if it cannot. */
function agentProblem(r: AgentRow, all: AgentRow[]): string | null {
  if (!ID_RE.test(r.id)) return "The id needs letters, digits, - or _";
  if (all.filter((o) => o.id === r.id).length > 1) return "Another agent has this id";
  if (!r.command.trim()) return "Enter the command to run";
  return null;
}

/** The `agents.<id>` changes that take the file from `initial` to `rows`; null removes an entry. */
function agentChanges(initial: AgentRow[], rows: AgentRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const args = (r: AgentRow) => r.args.trim().split(/\s+/).filter(Boolean);
  for (const r of rows.filter((r) => !blank(r))) {
    if (sameRow(initial.find((i) => i.id === r.id), r)) continue;
    if (isDefaultRow(r)) out[`agents.${r.id}`] = null;
    else if (r.builtin) out[`agents.${r.id}`] = { command: r.command.trim(), args: args(r) };
    else out[`agents.${r.id}`] = { ...(r.label.trim() && r.label.trim() !== r.id ? { label: r.label.trim() } : {}), command: r.command.trim(), args: args(r) };
  }
  for (const i of initial) if (!i.builtin && !rows.some((r) => r.id === i.id)) out[`agents.${i.id}`] = null;
  return out;
}

/** What the form shows when the key is absent from config.toml. */
const defaultOf = (f: Field): string | boolean => (f.kind === "bool" ? true : "");

/** A field's value in the form: strings for inputs, booleans for checkboxes. */
function fromConfig(c: Record<string, unknown>, f: Field): string | boolean {
  const [section, name] = f.key.split(".");
  const v = (c[section] as Record<string, unknown> | undefined)?.[name];
  if (f.kind === "bool") return v !== false;
  if (Array.isArray(v)) return v.join(" ");
  return v == null ? "" : String(v);
}

/** The form value as TOML-bound JSON; null removes the key so the default applies. */
function toConfig(f: Field, v: string | boolean): unknown {
  if (f.kind === "bool") return v;
  const s = String(v).trim();
  if (!s) return null;
  if (f.kind === "number") return Number(s);
  if (f.kind === "list") return s.split(/\s+/);
  return s;
}

/** Edits ~/.marq/config.toml. Key bindings stay in the file. */
export function SettingsDialog({ onSaved, onOpenFile, onClose }: {
  onSaved: () => void;
  onOpenFile: () => void;
  onClose: () => void;
}) {
  const [initial, setInitial] = useState<Values | null>(null);
  const [values, setValues] = useState<Values>({});
  const [shells, setShells] = useState<string[]>([]);
  const [agentsInitial, setAgentsInitial] = useState<AgentRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(SECTIONS[0].id);

  useEffect(() => {
    api.readConfig().then((c) => {
      const v = Object.fromEntries(FIELDS.map((f) => [f.key, fromConfig(c, f)]));
      setInitial(v);
      setValues(v);
    }, (e) => setError(String(e)));
    api.shells().then(setShells, () => {});
    api.listAgents().then((list) => {
      const rows = list.map(rowOf);
      setAgentsInitial(rows);
      setAgents(rows);
    }, () => {});
  }, []);

  const agentEdits = agentChanges(agentsInitial, agents);
  const agentEditCount = Object.keys(agentEdits).length;
  const agentInvalid = agents.some((r) => !blank(r) && agentProblem(r, agents));
  const invalid = agentInvalid || FIELDS.find((f) => f.kind === "number" && String(values[f.key] ?? "").trim() && !(Number(values[f.key]) > 0));
  const changed = initial ? FIELDS.filter((f) => values[f.key] !== initial[f.key]) : [];

  const save = async () => {
    if (busy || invalid || !changed.length && !agentEditCount) return;
    setBusy(true);
    try {
      await api.writeConfig({
        ...Object.fromEntries(changed.map((f) => [f.key, toConfig(f, values[f.key])])),
        ...agentEdits,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const set = (key: string, v: string | boolean) => setValues((prev) => ({ ...prev, [key]: v }));
  const section = SECTIONS.find((s) => s.id === tab)!;
  const changedIn = (s: Section) => s.agents ? agentEditCount : s.fields.filter((f) => changed.includes(f)).length;
  const totalChanged = changed.length + agentEditCount;
  const setAgent = (n: number, patch: Partial<AgentRow>) =>
    setAgents((rows) => rows.map((r, i) => (i === n ? { ...r, ...patch } : r)));
  const addAgent = () =>
    setAgents((rows) => [...rows, { id: "", label: "", command: "", args: "", builtin: false, defCommand: "", defArgs: "", installed: false, fresh: true }]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && e.metaKey && !composing(e)) save();
      }}>
        <div className="modal-head">
          <h3><SettingsIcon size={15} /> Settings</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        {initial && (
          <div className="settings-layout">
            <nav className="settings-nav">
              {SECTIONS.map((s) => {
                const n = changedIn(s);
                return (
                  <button key={s.id} className={s.id === tab ? "on" : undefined} onClick={() => setTab(s.id)}>
                    <s.icon size={14} />
                    <span>{s.title}</span>
                    {n > 0 && <span className="settings-dot" title={`${n} unsaved`} />}
                  </button>
                );
              })}
            </nav>
            <div className="settings-body">
              <div className="settings-pane-head">
                <h4>{section.title}</h4>
                {section.note && <span className="muted small">{section.note}</span>}
              </div>
              {section.agents && (
                <>
                  {agents.map((r, n) => {
                    const problem = blank(r) ? null : agentProblem(r, agents);
                    return (
                      <div key={r.builtin ? r.id : `custom-${n}`} className="agent-row">
                        <div className="agent-head">
                          {r.builtin ? (
                            <span className="settings-name">
                              {r.label}
                              {!sameRow(agentsInitial.find((i) => i.id === r.id), r) && <span className="settings-dot" title="Unsaved change" />}
                            </span>
                          ) : (
                            <>
                              <input
                                className={problem ? "invalid" : undefined}
                                value={r.id} placeholder="id, e.g. kimi" spellCheck={false}
                                disabled={!r.fresh}
                                onChange={(e) => setAgent(n, { id: e.target.value.trim() })}
                              />
                              <input value={r.label} placeholder="Name shown in the New task dialog" spellCheck={false} onChange={(e) => setAgent(n, { label: e.target.value })} />
                            </>
                          )}
                          {r.builtin && <span className={`muted small ${r.installed ? "" : "settings-error"}`}>{r.installed ? "installed" : "not found"}</span>}
                          <span className="agent-actions">
                            {r.builtin ? (
                              <button
                                type="button" className="icon settings-reset" title="Reset to default"
                                style={{ visibility: isDefaultRow(r) ? "hidden" : "visible" }}
                                onClick={() => setAgent(n, { command: r.defCommand, args: r.defArgs })}
                              ><RotateCcw size={13} /></button>
                            ) : (
                              <button type="button" className="icon" title="Remove agent" onClick={() => setAgents((rows) => rows.filter((_, i) => i !== n))}><Trash2 size={13} /></button>
                            )}
                          </span>
                        </div>
                        <div className="agent-fields">
                          <input value={r.command} placeholder="Command, e.g. gemini" spellCheck={false} onChange={(e) => setAgent(n, { command: e.target.value })} />
                          <input value={r.args} placeholder="Arguments, e.g. acp" spellCheck={false} onChange={(e) => setAgent(n, { args: e.target.value })} />
                        </div>
                        {problem && <span className="settings-error small">{problem}</span>}
                      </div>
                    );
                  })}
                  <div className="agent-add">
                    <button type="button" onClick={addAgent}><Plus size={14} /> Add agent</button>
                    <span className="muted small">Any agent that speaks ACP (Agent Client Protocol). Arguments are separated by spaces.</span>
                  </div>
                </>
              )}
              {section.fields.map((f) => {
                const v = values[f.key];
                const isChanged = changed.includes(f);
                const isDefault = v === defaultOf(f);
                return (
                  <label key={f.key} className="settings-row">
                    <span className="settings-label">
                      <span className="settings-name">
                        {f.label}
                        {isChanged && <span className="settings-dot" title="Unsaved change" />}
                      </span>
                      {f.desc && <span className="muted small">{f.desc}</span>}
                    </span>
                    <span className="settings-control">
                      {f.kind === "bool" ? (
                        <input type="checkbox" className="settings-switch" checked={v as boolean} onChange={(e) => set(f.key, e.target.checked)} />
                      ) : f.kind === "select" ? (
                        <select className="model-select" value={v as string} onChange={(e) => set(f.key, e.target.value)}>
                          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input
                          value={v as string}
                          placeholder={f.placeholder}
                          inputMode={f.kind === "number" ? "numeric" : undefined}
                          list={f.key === "terminal.shell" ? "settings-shells" : undefined}
                          className={invalid === f ? "invalid" : undefined}
                          spellCheck={false}
                          onChange={(e) => set(f.key, e.target.value)}
                        />
                      )}
                      <button
                        type="button" className="icon settings-reset" title="Reset to default"
                        style={{ visibility: isDefault ? "hidden" : "visible" }}
                        onClick={(e) => { e.preventDefault(); set(f.key, defaultOf(f)); }}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </span>
                    {invalid === f && <span className="settings-error small">Enter a number greater than 0</span>}
                  </label>
                );
              })}
            </div>
            <datalist id="settings-shells">{shells.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <button onClick={onOpenFile} title="Key bindings and everything else are edited in the file">
            <FileCog size={14} /> Edit config.toml
          </button>
          <span className="settings-actions">
            <span className="muted small">{totalChanged ? `${totalChanged} unsaved ${totalChanged === 1 ? "change" : "changes"}` : "⌘↵ to save"}</span>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy || !!invalid || !totalChanged}>Save</button>
          </span>
        </div>
      </div>
    </div>
  );
}

import { Component, type ReactNode } from "react";
import { AlertCircle, RotateCw } from "lucide-react";

/** Keeps an error in one tab from blanking the whole window: the tab shows it, with a retry. */
export class TabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("marq: a tab failed to render", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pane-msg">
        <p><AlertCircle size={14} /> This tab could not be shown: {error.message}</p>
        <button onClick={() => this.setState({ error: null })}><RotateCw size={13} /> Try again</button>
      </div>
    );
  }
}

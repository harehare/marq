import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// The URL as a tooltip, so where a link goes shows before clicking. Web links open in the browser (see main.tsx).
const COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} title={href} rel="noreferrer">{children}</a>,
};

/** Plain Markdown rendering for mq output and chat messages. */
export function Md({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}

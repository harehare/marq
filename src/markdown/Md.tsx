import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Plain Markdown rendering for mq output and chat messages. */
export function Md({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

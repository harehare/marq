import { StreamLanguage, type StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const KEYWORDS = new Set([
  "def", "let", "var", "if", "elif", "else", "end", "while", "until", "unless", "loop", "foreach", "include", "import",
  "module", "match", "fn", "do", "try", "catch", "as", "break", "continue", "yield",
]);
const BUILTINS = new Set(["self", "nodes"]);
const ATOMS = new Set(["true", "false", "None"]);

/** Interpolated strings (`s"...${x}..."`) are highlighted as plain strings. */
function string(stream: StringStream) {
  while (!stream.eol()) {
    const c = stream.next();
    if (c === "\\") stream.next();
    else if (c === '"') return;
  }
}

/** mq has no Lezer grammar, so a tokenizer stands in: enough to color keywords, strings, selectors and calls. */
const mq = StreamLanguage.define<null>({
  name: "mq",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^[sS]?"/)) {
      string(stream);
      return "string";
    }
    if (stream.match(/^0x[0-9a-fA-F_]+|^\d[\d_]*(\.\d+)?/)) return "number";
    // `.h1`, `.code.lang`: markdown selectors. A bare `.`, `..` or `.[` is punctuation.
    if (stream.match(/^\.[A-Za-z_][\w]*/)) return "tagName";
    if (stream.match(/^\$[A-Za-z_]\w*/)) return "variableName.special";
    if (stream.match(/^:[A-Za-z_][\w]*/)) return "atom";
    if (stream.match(/^[A-Za-z_][\w]*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return "keyword";
      if (ATOMS.has(w)) return "bool";
      if (BUILTINS.has(w)) return "variableName.special";
      // `module::name` and `name(`: calls and qualified access.
      if (stream.match(/^::/, false) || stream.match(/^\(/, false)) return "function";
      return "variableName";
    }
    if (stream.match(/^(->|\|=|\/\/=|[+\-*/%]=|==|!=|=~|!~|\?\?|<=|>=|&&|\|\||::|\.\.|[|+\-*/%=<>!@])/)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" }, closeBrackets: { brackets: ["(", "[", "{", '"'] } },
  tokenTable: {
    tagName: t.tagName,
    "variableName.special": t.special(t.variableName),
    function: t.function(t.variableName),
  },
});

export { mq };

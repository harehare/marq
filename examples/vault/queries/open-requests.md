---
type: query
glob: "requests/*.md"
agent: "Pick the most urgent of these and propose how to tackle it."
---
import "yaml"
  | let fm = yaml::yaml_parse(to_text(first(.)))
  | if (fm["status"] == "todo"): s"${fm["title"]}"

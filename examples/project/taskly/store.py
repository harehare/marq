"""Tasks kept in a JSON file."""

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Task:
    id: int
    text: str
    due: str | None = None
    done: bool = False


class Store:
    def __init__(self, path: str | Path = "tasks.json"):
        self.path = Path(path)

    def load(self) -> list[Task]:
        if not self.path.exists():
            return []
        return [Task(**t) for t in json.loads(self.path.read_text())]

    def save(self, tasks: list[Task]) -> None:
        self.path.write_text(json.dumps([asdict(t) for t in tasks], indent=2))

    def add(self, text: str, due: str | None = None) -> Task:
        tasks = self.load()
        task = Task(id=max((t.id for t in tasks), default=0) + 1, text=text, due=due)
        self.save([*tasks, task])
        return task

    def done(self, id: int) -> Task:
        tasks = self.load()
        for t in tasks:
            if t.id == id:
                t.done = True
                self.save(tasks)
                return t
        raise KeyError(f"no task {id}")

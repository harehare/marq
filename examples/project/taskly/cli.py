import argparse

from .due import parse_due
from .store import Store


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="taskly")
    sub = p.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add", help="add a task")
    add.add_argument("text")
    add.add_argument("--due", help="today, tomorrow, 'in 3 days', fri or 2026-11-20")
    sub.add_parser("list", help="list tasks")
    done = sub.add_parser("done", help="mark a task done")
    done.add_argument("id", type=int)
    args = p.parse_args(argv)

    store = Store()
    if args.cmd == "add":
        due = parse_due(args.due).isoformat() if args.due else None
        t = store.add(args.text, due)
        print(f"added {t.id}: {t.text}" + (f" (due {t.due})" if t.due else ""))
    elif args.cmd == "list":
        for t in store.load():
            print(f"{'x' if t.done else ' '} {t.id:>3}  {t.text}" + (f"  due {t.due}" if t.due else ""))
    else:
        print(f"done {store.done(args.id).id}")

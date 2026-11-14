# taskly

A tiny command-line task list, used as the sample project in Marq's demo vault.

```sh
python -m taskly add "Write the report" --due "in 3 days"
python -m taskly list
python -m taskly done 1
python -m unittest        # run the tests
```

Tasks are stored in `tasks.json` in the current directory.

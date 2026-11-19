---
type: playbook
title: Bug fix
description: Reproduce the bug, find its cause, then fix it and show the reproduction passing
---
# Bug fix

Every change must trace back to something you observed by running the code. A guard that "might help" is a guess, not a fix: leave it out. Make the smallest change the evidence supports.

## reproduce

Reproduce the bug before anything else. Run the program, or write a failing test, so that the wrong behavior shows on the same path a user takes. If it does not reproduce directly, narrow the conditions or add logging until it does. Do not fix anything yet: the only files you may add are the ones that reproduce the bug (a failing test or a script).

End your reply with the exact command that reproduces the bug, the output it printed, and the output it should print. If you could not reproduce it, say so and list what you tried.

## diagnose

Find the root cause. List the candidate causes, then rule them out one at a time with evidence from running the code (logs, a debugger, a narrower test), starting with the check that eliminates the most. Trace the symptom back to the first place the program goes wrong, not the place where it becomes visible. Do not fix anything yet, and remove any logging you added.

End your reply with the cause (file and line), the evidence that confirms it, and the causes you ruled out.

## fix

Fix the cause the diagnosis found, with the smallest change that does it. Keep the reproduction as a test when there is a cheap place for one. Then run the reproduction command again, and run the project's tests.

End your reply with what was wrong, what you changed, and the reproduction's output before and after the fix.

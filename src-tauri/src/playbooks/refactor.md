---
type: playbook
title: Refactor
description: Pin down the current behavior, then change the structure without changing it
---
# Refactor

A refactor changes structure, not behavior: what a user or a caller can observe stays the same. Prefer deleting code to adding it.

## baseline

Do not change the code yet. Find what checks the behavior of the code this task touches, and run it. Where nothing covers that behavior, add tests that pin it down as it is now, asserting what callers can observe and not the internals. Find every caller of what will change.

End your reply with the commands that check the behavior and their current result, the callers, and anything that makes the change risky.

## change

Make the change in small steps, running the baseline's commands after each one. Move every caller to the new shape and delete what is no longer used (old paths, wrappers with one caller) instead of keeping both. If a baseline check fails, the change altered behavior: fix the change, not the check.

End your reply with what changed, what you deleted, and the result of the baseline's commands.

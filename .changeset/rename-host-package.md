---
"spawntree-host": patch
---

Renamed package from `spawntree-host-server` to `spawntree-host` before its first npm publish. The shorter name fits the vocabulary the rest of the docs already use ("a federation host"), the `bin` is now `spawntree-host`, and the source directory moves to `packages/host/`. Nothing shipped under the old name, so there's no migration path to worry about — this is just picking the final name ahead of the first real publish.

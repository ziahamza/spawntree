---
"spawntree": patch
"spawntree-daemon": patch
---

Clean up the post-Go daemon follow-up work:

- fix daemon binary name resolution across Node.js and Go platform naming differences
- ship all supported native daemon binaries in the npm package and verify the packed artifact in CI
- remove the old unused TypeScript daemon implementation from the repository
- update architecture and design docs to reflect the native Go daemon and generated OpenAPI client

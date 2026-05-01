---
"spawntree-daemon": patch
---

Wire CORS + PNA into `/api/v1/storage` routes so public Studio can read
the daemon's storage status.

The route group was the only browser-facing daemon API without CORS
middleware. As a result, a Studio at `https://gitenv.dev` (or any other
allow-listed cross-origin) would fail the preflight (or, on a non-OPTIONS
GET, get a response with no `Access-Control-Allow-Origin` header — also
a browser-side CORS failure). The status surface added in #38 was
effectively unreachable from real production browsers.

Fix: apply the same per-route CORS module the catalog and sessions
routes already use (`packages/daemon/src/lib/cors.ts`, with the
gitenv.dev allow-list, PNA preflight echo, and `SPAWNTREE_*_TRUST_REMOTE`
escape hatch). Allowed methods extended to include `PUT` because the
storage admin surface uses it for `PUT /primary` — the catalog/sessions
default doesn't.

`requireLocalOrigin` IP check stays in place on the write surface
(PUT/POST/DELETE), so CORS only opens the door for `GET /` reads from
a browser. Mutations from non-loopback peers continue to return 403
`STORAGE_REMOTE_DENIED`.

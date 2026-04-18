# spawntree-host

## 0.2.0

### Minor Changes

- First public release of `spawntree-host` (originally merged as
  `spawntree-host-server` in [#14](https://github.com/ziahamza/spawntree/pull/14);
  renamed before first npm publish so the package ships under its final name).
  A SQLite-backed registry + reverse proxy that lets one web dashboard switch
  between multiple spawntree daemons running on different machines.

  - Pure Node.js server (< 500 lines, one dep: `better-sqlite3`).
  - Admin API: `GET/POST/DELETE /api/hosts`, `GET /api/hosts/:name/health`.
  - Proxies API calls to the selected host, including SSE streams.
  - HTML landing page escapes user-supplied labels and preserves query strings
    on proxied URLs.
  - Ships a `bin` (`spawntree-host`) so teams can `npm i -g` or `npx spawntree-host`
    without copying source.

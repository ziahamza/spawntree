---
"spawntree-daemon": patch
---

Close two SQL classifier bypasses on `/api/v1/catalog/query-readonly` that
became remotely exploitable when the loopback gate was lifted from that
route in #33.

1. **Writable CTE bypass**: `WITH d AS (SELECT 1) INSERT INTO repos(...) VALUES(...)`
   is a single statement starting with `WITH` but performing a write — the
   classifier accepted it. Now: when first keyword is `WITH`, scan the body
   for `INSERT/UPDATE/DELETE/REPLACE/MERGE/UPSERT` as whole words outside
   strings + comments. Reject with `READONLY_QUERY_REJECTED`. Pure-read CTEs
   continue to pass.

2. **PRAGMA classifier — switched from denylist to fail-closed allow-list**.
   The previous deny-list let writes slip through for any pragma not
   explicitly listed (e.g. `PRAGMA cache_size = 0`). A first-pass fix
   universally rejected the `=` form, but Devin's follow-on review caught
   that for stateful pragmas the function-call form is also a write —
   `PRAGMA cache_size(0)` is equivalent to `PRAGMA cache_size = 0` and
   was still reachable. The shipped fix is a strict allow-list:

   - `ALLOWED_PRAGMAS: Map<name, "bare" | "function" | "both">` enumerates
     every read-safe pragma along with the form(s) it's allowed in.
   - Pragmas not on the map → rejected.
   - `=` form → always rejected (no map entry can override).
   - `(arg)` form → only allowed for `"function"` / `"both"` entries
     (introspection pragmas like `table_info`, `index_list`, etc.).
   - bare form → only allowed for `"bare"` / `"both"` entries.

   Future SQLite pragmas are blocked by default until reviewed and added
   to the allow-list. No more "we missed one in the deny list" follow-ups.

Caught by Devin Review on PRs #34 and #36.

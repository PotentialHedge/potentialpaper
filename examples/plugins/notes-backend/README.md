# The backend of "Private notes"

The example of a plugin with its own backend (`handoffs/plugins.md` Phase 5, `/plugins.md` "Your own backend"). The
plugin, `examples/plugins/notes`, keeps each reader's notes on any page here rather than on the site. It asks the site
for an identity token (`pp.identity.token()`, permission `identity`) and sends it as `Authorization: Bearer …`
(`pp.identity.fetch`). This server checks the token and keys the notes by its `sub`.

- `verify.mjs`: checking a token with Node's own crypto (ES256 against `<site>/.well-known/jwks.json`, issuer the site's
  origin, audience the plugin's id, `exp` and `nbf`), refetching the keys when a token names one it doesn't have.
  Copy it, or use any JWT library with ES256 and JWKS.
- `server.mjs`: `GET`/`PUT /notes?page=<identifier>`, kept in a JSON file.

Develop against `npm run dev`:

    SITE=http://localhost:3000 DEV=1 node examples/plugins/notes-backend/server.mjs
    npx http-server examples/plugins/notes -p 5174 --cors

then load `http://localhost:5174/` on `/settings/plugins` ("Load from localhost"). A plugin loaded from localhost gets
tokens for `dev:potentialhedge/notes`, which `DEV=1` accepts; the published plugin's backend must not. In production,
run it at the origin the manifest's `network` names, with `SITE` the site's origin.

# Hello, the example plugin

The smallest useful PotentialPaper plugin, and the one the tests install (`tests/integration/plugins.test.ts`). It
reads its context (`pp.context`) and a setting (`greeting`), keeps a visit count in its storage (`pp.storage`), reads
the page it is on (`pp.page.read`, which needs the `page.read` permission), and offers a command (`reset`) in its
panel's menu. It needs no build: `index.html`, `main.js` and `style.css` are served as they are.

Run it against `npm run dev` from its folder, with any static server that sends CORS headers:

    npx http-server examples/plugins/hello -p 5174 --cors

then, on `/settings/plugins`, load `http://localhost:5174/` under "Load from localhost". It shows on every
kind of page: in the side column of a paper, in the main column elsewhere.

To build your own, ask your agent: "Read https://<the site>/plugins.md and build me a PotentialPaper plugin." (`/settings/plugins` shows the line with the
site's address.)

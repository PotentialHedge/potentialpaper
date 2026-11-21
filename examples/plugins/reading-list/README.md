# Reading list, the example of notes on rows

Adds to the rows of the home page's list (`contributes.rows`, which needs the `lists.read` permission). Each row's ⋯
menu has "To read / read", which marks the paper in the plugin's hidden list frame, and "Note…", which opens the
plugin's frame beside the row for a line on the paper (`"popover": true`). The row then shows the line, or "to read",
where it shows the venue (`pp.rows.set`). Everything is kept in the reader's plugin storage (`pp.storage`), so it
needs no backend. No build: the files are served as they are.

Run it against `npm run dev` from the site's repo:

    npx http-server examples/plugins/reading-list -p 5175 --cors

then, on `/settings/plugins`, load `http://localhost:5175/` under "Load from localhost", and open the home page.

# Private notes, the example of a plugin with a backend

A panel on papers, venues, categories and organisations where a signed-in reader keeps their own notes. The notes live on
the plugin's own backend (`examples/plugins/notes-backend`), which the reader's approval prompt names (`network`), not
on the site. The backend knows who the reader is from an identity token the site signs (`identity`), never from their
session. See that folder's README to run both against `npm run dev`, and `/plugins.md`, "Your own backend".

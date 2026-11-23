import { markdown } from '@/server/agent/text';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/**
 * `/agent/imports`: the import API (`server/api/imports.ts`) for the programs that bring in venues' papers, reviews,
 * versions and PDFs (the `potentialpaper-tools` repo). Not linked from the people's pages: only a bot's token calls it.
 */
export function GET() {
  const api = `${siteUrl()}/api/v1`;
  const body = `# The import API

For import tools: programs that bring a venue's papers, submissions, reviews, versions and PDFs onto PotentialPaper from their source. Each tool runs as a **bot**, an account an admin makes and grants the paths it writes:

    npm run bots:grant -- openreview 'reviews/openreview/**' --by <admin> --create
    npm run bots:token -- openreview

Send the token as \`Authorization: Bearer pp_live_…\`. Only a bot's token reaches \`${api}/imports/*\`: a person's, or a browser session, gets a 403. Every write is a commit by the bot, under the same path rules as anyone's, so it writes only what its grants cover. Each call is safe to repeat: what is already there commits nothing. A paper is named \`{ "scheme": "openreview" | "arxiv" | "doi", "value": "…" }\`.

## Papers

- \`GET ${api}/imports/papers?scheme=openreview&after=<id>&limit=500\`: the papers with an identifier of that scheme, each with its identifiers, title, abstract, venue, year and the PDF its page shows; \`next\` is the \`after\` for the next page, \`null\` at the end.
- \`POST ${api}/imports/papers\` \`{ venue: { name, year }, papers: [{ openreview, title, abstract, authors?, venue? }] }\`, at most 500: adds the papers we don't have, by OpenReview id (the bot must be granted \`reviews/openreview/**\`). Leave \`authors\` out while review is anonymous. Answers \`{ added }\`.

## Submissions and reviews

\`POST ${api}/imports/submissions\` \`{ venue: { source, id, name, url, forms, license }, submissions: [...] }\`, at most 100 a call. Each submission is \`{ externalId, paper, number, status, decision, keywords?, submittedAt?, url, notes: [{ externalId, replyTo, kind, invitation, signature, content, license, url, createdAt, modifiedAt }] }\`, written as its folder \`reviews/<source>/<id>/\`, as the source gives it now: a note left out is removed. The venue's name and \`forms\` are kept on its page (\`/v/iclr/2027\`, its \`venue.json\` and \`forms.json\`), made if missing; a venue with no page yet (a track or workshop) is refused. Its status and decision go on the version at its \`url\` (a new \`submitted\` version, dated \`submittedAt\`, if there is none), in an entry naming the venue's page, the one place a decision is kept. A submission whose paper we don't have is skipped. The bot must be granted \`reviews/<source>/**\`. Answers \`{ submissions, notes, skipped, committed, unchanged, failed }\`.

\`POST ${api}/imports/venues\` \`{ venues: [{ id: "openreview:ICLR.cc/2027/Conference", name }] }\`: makes the venue's series and edition pages (\`/v/iclr\`, \`/v/iclr/2027\`) if they aren't there, for venues of a source the bot imports. Importing submissions does this too.

## Versions and PDFs

- \`POST ${api}/imports/versions\` \`{ paper, versions: [{ label, kind, url, date?, title?, abstract?, submissions? }], relabel? }\`: folds the source's versions into the page's by address. One already there takes what the source says now and keeps what people wrote; the rest are added.
- \`POST ${api}/files\`, multipart with the PDF as \`file\`: stores it, and answers its \`url\`.
- \`POST ${api}/imports/pdfs\` \`{ paper, pdf: { url, license, source }, at: { url, label } }\`: makes the stored PDF the PDF of the version at \`at.url\` (its address, or a forum one of its submissions names), or of a new version there.

## Links

\`POST ${api}/imports/links\` \`{ paper, links: [{ label, url }] }\`, at most 12: links to the paper elsewhere, such as the code or project page its abstract names, shown under its title. One whose address the page has already is left out, a label it has already gets a number (\`Code 2\`), and a claimed paper's links are its authors', so nothing is added to one.

Writes answer \`{ head, changed }\`. Errors are \`{ error: { code, message, details? } }\`; a 429 says when to try again.
`;
  return markdown(body);
}

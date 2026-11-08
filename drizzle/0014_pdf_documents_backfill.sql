-- Covers rendered by the old scripts/render-covers.ts become the `cover` stage, version 1, of each PDF.
INSERT INTO "pdf_documents" ("sha256", "url", "cover_url", "stages", "created_at")
SELECT pc.sha256,
       coalesce(
         (SELECT c.pdf ->> 'url' FROM page_current c WHERE c.pdf ->> 'sha256' = pc.sha256 LIMIT 1),
         'https://pdfs.potentialhedge.com/pdf/' || pc.sha256 || '.pdf'
       ),
       pc.url,
       jsonb_build_object('cover', jsonb_build_object('version', 1, 'at', to_jsonb(pc.created_at))),
       pc.created_at
FROM pdf_covers pc
ON CONFLICT ("sha256") DO NOTHING;

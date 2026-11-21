ALTER TABLE "accounts" ADD COLUMN "homepage" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "orcid" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "scholar" text;--> statement-breakpoint
-- A person's page has no repo any more (`KINDS.user.repo`): its files, history, events and labeled links go. Its
-- `pages` row stays, with its short id, views and the links to it.
DELETE FROM "page_links" WHERE "page_id" IN (SELECT "id" FROM "pages" WHERE "kind" = 'user');--> statement-breakpoint
DELETE FROM "page_events" WHERE "page_id" IN (SELECT "id" FROM "pages" WHERE "kind" = 'user');--> statement-breakpoint
DELETE FROM "page_current" WHERE "page_id" IN (SELECT "id" FROM "pages" WHERE "kind" = 'user');--> statement-breakpoint
DELETE FROM "page_revisions" WHERE "page_id" IN (SELECT "id" FROM "pages" WHERE "kind" = 'user');--> statement-breakpoint
DELETE FROM "page_refs" WHERE "page_id" IN (SELECT "id" FROM "pages" WHERE "kind" = 'user');--> statement-breakpoint
DELETE FROM "page_objects" WHERE "page_id" IN (SELECT "id" FROM "pages" WHERE "kind" = 'user');

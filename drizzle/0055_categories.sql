-- Topics are called categories now, as on Wikipedia: the kind, its identifiers (`category:<slug>`) and the label that
-- puts a page in one (`in-category`). The page repos say the same after `npm run pages:migrate-categories`.
ALTER TABLE "pages" DROP CONSTRAINT "pages_kind_check";--> statement-breakpoint
UPDATE "pages" SET "kind" = 'category' WHERE "kind" = 'topic';--> statement-breakpoint
UPDATE "page_redirects" SET "kind" = 'category' WHERE "kind" = 'topic';--> statement-breakpoint
UPDATE "bot_grants" SET "kind" = 'category' WHERE "kind" = 'topic';--> statement-breakpoint
UPDATE "page_links" SET "target_kind" = 'category', "target" = 'category:' || substr("target", 7) WHERE "target_kind" = 'topic';--> statement-breakpoint
UPDATE "page_links" SET "label" = 'in-category' WHERE "label" = 'in-topic';--> statement-breakpoint
UPDATE "page_members" SET "via" = 'in-category' WHERE "via" = 'in-topic';--> statement-breakpoint
UPDATE "page_member_sources" SET "via" = 'in-category' WHERE "via" = 'in-topic';--> statement-breakpoint
UPDATE "page_member_sources" SET "source" = 'category:' || substr("source", 7) WHERE "source" LIKE 'topic:%';--> statement-breakpoint
UPDATE "page_scope_names" SET "name" = 'category:' || substr("name", 7) WHERE "name" LIKE 'topic:%';--> statement-breakpoint
DELETE FROM "page_parents" WHERE "parent" LIKE 'topic:%';--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_kind_check" CHECK (kind in ('paper', 'venue', 'category', 'org', 'user'));

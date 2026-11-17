CREATE TABLE "page_redirects" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"page_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "page_redirects_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
ALTER TABLE "page_redirects" ADD CONSTRAINT "page_redirects_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_redirects_page_idx" ON "page_redirects" USING btree ("page_id");--> statement-breakpoint
-- User pages (handoffs/pages.md, Phase 3): every account has a page at /u/<handle>, keyed by its handle, made and
-- moved with the account by triggers, so whatever writes an account (sign-up, onboarding, scripts) leaves one.
-- Existing accounts get theirs here; `npm run users:pages` starts their repos.
INSERT INTO "pages" ("kind", "key") SELECT 'user', "handle" FROM "accounts" ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE FUNCTION accounts_page_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Whoever takes a handle takes its address: an old redirect from it gives way.
	DELETE FROM page_redirects WHERE kind = 'user' AND key = NEW.handle;
	INSERT INTO pages (kind, key) VALUES ('user', NEW.handle) ON CONFLICT DO NOTHING;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION accounts_page_rename() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	moved uuid;
BEGIN
	IF NEW.handle = OLD.handle THEN
		RETURN NEW;
	END IF;
	DELETE FROM page_redirects WHERE kind = 'user' AND key = NEW.handle;
	UPDATE pages SET key = NEW.handle WHERE kind = 'user' AND key = OLD.handle RETURNING id INTO moved;
	IF moved IS NULL THEN
		INSERT INTO pages (kind, key) VALUES ('user', NEW.handle) RETURNING id INTO moved;
	END IF;
	INSERT INTO page_redirects (kind, key, page_id) VALUES ('user', OLD.handle, moved)
		ON CONFLICT (kind, key) DO UPDATE SET page_id = EXCLUDED.page_id, created_at = clock_timestamp();
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION accounts_page_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM pages WHERE kind = 'user' AND key = OLD.handle;
	RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER accounts_page_insert AFTER INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_page_insert();--> statement-breakpoint
CREATE TRIGGER accounts_page_rename AFTER UPDATE OF handle ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_page_rename();--> statement-breakpoint
CREATE TRIGGER accounts_page_delete AFTER DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_page_delete();

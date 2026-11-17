CREATE TABLE "org_members_due" (
	"paper_id" uuid PRIMARY KEY NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_member_sources" ADD COLUMN "weight" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Organisation pages (handoffs/pages.md Phase 4). A paper is from an org through the confirmed author claims of verified
-- members who show their institution, and through the addresses printed on its page 1; both are names of the form
-- `domain:<domain>` in page_member_sources, one per domain from the address's up to two labels (`inf.ethz.ch`,
-- `ethz.ch`), which an org page answers to through its org.json `domains` (server/page-members.ts).
CREATE FUNCTION domain_suffixes(domain text) RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $$
	SELECT array_to_string(d.labels[i:], '.')
	  FROM (SELECT string_to_array(lower(domain), '.') AS labels) d,
	       generate_series(1, cardinality(d.labels) - 1) i
$$;--> statement-breakpoint
CREATE INDEX "page_current_pdf_sha256_idx" ON "page_current" ((pdf ->> 'sha256')) WHERE pdf IS NOT NULL;--> statement-breakpoint
-- What a paper's affiliation sources come from lives outside its repo, so its changes mark the paper as due again;
-- the worker's `org-members` task empties the queue (server/page-members.ts).
CREATE FUNCTION org_members_due_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP <> 'INSERT' AND OLD.status = 'confirmed' THEN
		INSERT INTO org_members_due (paper_id) VALUES (OLD.paper_id) ON CONFLICT DO NOTHING;
	END IF;
	IF TG_OP <> 'DELETE' AND NEW.status = 'confirmed' THEN
		INSERT INTO org_members_due (paper_id) VALUES (NEW.paper_id) ON CONFLICT DO NOTHING;
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER author_claims_org_members AFTER INSERT OR DELETE OR UPDATE OF status, paper_id, account_id ON author_claims FOR EACH ROW EXECUTE FUNCTION org_members_due_claim();--> statement-breakpoint
CREATE FUNCTION org_members_due_account(account uuid) RETURNS void LANGUAGE sql AS $$
	INSERT INTO org_members_due (paper_id)
	SELECT DISTINCT paper_id FROM author_claims WHERE account_id = account AND status = 'confirmed'
	ON CONFLICT DO NOTHING
$$;--> statement-breakpoint
CREATE FUNCTION org_members_due_affiliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP <> 'INSERT' AND OLD.verified_at IS NOT NULL THEN
		PERFORM org_members_due_account(OLD.account_id);
	END IF;
	IF TG_OP <> 'DELETE' AND NEW.verified_at IS NOT NULL THEN
		PERFORM org_members_due_account(NEW.account_id);
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER affiliations_org_members AFTER INSERT OR DELETE OR UPDATE OF verified_at, email, account_id ON affiliations FOR EACH ROW EXECUTE FUNCTION org_members_due_affiliation();--> statement-breakpoint
CREATE FUNCTION org_members_due_shown() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM org_members_due_account(NEW.id);
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER accounts_org_members AFTER UPDATE OF show_institution, verified_at, is_bot ON accounts FOR EACH ROW
	WHEN (OLD.show_institution IS DISTINCT FROM NEW.show_institution
	      OR (OLD.verified_at IS NULL) IS DISTINCT FROM (NEW.verified_at IS NULL)
	      OR OLD.is_bot IS DISTINCT FROM NEW.is_bot)
	EXECUTE FUNCTION org_members_due_shown();--> statement-breakpoint
CREATE FUNCTION org_members_due_pdf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO org_members_due (paper_id)
	SELECT page_id FROM page_current WHERE pdf ->> 'sha256' = NEW.sha256
	ON CONFLICT DO NOTHING;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER pdf_documents_org_members_insert AFTER INSERT ON pdf_documents FOR EACH ROW
	WHEN (cardinality(NEW.emails) > 0) EXECUTE FUNCTION org_members_due_pdf();--> statement-breakpoint
CREATE TRIGGER pdf_documents_org_members_update AFTER UPDATE OF emails ON pdf_documents FOR EACH ROW
	WHEN (OLD.emails IS DISTINCT FROM NEW.emails) EXECUTE FUNCTION org_members_due_pdf();--> statement-breakpoint
-- The `orgs` bot makes org pages from the institution allowlist and writes their org.json.
INSERT INTO "accounts" ("handle", "is_bot", "verified_at", "profile_completed_at") VALUES ('orgs', true, now(), now()) ON CONFLICT ("handle") DO NOTHING;--> statement-breakpoint
INSERT INTO "bot_grants" ("account_id", "kind", "pattern", "shown", "granted_by") SELECT "id", 'org', 'org.json', true, 'system' FROM "accounts" WHERE "handle" = 'orgs' AND "is_bot" ON CONFLICT DO NOTHING;

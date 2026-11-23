ALTER TABLE "accounts" ADD COLUMN "rate_limit_per_second" double precision;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "rate_limit_burst" integer;

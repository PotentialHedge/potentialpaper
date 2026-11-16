CREATE UNIQUE INDEX "agent_codes_code_hash_idx" ON "agent_codes" USING btree ("code_hash");--> statement-breakpoint
ALTER TABLE "agent_codes" DROP COLUMN "attempts";
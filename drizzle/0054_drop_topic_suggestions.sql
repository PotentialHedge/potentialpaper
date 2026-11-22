-- Topics work as Wikipedia's categories do now: nothing suggests papers for them.
DROP TABLE "topic_suggestions" CASCADE;--> statement-breakpoint
DELETE FROM "consumer_cursors" WHERE "name" = 'topic-suggestions';

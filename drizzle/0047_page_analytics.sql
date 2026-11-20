CREATE TABLE "page_daily_counts" (
	"page_id" uuid NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "page_daily_counts_page_id_day_metric_pk" PRIMARY KEY("page_id","day","metric")
);
--> statement-breakpoint
CREATE TABLE "page_institution_counts" (
	"page_id" uuid NOT NULL,
	"month" date NOT NULL,
	"institution" text NOT NULL,
	"visitors" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "page_institution_counts_page_id_month_institution_pk" PRIMARY KEY("page_id","month","institution")
);
--> statement-breakpoint
CREATE TABLE "page_month_visitors" (
	"month" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "page_month_visitors_month_visitor_pk" PRIMARY KEY("month","visitor")
);

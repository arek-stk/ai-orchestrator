CREATE TABLE "health_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"health_score" real,
	"previous_score" real,
	"breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb,
	"proposals_created" integer DEFAULT 0 NOT NULL,
	"proposals_seen" integer DEFAULT 0 NOT NULL,
	"auto_accepted" integer DEFAULT 0 NOT NULL,
	"agent_status" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"summary" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "improvement_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scan_id" text,
	"fingerprint" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impact" text NOT NULL,
	"effort" text NOT NULL,
	"risk" text NOT NULL,
	"roi_score" real NOT NULL,
	"priority" integer NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"task_id" text,
	"auto_accepted" boolean DEFAULT false NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"dismiss_reason" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cache_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_entries" ADD COLUMN "hits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "cache_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "saved_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "health_scans" ADD CONSTRAINT "health_scans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_proposals" ADD CONSTRAINT "improvement_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_proposals" ADD CONSTRAINT "improvement_proposals_scan_id_health_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."health_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_proposals" ADD CONSTRAINT "improvement_proposals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_scans_project_created_idx" ON "health_scans" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "health_scans_status_idx" ON "health_scans" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "improvement_proposals_project_fingerprint_uq" ON "improvement_proposals" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "improvement_proposals_project_status_idx" ON "improvement_proposals" USING btree ("project_id","status","priority");
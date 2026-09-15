CREATE TABLE "autopilot_session_projects" (
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopilot_session_projects_session_id_project_id_pk" PRIMARY KEY("session_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "autopilot_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"started_by" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"project_ids" jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"budget_usd" double precision NOT NULL,
	"autonomy_ceiling" integer NOT NULL,
	"max_task_risk" text NOT NULL,
	"max_concurrent_runs" integer,
	"max_parked_runs" integer DEFAULT 3 NOT NULL,
	"quiet_hours" jsonb,
	"stop_policy" jsonb NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"stop_reason" text,
	"stop_detail" text,
	"stopped_by" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "mode" text DEFAULT 'blocking' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "autopilot_session_projects" ADD CONSTRAINT "autopilot_session_projects_session_id_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."autopilot_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_session_projects" ADD CONSTRAINT "autopilot_session_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_session_projects_active_uq" ON "autopilot_session_projects" USING btree ("project_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "autopilot_sessions_status_idx" ON "autopilot_sessions" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_session_id_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."autopilot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_session_id_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."autopilot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_session_idx" ON "approvals" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "runs_session_idx" ON "pipeline_runs" USING btree ("session_id");
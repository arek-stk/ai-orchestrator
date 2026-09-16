CREATE TABLE "council_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text,
	"run_id" text,
	"decision_type" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"question" text NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diversity" text,
	"status" text DEFAULT 'running' NOT NULL,
	"chosen_option_id" text,
	"confidence" real,
	"park_reason" text,
	"rounds_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "council_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"council_id" text NOT NULL,
	"seq" integer NOT NULL,
	"round" integer NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"stance" text NOT NULL,
	"body" jsonb NOT NULL,
	"model_id" text,
	"provider" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text,
	"task_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"nature" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"rung" text,
	"trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" jsonb,
	"park_reason" text,
	"advisory" jsonb,
	"decision_id" text,
	"approval_id" text,
	"council_id" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "origin" text DEFAULT 'pipeline' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "council_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "adr_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "review_comment" text;--> statement-breakpoint
ALTER TABLE "council_sessions" ADD CONSTRAINT "council_sessions_request_id_decision_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."decision_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_sessions" ADD CONSTRAINT "council_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_sessions" ADD CONSTRAINT "council_sessions_session_id_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."autopilot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_sessions" ADD CONSTRAINT "council_sessions_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_turns" ADD CONSTRAINT "council_turns_council_id_council_sessions_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_session_id_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."autopilot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "council_sessions_request_idx" ON "council_sessions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "council_sessions_session_idx" ON "council_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "council_turns_council_seq_uq" ON "council_turns" USING btree ("council_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_requests_open_fingerprint_uq" ON "decision_requests" USING btree ("project_id","fingerprint") WHERE status in ('open', 'resolving');--> statement-breakpoint
CREATE INDEX "decision_requests_session_idx" ON "decision_requests" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_requests_project_status_idx" ON "decision_requests" USING btree ("project_id","status");--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_session_id_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."autopilot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_session_idx" ON "decisions" USING btree ("session_id");
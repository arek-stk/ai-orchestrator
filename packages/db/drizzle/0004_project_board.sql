CREATE TABLE "leases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"holder_type" text NOT NULL,
	"holder_id" text NOT NULL,
	"holder_name" text NOT NULL,
	"scope" text NOT NULL,
	"task_id" text,
	"path_globs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" text,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"start_date" date,
	"due_date" date,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_type" text DEFAULT 'orchestrator' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "milestone_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "board_position" double precision;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimate_points" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "labels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduling_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leases_project_active_idx" ON "leases" USING btree ("project_id","expires_at") WHERE released_at is null;--> statement-breakpoint
CREATE INDEX "leases_task_idx" ON "leases" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "milestones_project_position_idx" ON "milestones" USING btree ("project_id","position");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_milestone_idx" ON "tasks" USING btree ("milestone_id");
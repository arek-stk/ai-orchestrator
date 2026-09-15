CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"conversation_id" text NOT NULL,
	"project_id" text,
	"thread_id" text,
	"author_type" text NOT NULL,
	"author_id" text,
	"author_name" text NOT NULL,
	"intent" text DEFAULT 'message' NOT NULL,
	"body" text NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_thread_id_conversation_messages_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_seq_uq" ON "conversation_messages" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "conversation_messages_top_level_idx" ON "conversation_messages" USING btree ("conversation_id","seq") WHERE thread_id is null;--> statement-breakpoint
CREATE INDEX "conversation_messages_thread_idx" ON "conversation_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "conversation_messages_project_created_idx" ON "conversation_messages" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_dedupe_uq" ON "conversation_messages" USING btree ("conversation_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_project_room_uq" ON "conversations" USING btree ("project_id") WHERE kind = 'room';--> statement-breakpoint
CREATE INDEX "conversations_project_kind_activity_idx" ON "conversations" USING btree ("project_id","kind","last_activity_at");
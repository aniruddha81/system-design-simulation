CREATE TABLE "api_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer NOT NULL,
	"bytes" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"message" varchar(500) NOT NULL,
	"stack" varchar(4096),
	"url" text NOT NULL,
	"user_agent" varchar(200),
	"release" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_errors" ADD CONSTRAINT "client_errors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_rate_limit_window" ON "api_rate_limit" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "client_errors_created" ON "client_errors" USING btree ("created_at");
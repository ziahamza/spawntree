CREATE TABLE `clones` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`path` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` text NOT NULL,
	`registered_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clones_path_unique` ON `clones` (`path`);--> statement-breakpoint
CREATE INDEX `clones_repo_id_idx` ON `clones` (`repo_id`);--> statement-breakpoint
CREATE TABLE `registered_repos` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`repo_path` text NOT NULL,
	`config_path` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`remote_url` text DEFAULT '' NOT NULL,
	`default_branch` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`registered_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_slug_unique` ON `repos` (`slug`);--> statement-breakpoint
CREATE TABLE `session_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`tool_name` text NOT NULL,
	`tool_kind` text NOT NULL,
	`status` text NOT NULL,
	`arguments` text NOT NULL,
	`result` text NOT NULL,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_tool_calls_session_id_idx` ON `session_tool_calls` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_tool_calls_turn_id_idx` ON `session_tool_calls` (`turn_id`);--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model_id` text,
	`duration_ms` integer,
	`stop_reason` text,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_turns_session_id_idx` ON `session_turns` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_turns_session_turn_idx` ON `session_turns` (`session_id`,`turn_index`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`working_directory` text NOT NULL,
	`git_branch` text,
	`git_head_commit` text,
	`git_remote_url` text,
	`total_turns` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_provider_idx` ON `sessions` (`provider`);--> statement-breakpoint
CREATE INDEX `sessions_updated_at_idx` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `watched_paths` (
	`path` text PRIMARY KEY NOT NULL,
	`scan_children` integer DEFAULT 0 NOT NULL,
	`added_at` text NOT NULL,
	`last_scanned_at` text DEFAULT '' NOT NULL,
	`last_scan_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`path` text PRIMARY KEY NOT NULL,
	`clone_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`head_ref` text DEFAULT '' NOT NULL,
	`discovered_at` text NOT NULL,
	FOREIGN KEY (`clone_id`) REFERENCES `clones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `worktrees_clone_id_idx` ON `worktrees` (`clone_id`);
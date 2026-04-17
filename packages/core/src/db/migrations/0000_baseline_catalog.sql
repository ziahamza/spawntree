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
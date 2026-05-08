CREATE TABLE `picked_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`picked_at` text NOT NULL,
	`last_scanned_at` text,
	`scan_error` text
);
--> statement-breakpoint
ALTER TABLE `clones` ADD `picked_folder_id` text;--> statement-breakpoint
ALTER TABLE `clones` ADD `relative_path` text;
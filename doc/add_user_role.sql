-- Migration to add role column to users table
ALTER TABLE `users` ADD COLUMN `role` ENUM('user', 'premium', 'admin') NOT NULL DEFAULT 'user';

-- Optional: Set an initial admin (replace 'admin_username' with actual username if known)
-- UPDATE `users` SET `role` = 'admin' WHERE `username` = 'admin_username';

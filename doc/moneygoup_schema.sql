--
-- Corrected DDL for user_stock_predictions
-- Fixed incompatible foreign key type (changed user_id from VARCHAR to INT)
-- This table tracks one updatable row per (user_id, stock_id).
--

DROP TABLE IF EXISTS `user_stock_predictions`;
CREATE TABLE `user_stock_predictions` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` int NOT NULL,
  `stock_id` int NOT NULL,
  `predicted_price_1m` decimal(12,4) NOT NULL,
  `last_requested_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_user_stock_prediction` (`user_id`, `stock_id`),
  KEY `idx_last_requested` (`last_requested_at`),
  CONSTRAINT `fk_usp_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_usp_stock` FOREIGN KEY (`stock_id`) REFERENCES `stocks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

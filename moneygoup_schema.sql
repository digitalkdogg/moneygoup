-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: moneygoup
-- ------------------------------------------------------
-- Server version	8.0.44-0ubuntu0.24.04.2

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `news`
--

DROP TABLE IF EXISTS `news`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `news` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(512) NOT NULL,
  `link` varchar(1024) NOT NULL,
  `pub_date` datetime DEFAULT NULL,
  `source` varchar(255) DEFAULT NULL,
  `sentiment_score` decimal(5,2) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `link` (`link`)
) ENGINE=InnoDB AUTO_INCREMENT=170 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `news`
--

LOCK TABLES `news` WRITE;
/*!40000 ALTER TABLE `news` DISABLE KEYS */;
INSERT INTO `news` VALUES (13,'Walmart Inc. (S: WMT) reports strong earnings, stock soars!','http://example.com/news/WMT/0','2026-01-20 16:57:27','MockNewsProvider',0.54,'2026-01-20 22:57:27'),(14,'Analysts downgrade Walmart Inc. (S: WMT) amid market uncertainty.','http://example.com/news/WMT/1','2026-01-19 16:57:27','MockNewsProvider',0.00,'2026-01-20 22:57:27'),(15,'Walmart Inc. (S: WMT) unveils new product line.','http://example.com/news/WMT/2','2026-01-18 16:57:27','MockNewsProvider',0.14,'2026-01-20 22:57:27'),(16,'Major partnership announced for Walmart Inc. (S: WMT).','http://example.com/news/WMT/3','2026-01-17 16:57:27','MockNewsProvider',0.06,'2026-01-20 22:57:27'),(17,'Walmart Inc. (S: WMT) faces regulatory challenges.','http://example.com/news/WMT/4','2026-01-16 16:57:27','MockNewsProvider',0.00,'2026-01-20 22:57:27'),(18,'Stock split for Walmart Inc. (S: WMT) expected next quarter.','http://example.com/news/WMT/5','2026-01-15 16:57:27','MockNewsProvider',-0.05,'2026-01-20 22:57:27'),(19,'CIENA CORP (S: CIEN) reports strong earnings, stock soars!','http://example.com/news/CIEN/0','2026-01-20 16:57:27','MockNewsProvider',0.54,'2026-01-20 22:57:27'),(20,'Analysts downgrade CIENA CORP (S: CIEN) amid market uncertainty.','http://example.com/news/CIEN/1','2026-01-19 16:57:27','MockNewsProvider',0.00,'2026-01-20 22:57:27'),(21,'CIENA CORP (S: CIEN) unveils new product line.','http://example.com/news/CIEN/2','2026-01-18 16:57:27','MockNewsProvider',0.14,'2026-01-20 22:57:27'),(22,'Major partnership announced for CIENA CORP (S: CIEN).','http://example.com/news/CIEN/3','2026-01-17 16:57:27','MockNewsProvider',0.06,'2026-01-20 22:57:27'),(23,'CIENA CORP (S: CIEN) faces regulatory challenges.','http://example.com/news/CIEN/4','2026-01-16 16:57:27','MockNewsProvider',0.00,'2026-01-20 22:57:27'),(24,'Stock split for CIENA CORP (S: CIEN) expected next quarter.','http://example.com/news/CIEN/5','2026-01-15 16:57:27','MockNewsProvider',-0.05,'2026-01-20 22:57:27'),(25,'V... [truncated]
/*!40000 ALTER TABLE `news` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `stocks`
--

DROP TABLE IF EXISTS `stocks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `stocks` (
  `id` int NOT NULL AUTO_INCREMENT,
  `symbol` varchar(10) NOT NULL,
  `company_name` varchar(255) NOT NULL,
  `price` decimal(10,2) DEFAULT NULL,
  `pe_ratio` decimal(10,2) DEFAULT NULL,
  `pb_ratio` decimal(10,2) DEFAULT NULL,
  `market_cap` bigint DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `symbol` (`symbol`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `stocks`
--

LOCK TABLES `stocks` WRITE;
/*!40000 ALTER TABLE `stocks` DISABLE KEYS */;
INSERT INTO `stocks` VALUES (4,'WMT','Walmart Inc.',118.71,25.00,5.00,400000000000,'2026-01-17 21:16:09'),(5,'CIEN','CIENA CORP',241.21,30.00,6.00,50000000000,'2026-01-17 21:16:19'),(6,'VALE','Vale S.A.',14.93,10.00,1.50,80000000000,'2026-01-17 21:16:28'),(7,'ASTS','AST SpaceMobile, Inc.',112.44,15.00,2.50,1500000000,'2026-01-18 02:50:27');
/*!40000 ALTER TABLE `stocks` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `stocksdailyprice`
--

DROP TABLE IF EXISTS `stocksdailyprice`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `stocksdailyprice` (
  `id` int NOT NULL AUTO_INCREMENT,
  `stock_id` int NOT NULL,
  `date` date NOT NULL,
  `open` decimal(10,2) NOT NULL,
  `high` decimal(10,2) NOT NULL,
  `low` decimal(10,2) NOT NULL,
  `close` decimal(10,2) NOT NULL,
  `volume` int NOT NULL,
  `adj_open` decimal(10,2) DEFAULT NULL,
  `adj_high` decimal(10,2) DEFAULT NULL,
  `adj_low` decimal(10,2) DEFAULT NULL,
  `adj_close` decimal(10,2) DEFAULT NULL,
  `adj_volume` int DEFAULT NULL,
  `daily_change` decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `stock_id` (`stock_id`,`date`),
  CONSTRAINT `stocksdailyprice_ibfk_1` FOREIGN KEY (`stock_id`) REFERENCES `stocks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4271 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `stocksdailyprice`
--

LOCK TABLES `stocksdailyprice` WRITE;
/*!40000 ALTER TABLE `stocksdailyprice` DISABLE KEYS */;
INSERT INTO `stocksdailyprice` VALUES (514,4,'2025-01-17',92.07,92.26,91.05,91.94,15868213,91.20,91.39,90.19,91.07,15868213,NULL),(515,4,'2025-01-21',92.48,94.24,92.31,93.08,23247451,91.60,93.35,91.44,92.20,23247451,NULL),(516,4,'2025-01-22',93.77,94.00,92.52,93.23,15567057,92.88,93.11,91.64,92.35,15567057,NULL),(517,4,'2025-01-23',92.96,93.81,92.32,93.81,14198438,92.08,92.92,91.45,92.92,14198438,NULL),(518,4,'2025-01-24',93.54,95.01,93.46,94.76,14973773,92.65,94.11,92.57,93.86,14973773,NULL),(519,4,'2025-01-27',95.90,97.46,94.82,97.40,18880614,94.99,96.54,93.92,96.48,18880614,NULL),(520,4,'2025-01-28',97.23,97.84,96.73,97.29,14641621,96.31,96.91,95.81,96.37,14641621,NULL),(521,4,'2025-01-29',97.43,98.17,97.22,97.50,11261444,96.50,97.24,96.30,96.58,11261444,NULL),(522,4,'2025-01-30',97.69,98.93,97.42,98.65,11012220,96.76,97.99,96.50,97.72,11012220,NULL),(523,4,'2025-01-31',99.00,99.00,97.70,98.16,16413893,98.06,98.06,96.77,97.23,16413893,NULL),(524,4,'2025-02-03',96.77,99.79,96.47,99.54,20484152,95.85,98.84,95.56,98.60,20484152,NULL),(525,4,'2025-02-04',99.97,100.95,99.69,100.77,15201194,99.02,99.99,98.75,99.82,15201194,NULL),(526,4,'2025-02-05',100.65,102.58,100.54,102.46,15926717,99.70,101.61,99.59,101.49,15926717,NULL),(527,4,'2025-02-06',102.53,103.02,101.94,102.85,13088467,101.56,102.04,100.97,101.88,13088467,NULL),(528,4,'2025-02-07',103.00,103.11,101.11,101.15,12451072,102.02,102.13,100.15,100.19,12451072,NULL),(529,4,'2025-02-10',101.95,102.93,101.25,102.92,15274644,100.98,101.96,100.29,101.95,15274644,NULL),(530,4,'2025-02-11',102.62,102.85,101.85,102.47,11953632,101.65,101.88,100.89,101.50,11953632,NULL),(531,4,'2025-02-12',102.12,103.90,102.04,103.61,15162125,101.15,102.92,101.07,102.63,15162125,NULL),(532,4,'2025-02-13',104.00,105.24,103.53,105.05,12604413,103.02,104.24,102.55,104.06,12604413,NULL),(533,4,'2025-02-14',105.30,105.30,103.60,104.04,14109460,104.30,104.30,102.62,103.05,14109460,NULL),(534,4,'2025-02-18',103.72,103.99,102.51,103.78,18247314,1... [truncated]
/*!40000 ALTER TABLE `stocksdailyprice` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `user_stock_news`
--

DROP TABLE IF EXISTS `user_stock_news`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_stock_news` (
  `user_id` int NOT NULL,
  `stock_id` int NOT NULL,
  `news_id` int NOT NULL,
  PRIMARY KEY (`user_id`,`stock_id`,`news_id`),
  KEY `news_id` (`news_id`),
  CONSTRAINT `user_stock_news_ibfk_1` FOREIGN KEY (`user_id`, `stock_id`) REFERENCES `user_stocks` (`user_id`, `stock_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `user_stock_news_ibfk_2` FOREIGN KEY (`news_id`) REFERENCES `news` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `user_stock_news`
--

LOCK TABLES `user_stock_news` WRITE;
/*!40000 ALTER TABLE `user_stock_news` DISABLE KEYS */;
INSERT INTO `user_stock_news` VALUES (1,4,13),(1,4,14),(1,4,15),(1,4,16),(1,4,17),(1,4,18),(1,5,19),(1,5,20),(1,5,21),(1,5,22),(1,5,23),(1,5,24),(1,6,25),(1,6,26),(1,6,27),(1,6,28),(1,6,29),(1,6,30);
/*!40000 ALTER TABLE `user_stock_news` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `user_stocks`
--

DROP TABLE IF EXISTS `user_stocks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_stocks` (
  `user_id` int NOT NULL,
  `stock_id` int NOT NULL,
  `shares` decimal(10,4) NOT NULL DEFAULT '0.0000',
  `purchase_price` decimal(10,2) NOT NULL DEFAULT '0.00',
  `is_purchased` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`user_id`,`stock_id`),
  KEY `stock_id` (`stock_id`),
  CONSTRAINT `user_stocks_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `user_stocks_ibfk_2` FOREIGN KEY (`stock_id`) REFERENCES `stocks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `user_stocks`
--

LOCK TABLES `user_stocks` WRITE;
/*!40000 ALTER TABLE `user_stocks` DISABLE KEYS */;
INSERT INTO `user_stocks` VALUES (1,4,4098.3820,119.70,1),(1,5,7.0000,243.42,1),(1,6,49.4000,14.61,1);
/*!40000 ALTER TABLE `user_stocks` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'testuser','password123','2026-01-17 20:12:31');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-01-20 17:28:42
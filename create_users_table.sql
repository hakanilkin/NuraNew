-- ================================================================
-- Nura Dashboard — Users Table
-- Run this script once in your SQL Server database
-- ================================================================

CREATE TABLE Users (
  UserID        INT            IDENTITY(1,1) PRIMARY KEY,
  Username      NVARCHAR(100)  NOT NULL,
  Email         NVARCHAR(200)  NULL,
  FullName      NVARCHAR(200)  NULL,
  PasswordHash  NVARCHAR(255)  NOT NULL,
  TOTPSecret    NVARCHAR(255)  NULL,          -- null until MFA is enrolled
  TOTPEnabled   BIT            NOT NULL DEFAULT 0,
  IsAdmin       BIT            NOT NULL DEFAULT 0,
  IsActive      BIT            NOT NULL DEFAULT 1,
  MustChangePwd BIT            NOT NULL DEFAULT 1,  -- force reset on first login
  CreatedAt     DATETIME       NOT NULL DEFAULT GETDATE(),
  LastLogin     DATETIME       NULL,
  CONSTRAINT UQ_Users_Username UNIQUE (Username)
);

-- ----------------------------------------------------------------
-- Seed: first admin user
--
-- 1. Generate a bcrypt hash for a strong, unique password:
--      node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 10))"
-- 2. Replace REPLACE_WITH_BCRYPT_HASH below before running.
--
-- MustChangePwd = 1 forces a password change on first login.
-- Do NOT commit real password hashes to source control.
-- ----------------------------------------------------------------
INSERT INTO Users (Username, Email, FullName, PasswordHash, IsAdmin, MustChangePwd)
VALUES (
  'admin',
  'admin@hospital.org',
  'System Administrator',
  'REPLACE_WITH_BCRYPT_HASH',
  1,
  1
);

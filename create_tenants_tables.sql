-- ================================================================
-- Nura — Multi-Tenant Tables (run in NuraOps database)
-- ================================================================

CREATE TABLE Tenants (
  TenantID   INT            IDENTITY(1,1) PRIMARY KEY,
  TenantName NVARCHAR(100)  NOT NULL,
  DBServer   NVARCHAR(200)  NOT NULL,
  DBName     NVARCHAR(100)  NOT NULL,
  DBUser     NVARCHAR(200)  NOT NULL,
  DBPassword NVARCHAR(200)  NOT NULL,
  IsActive   BIT            NOT NULL DEFAULT 1,
  CreatedAt  DATETIME       NOT NULL DEFAULT GETDATE()
);

CREATE TABLE UserTenants (
  UserID   INT NOT NULL,
  TenantID INT NOT NULL,
  PRIMARY KEY (UserID, TenantID),
  FOREIGN KEY (UserID)   REFERENCES Users(UserID)     ON DELETE CASCADE,
  FOREIGN KEY (TenantID) REFERENCES Tenants(TenantID) ON DELETE CASCADE
);

-- ----------------------------------------------------------------
-- Seed: existing clients
-- Update DBUser / DBPassword to match your Azure SQL credentials
--
-- NOTE: the NHS tenant's DBName is still 'Virtua' — the client was renamed
-- but the underlying Azure SQL database was not.  TenantName drives the UI
-- label and the public/data/<name> Atlas folder; DBName drives the connection.
-- ----------------------------------------------------------------
INSERT INTO Tenants (TenantName, DBServer, DBName, DBUser, DBPassword)
VALUES
  ('NHS', 'brighthospital.database.windows.net', 'Virtua', 'hakantest@brighthospital', 'YOUR_PASSWORD'),
  ('OHS', 'brighthospital.database.windows.net', 'OHS',    'hakantest@brighthospital', 'YOUR_PASSWORD');

-- ----------------------------------------------------------------
-- Assign admin user to all tenants (run after seeding)
-- ----------------------------------------------------------------
INSERT INTO UserTenants (UserID, TenantID)
SELECT u.UserID, t.TenantID
FROM Users u CROSS JOIN Tenants t
WHERE u.Username = 'admin';

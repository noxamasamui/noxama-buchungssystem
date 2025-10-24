-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Reservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "startTs" DATETIME NOT NULL,
    "endTs" DATETIME NOT NULL,
    "firstName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "guests" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "cancelToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isWalkIn" BOOLEAN NOT NULL DEFAULT false,
    "reminderSent" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_Reservation" ("cancelToken", "createdAt", "date", "email", "endTs", "firstName", "guests", "id", "isWalkIn", "name", "notes", "phone", "startTs", "status", "time") SELECT "cancelToken", "createdAt", "date", "email", "endTs", "firstName", "guests", "id", "isWalkIn", "name", "notes", "phone", "startTs", "status", "time" FROM "Reservation";
DROP TABLE "Reservation";
ALTER TABLE "new_Reservation" RENAME TO "Reservation";
CREATE UNIQUE INDEX "Reservation_cancelToken_key" ON "Reservation"("cancelToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
